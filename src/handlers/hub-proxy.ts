/**
 * /api/hub/* — proxy browser requests to Hubitat's Maker API.
 *
 * The browser calls e.g. GET /api/hub/devices/all
 * We rewrite to:
 *   Cloud:  {baseUrl}/apps/{appId}/devices/all?access_token={token}
 *   LAN:    {baseUrl}/apps/api/{appId}/devices/all?access_token={token}
 *
 * Credential resolution order (most-to-least preferred):
 *   1. X-Hub-Token / X-Hub-Base-Url / X-Hub-App-Id request headers
 *      → "hybrid" or "full browser" mode: token lives in browser localStorage,
 *        sent per-request over HTTPS, never stored server-side.
 *   2. KV {hubId}:hub-connection
 *      → "full KV" mode (legacy): token stored server-side in KV.
 *
 * Hub ID validation runs on every request (single-hub enforcement / CF Access
 * check for multi-hub) via resolveHubId() from config.ts.
 *
 * WebSocket proxy: GET /api/hub/events with Upgrade: websocket header
 *   Hub ID is passed as ?hubId= query param (browser WebSocket API cannot set
 *   custom headers on the upgrade request).
 *   Proxies to ws://{hub}/eventsocket (LAN/tunnel only; cloud falls back to
 *   polling — the cloud API does not expose a WebSocket event stream).
 *
 * CF Access on the tunnel: set CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET
 *   Worker secrets. The Worker uses fetch()+Upgrade header (not new WebSocket())
 *   to inject the service token on outbound connections.
 */

import { loadHubConnection, resolveHubId } from './config';
import type { Env, HubConnection } from '../types';

export async function handleHubProxy(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  // WebSocket upgrade: hub ID passed as ?hubId= since WS can't send custom headers
  if (
    url.pathname === '/api/hub/events' &&
    req.headers.get('Upgrade')?.toLowerCase() === 'websocket'
  ) {
    return handleWebSocketProxy(req, env);
  }

  // Validate hub ID (single-hub enforcement and CF Access check in multi-hub mode)
  const hubResult = await resolveHubId(req, env);
  if (hubResult instanceof Response) return hubResult;
  const { hubId } = hubResult;

  // Credentials: browser headers first (browser/hybrid mode), then KV fallback
  const hub = resolveHubConnection(req) ?? await loadHubConnection(env, hubId);

  if (!hub.baseUrl || !hub.appId || !hub.token) {
    return jsonError(
      'Hub connection not configured. Open dashboard settings and enter your hub credentials.',
      503,
    );
  }

  const subPath = url.pathname.replace(/^\/api\/hub/, '');
  if (!subPath) return jsonError('Empty hub path', 400);

  let target: string;
  try {
    target = buildHubUrl(hub, subPath, url.searchParams);
  } catch (err) {
    return jsonError(
      `Invalid hub base URL "${hub.baseUrl}" — must start with https:// or http://. Check Settings. (${err instanceof Error ? err.message : String(err)})`,
      400,
    );
  }

  const upstreamHeaders = filterRequestHeaders(req.headers);
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    upstreamHeaders.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID);
    upstreamHeaders.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET);
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: upstreamHeaders,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
    });
  } catch (err) {
    return jsonError(
      `Hub unreachable: ${err instanceof Error ? err.message : String(err)}. Target: ${target}`,
      502,
    );
  }

  const respHeaders = new Headers();
  const ct = upstream.headers.get('content-type');
  if (ct) respHeaders.set('content-type', ct);
  respHeaders.set('cache-control', 'no-store');

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

/**
 * Read hub credentials from request headers (browser/hybrid mode).
 * Returns null if required headers are absent so the caller falls back to KV.
 */
function resolveHubConnection(req: Request): HubConnection | null {
  const token   = req.headers.get('X-Hub-Token');
  const baseUrl = req.headers.get('X-Hub-Base-Url');
  const appId   = req.headers.get('X-Hub-App-Id');
  if (!token || !baseUrl || !appId) return null;
  const isCloudHeader = req.headers.get('X-Hub-Is-Cloud');
  const isCloud = isCloudHeader !== null
    ? isCloudHeader === '1'
    : baseUrl.includes('cloud.hubitat.com');
  return { token, baseUrl, appId, isCloud };
}

/**
 * WebSocket proxy: browser <-> Worker <-> hub eventsocket.
 *
 * Only works for LAN/tunnel hub URLs. The Hubitat Cloud API does not expose
 * a WebSocket event stream. Returns 501 for cloud URLs so the browser falls
 * back to polling.
 *
 * Hub ID is read from ?hubId= query param because the browser WebSocket API
 * cannot set custom request headers on the upgrade request.
 *
 * Hub eventsocket: ws://{hub}/eventsocket — no authentication required on LAN.
 */
async function handleWebSocketProxy(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const hubIdParam = url.searchParams.get('hubId') ?? undefined;

  const hubResult = await resolveHubId(req, env, hubIdParam);
  if (hubResult instanceof Response) return hubResult;
  const { hubId } = hubResult;

  // Base URL: KV first, then ?hubBaseUrl query param (browser-only / no-KV mode).
  // The eventsocket is unauthenticated so no token is needed here.
  const hub = await loadHubConnection(env, hubId);
  const baseUrl = hub.baseUrl || url.searchParams.get('hubBaseUrl') || '';

  if (!baseUrl) {
    return new Response(
      'Hub base URL not configured. Either save hub settings to KV or ensure hub URL is set in dashboard settings.',
      { status: 503 },
    );
  }

  const isCloud = (hub.isCloud ?? false) || baseUrl.includes('cloud.hubitat.com');
  if (isCloud) {
    return new Response(
      'WebSocket events not available for Hubitat Cloud URLs; the dashboard will use polling instead.',
      { status: 501 },
    );
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  // fetch() only accepts http/https — NOT wss/ws.
  const hubFetchUrl = `${cleanBase}/eventsocket`;

  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();

  const hasAccessCreds = !!(env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET);
  console.log(`[ws] connecting to ${hubFetchUrl} (CF Access: ${hasAccessCreds})`);

  let hubWs: WebSocket;
  try {
    // Always go through fetch()+Upgrade rather than `new WebSocket()`. Both work
    // in Workers, but only fetch() exposes the upstream HTTP response when the
    // upgrade is REFUSED — `new WebSocket()` just emits an opaque error event,
    // which surfaced to users as a bare "Hub WebSocket error" with no way to
    // tell a down hub from a tunnel sitting behind Cloudflare Access. fetch()
    // also lets us attach the CF Access service-token headers, which the
    // WebSocket constructor can't do at all.
    const headers: Record<string, string> = { 'Upgrade': 'websocket' };
    if (hasAccessCreds) {
      headers['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID!;
      headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET!;
    }
    // 'manual' so an Access login redirect is visible as a 302 instead of being
    // followed into an HTML login page that just looks like a generic failure.
    const upgradeResp = await fetch(hubFetchUrl, { headers, redirect: 'manual' });
    const ws = upgradeResp.webSocket;
    if (!ws) {
      const status = upgradeResp.status;
      // A tunnel behind CF Access answers an unauthenticated upgrade with a
      // redirect to (or a 403 from) the Access login page. That's by far the
      // most common cause of "real-time updates never work on a tunnel", so
      // name the fix instead of reporting a generic failure.
      const looksLikeAccess =
        (status === 302 || status === 301 || status === 403) ||
        !!upgradeResp.headers.get('location')?.includes('cloudflareaccess.com');
      const hint = looksLikeAccess && !hasAccessCreds
        ? ' — this looks like Cloudflare Access in front of your tunnel. Set the CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET Worker secrets (Zero Trust → Access → Service Auth → Service Tokens) and add that token as an Allow policy on the tunnel app.'
        : '';
      throw new Error(`hub refused the WebSocket upgrade (HTTP ${status})${hint}`);
    }
    ws.accept();
    hubWs = ws;
  } catch (err) {
    const msg = `Could not connect to hub: ${err instanceof Error ? err.message : String(err)}`;
    // Full detail goes to the Worker log (`wrangler tail`), which has no limit.
    console.error(`[ws] ${msg}`);
    // A WebSocket close reason is capped at 123 BYTES by the protocol. Exceeding
    // it produces an invalid frame, so the browser sees an abnormal 1006 close
    // with no reason at all instead of the explanation — worse than saying less.
    server.close(1011, truncateCloseReason(msg));
    return new Response(null, { status: 101, webSocket: client });
  }

  hubWs.addEventListener('message', (e: MessageEvent) => {
    try { server.send(e.data as string); } catch { /* server closed */ }
  });
  server.addEventListener('message', (e: MessageEvent) => {
    try { hubWs.send(e.data as string); } catch { /* hub closed */ }
  });
  hubWs.addEventListener('close', (e: CloseEvent) => {
    try { server.close(e.code, e.reason); } catch { /* already closed */ }
  });
  server.addEventListener('close', (e: CloseEvent) => {
    try { hubWs.close(e.code, e.reason); } catch { /* already closed */ }
  });
  hubWs.addEventListener('error', () => {
    try { server.close(1011, 'Hub WebSocket error'); } catch { /* already closed */ }
  });

  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Build the upstream Hubitat URL.
 *
 * Cloud Maker API:  {baseUrl}/apps/{appId}/{subPath}?access_token=...
 * LAN/Tunnel:       {baseUrl}/apps/api/{appId}/{subPath}?access_token=...
 */
function buildHubUrl(hub: HubConnection, subPath: string, extraParams: URLSearchParams): string {
  const isCloud = hub.isCloud ?? hub.baseUrl.includes('cloud.hubitat.com');
  const appPath = isCloud ? `/apps/${hub.appId}` : `/apps/api/${hub.appId}`;
  const cleanBase = hub.baseUrl.replace(/\/+$/, '');
  const cleanSub = subPath.startsWith('/') ? subPath : `/${subPath}`;

  const url = new URL(`${cleanBase}${appPath}${cleanSub}`);
  for (const [k, v] of extraParams) {
    if (k !== 'access_token') url.searchParams.set(k, v);
  }
  url.searchParams.set('access_token', hub.token);
  return url.toString();
}

function filterRequestHeaders(headers: Headers): Headers {
  const allowed = new Set(['accept', 'content-type', 'accept-language']);
  const out = new Headers();
  for (const [k, v] of headers) {
    if (allowed.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

/**
 * Clamp a WebSocket close reason to the protocol's 123-byte limit.
 * Counts UTF-8 bytes, not characters, and trims to a whole character so a
 * multi-byte sequence can't be cut in half.
 */
function truncateCloseReason(reason: string): string {
  const enc = new TextEncoder();
  if (enc.encode(reason).length <= 123) return reason;
  let out = reason;
  while (enc.encode(out + '…').length > 123) out = out.slice(0, -1);
  return out + '…';
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
