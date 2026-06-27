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

  const wsBase = baseUrl.replace(/^https/, 'wss').replace(/^http(?!s)/, 'ws');
  const hubWsUrl = `${wsBase.replace(/\/+$/, '')}/eventsocket`;

  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();

  let hubWs: WebSocket;
  try {
    if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
      // Tunnel is protected by CF Access — use fetch() so we can send the
      // service token headers (new WebSocket() doesn't support custom headers).
      const upgradeResp = await fetch(hubWsUrl, {
        headers: {
          'Upgrade': 'websocket',
          'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
          'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
        },
      });
      const ws = upgradeResp.webSocket;
      if (!ws) {
        const text = await upgradeResp.text().catch(() => '');
        throw new Error(`Hub did not upgrade to WebSocket (status ${upgradeResp.status}${text ? ': ' + text.substring(0, 100) : ''})`);
      }
      ws.accept();
      hubWs = ws;
    } else {
      hubWs = new WebSocket(hubWsUrl);
    }
  } catch (err) {
    server.close(1011, `Could not connect to hub: ${err instanceof Error ? err.message : String(err)}`);
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

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
