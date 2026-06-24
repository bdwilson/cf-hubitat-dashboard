/**
 * /api/hub/* — proxy browser requests to Hubitat's Maker API.
 *
 * The browser calls e.g. GET /api/hub/devices/all
 * We rewrite to:
 *   Cloud:  {baseUrl}/apps/{appId}/devices/all?access_token={token}
 *   LAN:    {baseUrl}/apps/api/{appId}/devices/all?access_token={token}
 *
 * The token is server-side. It never appears in the browser's network tab.
 *
 * WebSocket proxy: GET /api/hub/events with Upgrade: websocket header
 *   Proxies to ws://{hub}/eventsocket (LAN/tunnel only; cloud falls back to
 *   polling — the cloud API does not expose a WebSocket event stream).
 */

import { loadHubConnection } from './config';
import type { Env, HubConnection } from '../types';

export async function handleHubProxy(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  // WebSocket upgrade: /api/hub/events
  if (
    url.pathname === '/api/hub/events' &&
    req.headers.get('Upgrade')?.toLowerCase() === 'websocket'
  ) {
    return handleWebSocketProxy(req, env);
  }

  const hub = await loadHubConnection(env);
  if (!hub.baseUrl || !hub.appId || !hub.token) {
    return jsonError(
      'Hub connection not configured. Open dashboard settings and save hub credentials first.',
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

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: filterRequestHeaders(req.headers),
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
 * WebSocket proxy: browser <-> Worker <-> hub eventsocket.
 *
 * Only works for LAN/tunnel hub URLs. The Hubitat Cloud API does not expose
 * a WebSocket event stream. Returns 501 for cloud URLs so the browser knows
 * to fall back to polling.
 *
 * Hub eventsocket: ws://{hub}/eventsocket — broadcasts all device events,
 * no authentication required when the hub is on the same network (or reachable
 * via a Cloudflare Tunnel that handles auth).
 */
async function handleWebSocketProxy(_req: Request, env: Env): Promise<Response> {
  const hub = await loadHubConnection(env);

  if (!hub.baseUrl || !hub.token) {
    return new Response('Hub not configured', { status: 503 });
  }

  const isCloud = hub.isCloud ?? hub.baseUrl.includes('cloud.hubitat.com');
  if (isCloud) {
    // Cloud API has no WebSocket endpoint — browser should fall back to polling.
    return new Response(
      'WebSocket events not available for Hubitat Cloud URLs; the dashboard will use polling instead.',
      { status: 501 },
    );
  }

  // Build the upstream hub WebSocket URL.
  // Hubitat's eventsocket is at ws://{host}/eventsocket (no auth required on LAN).
  // If using a Cloudflare Tunnel the base URL is already https://, so swap to wss://.
  const wsBase = hub.baseUrl.replace(/^https/, 'wss').replace(/^http(?!s)/, 'ws');
  const hubWsUrl = `${wsBase.replace(/\/+$/, '')}/eventsocket`;

  // Create the client-facing WebSocket pair.
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();

  // Connect to the hub's eventsocket.
  let hubWs: WebSocket;
  try {
    hubWs = new WebSocket(hubWsUrl);
  } catch (err) {
    server.close(1011, `Could not connect to hub: ${err instanceof Error ? err.message : String(err)}`);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Bridge messages in both directions.
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
