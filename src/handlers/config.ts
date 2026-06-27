/**
 * /api/config — read/write the dashboard configuration in KV.
 *
 * KV keys:
 *   registered-hub-id                      → singleton: hub UID locked in single-hub mode
 *   {hubId}:hub-connection                 → HubConnection (server-side only by default)
 *   {hubId}:dashboard-config               → DashboardConfig (safe to expose)
 *   {hubId}:dynamic-config                 → DynamicConfig (hide/show per device)
 *   {hubId}:custom-dashboards              → Record<string, CustomDashboard>
 *   {hubId}:dashboards-visible             → Record<string, boolean>
 *   {hubId}:dashboards-order               → string[]
 *   {hubId}:status-bar-presence-devices    → Record<string, unknown>
 *
 * Hub ID:
 *   For Hubitat Cloud URLs the hub UID is extracted from the URL by the browser
 *   and sent as the X-Hub-Id request header. For LAN/tunnel URLs the browser
 *   generates a persistent random UUID stored in localStorage. This namespaces
 *   every KV key so multiple hubs can share a single Worker deployment.
 *
 * Single-hub mode (MULTI_HUB=false, default):
 *   The first hub ID presented is registered in KV as `registered-hub-id`.
 *   Subsequent requests with a different hub ID are rejected with 403.
 *   Cloudflare Access is recommended but not required.
 *
 * Multi-hub mode (MULTI_HUB=true):
 *   Any hub ID can read/write its own namespaced config.
 *   Cloudflare Access is REQUIRED — without it any caller can write to your KV.
 *
 * Routes:
 *   GET    /api/config                    → PublicConfig (no token)
 *   GET    /api/config?include_secrets=1  → FullConfig (admin only)
 *   PUT    /api/config                    → save body as full config (partial update)
 *   DELETE /api/config                    → wipe all keys for this hub ID
 */

import type {
  CustomDashboard,
  DashboardConfig,
  DynamicConfig,
  Env,
  FullConfig,
  HubConnection,
  PublicConfig,
  SlotConfig,
} from '../types';

const KV_REGISTERED_HUB = 'registered-hub-id';
const KV_HUB = 'hub-connection';
const KV_DASHBOARD = 'dashboard-config';
const KV_DYNAMIC = 'dynamic-config';
const KV_CUSTOM = 'custom-dashboards';
const KV_DASHBOARDS_VISIBLE = 'dashboards-visible';
const KV_DASHBOARDS_ORDER = 'dashboards-order';
const KV_STATUS_BAR_PRESENCE = 'status-bar-presence-devices';

/** Prefix a KV key with the hub ID namespace. */
function hubKey(hubId: string, key: string): string {
  return `${hubId}:${key}`;
}

const DEFAULT_HUB: HubConnection = {
  baseUrl: '',
  appId: '',
  token: '',
};

const DEFAULT_SLOTS: Record<string, SlotConfig> = {
  s1:   { label: 'Slot 1',   kind: 'hidden' },
  s2:   { label: 'Slot 2',   kind: 'hidden' },
  s3:   { label: 'Slot 3',   kind: 'hidden' },
  s4:   { label: 'Slot 4',   kind: 'hidden' },
  s5:   { label: 'Slot 5',   kind: 'hidden' },
  s6:   { label: 'Slot 6',   kind: 'hidden' },
  s7:   { label: 'Slot 7',   kind: 'hidden' },
  s8:   { label: 'Slot 8',   kind: 'hidden' },
  s9:   { label: 'Slot 9',   kind: 'hidden' },
  cam1: { label: 'Image 1',  kind: 'hidden' },
  cam2: { label: 'Image 2',  kind: 'hidden' },
  cam3: { label: 'Image 3',  kind: 'hidden' },
  cam4: { label: 'Image 4',  kind: 'hidden' },
  cam5: { label: 'Image 5',  kind: 'hidden' },
  cam6: { label: 'Image 6',  kind: 'hidden' },
  r1:   { label: 'Right 1',  kind: 'hidden' },
  r2:   { label: 'Right 2',  kind: 'hidden' },
  r3:   { label: 'Right 3',  kind: 'hidden' },
  r4:   { label: 'Right 4',  kind: 'hidden' },
  r5:   { label: 'Right 5',  kind: 'hidden' },
  r6:   { label: 'Right 6',  kind: 'hidden' },
  r7:   { label: 'Right 7',  kind: 'hidden' },
  r8:   { label: 'Right 8',  kind: 'hidden' },
  r9:   { label: 'Right 9',  kind: 'hidden' },
  b1:   { label: 'Bottom 1', kind: 'hidden' },
  b2:   { label: 'Bottom 2', kind: 'hidden' },
  b3:   { label: 'Bottom 3', kind: 'hidden' },
};

const DEFAULT_DASHBOARD: DashboardConfig = {
  title: 'Home',
  pollSec: 5,
  slots: DEFAULT_SLOTS,
};

/**
 * Resolve and validate the hub ID from the request.
 *
 * Reads X-Hub-Id header (or uses hubIdOverride for the WebSocket query-param
 * case where custom headers aren't possible). In single-hub mode, registers
 * the first hub ID seen and rejects all others. In multi-hub mode, requires
 * a valid Cloudflare Access header.
 *
 * Returns { hubId } on success, or a Response error to return to the client.
 */
export async function resolveHubId(
  req: Request,
  env: Env,
  hubIdOverride?: string,
): Promise<{ hubId: string } | Response> {
  const multiHub = env.MULTI_HUB === 'true';
  const cfEmail = req.headers.get('CF-Access-Authenticated-User-Email');

  if (multiHub && !cfEmail) {
    return json(
      { error: 'Cloudflare Access authentication required for multi-hub mode. Set MULTI_HUB=false or configure CF Access in front of this Worker.' },
      401,
    );
  }

  const hubId = hubIdOverride ?? req.headers.get('X-Hub-Id');
  if (!hubId) {
    return json(
      { error: 'X-Hub-Id header required. Configure hub credentials in dashboard settings.' },
      400,
    );
  }

  // Single-hub registration check — only possible when KV is configured.
  // In browser-only mode (no KV binding) the check is skipped and the hub
  // ID is accepted as-is; credentials in the X-Hub-* headers are the auth.
  if (!multiHub && env.CONFIG) {
    const registered = await env.CONFIG.get(KV_REGISTERED_HUB);
    if (!registered) {
      await env.CONFIG.put(KV_REGISTERED_HUB, hubId);
    } else if (registered !== hubId) {
      return json(
        { error: 'This Worker is registered to a different hub. Use "Reset Everything" in dashboard settings to re-register, or set MULTI_HUB=true in wrangler.toml.' },
        403,
      );
    }
  }

  return { hubId };
}

/**
 * Load hub connection from KV.
 * Falls back to the legacy flat key on first access for seamless migration.
 */
export async function loadHubConnection(env: Env, hubId: string): Promise<HubConnection> {
  if (!env.CONFIG) return { ...DEFAULT_HUB };
  let raw = await env.CONFIG.get(hubKey(hubId, KV_HUB), 'json') as Partial<HubConnection> | null;
  if (!raw) {
    raw = await env.CONFIG.get(KV_HUB, 'json') as Partial<HubConnection> | null;
    if (raw) env.CONFIG.put(hubKey(hubId, KV_HUB), JSON.stringify(raw)).catch(() => {});
  }
  return { ...DEFAULT_HUB, ...(raw ?? {}) };
}

async function loadDashboardConfig(env: Env, hubId: string): Promise<DashboardConfig> {
  let raw = await env.CONFIG.get(hubKey(hubId, KV_DASHBOARD), 'json') as Partial<DashboardConfig> | null;
  if (!raw) {
    raw = await env.CONFIG.get(KV_DASHBOARD, 'json') as Partial<DashboardConfig> | null;
    if (raw) env.CONFIG.put(hubKey(hubId, KV_DASHBOARD), JSON.stringify(raw)).catch(() => {});
  }
  if (!raw) return structuredClone(DEFAULT_DASHBOARD);
  const slots: Record<string, SlotConfig> = { ...DEFAULT_SLOTS, ...(raw.slots ?? {}) };
  return {
    title: raw.title ?? DEFAULT_DASHBOARD.title,
    pollSec: raw.pollSec ?? DEFAULT_DASHBOARD.pollSec,
    slots,
    layout: raw.layout,
    gridCols: raw.gridCols,
    tileH: raw.tileH,
  };
}

async function loadDynamicConfig(env: Env, hubId: string): Promise<DynamicConfig> {
  let raw = await env.CONFIG.get(hubKey(hubId, KV_DYNAMIC), 'json') as DynamicConfig | null;
  if (!raw) {
    raw = await env.CONFIG.get(KV_DYNAMIC, 'json') as DynamicConfig | null;
    if (raw) env.CONFIG.put(hubKey(hubId, KV_DYNAMIC), JSON.stringify(raw)).catch(() => {});
  }
  return raw ?? { hidden: {} };
}

async function loadCustomDashboards(env: Env, hubId: string): Promise<Record<string, CustomDashboard>> {
  let raw = await env.CONFIG.get(hubKey(hubId, KV_CUSTOM), 'json') as Record<string, CustomDashboard> | null;
  if (!raw) {
    raw = await env.CONFIG.get(KV_CUSTOM, 'json') as Record<string, CustomDashboard> | null;
    if (raw) env.CONFIG.put(hubKey(hubId, KV_CUSTOM), JSON.stringify(raw)).catch(() => {});
  }
  return raw ?? {};
}

async function loadDashboardsVisible(env: Env, hubId: string): Promise<Record<string, boolean>> {
  let raw = await env.CONFIG.get(hubKey(hubId, KV_DASHBOARDS_VISIBLE), 'json') as Record<string, boolean> | null;
  if (!raw) {
    raw = await env.CONFIG.get(KV_DASHBOARDS_VISIBLE, 'json') as Record<string, boolean> | null;
    if (raw) env.CONFIG.put(hubKey(hubId, KV_DASHBOARDS_VISIBLE), JSON.stringify(raw)).catch(() => {});
  }
  return raw ?? {};
}

async function loadDashboardsOrder(env: Env, hubId: string): Promise<string[]> {
  let raw = await env.CONFIG.get(hubKey(hubId, KV_DASHBOARDS_ORDER), 'json') as string[] | null;
  if (!raw) {
    raw = await env.CONFIG.get(KV_DASHBOARDS_ORDER, 'json') as string[] | null;
    if (raw) env.CONFIG.put(hubKey(hubId, KV_DASHBOARDS_ORDER), JSON.stringify(raw)).catch(() => {});
  }
  return raw ?? [];
}

async function loadStatusBarPresenceDevices(env: Env, hubId: string): Promise<Record<string, unknown>> {
  let raw = await env.CONFIG.get(hubKey(hubId, KV_STATUS_BAR_PRESENCE), 'json') as Record<string, unknown> | null;
  if (!raw) {
    raw = await env.CONFIG.get(KV_STATUS_BAR_PRESENCE, 'json') as Record<string, unknown> | null;
    if (raw) env.CONFIG.put(hubKey(hubId, KV_STATUS_BAR_PRESENCE), JSON.stringify(raw)).catch(() => {});
  }
  return raw ?? {};
}

export async function handleConfig(req: Request, env: Env): Promise<Response> {
  if (!env.CONFIG) {
    return json(
      { error: 'KV not configured. This Worker is running in browser-only mode — config is stored in your browser, not on the server.' },
      503,
    );
  }

  const hubResult = await resolveHubId(req, env);
  if (hubResult instanceof Response) return hubResult;
  const { hubId } = hubResult;

  const url = new URL(req.url);
  switch (req.method) {
    case 'GET':
      return getConfig(env, hubId, url.searchParams.get('include_secrets') === '1');
    case 'PUT':
      return putConfig(req, env, hubId);
    case 'DELETE':
      return deleteConfig(env, hubId);
    default:
      return json({ error: 'method not allowed' }, 405);
  }
}

async function getConfig(env: Env, hubId: string, includeSecrets: boolean): Promise<Response> {
  const [hub, dashboard, dynamic, custom, dashboardsVisible, dashboardsOrder, statusBarPresence] = await Promise.all([
    loadHubConnection(env, hubId),
    loadDashboardConfig(env, hubId),
    loadDynamicConfig(env, hubId),
    loadCustomDashboards(env, hubId),
    loadDashboardsVisible(env, hubId),
    loadDashboardsOrder(env, hubId),
    loadStatusBarPresenceDevices(env, hubId),
  ]);

  if (includeSecrets) {
    const full: FullConfig = {
      hub,
      dashboard,
      dynamic,
      custom,
      dashboardsVisible: Object.keys(dashboardsVisible).length ? dashboardsVisible : undefined,
      dashboardsOrder: dashboardsOrder.length ? dashboardsOrder : undefined,
      statusBarPresenceDevices: Object.keys(statusBarPresence).length ? statusBarPresence : undefined,
    };
    return json(full);
  }

  const safe: PublicConfig = {
    hub: {
      baseUrl: hub.baseUrl,
      appId: hub.appId,
      isCloud: hub.isCloud,
      hasToken: Boolean(hub.token),
    },
    dashboard,
    dynamic,
    custom,
    dashboardsVisible: Object.keys(dashboardsVisible).length ? dashboardsVisible : undefined,
    dashboardsOrder: dashboardsOrder.length ? dashboardsOrder : undefined,
    statusBarPresenceDevices: Object.keys(statusBarPresence).length ? statusBarPresence : undefined,
  };
  return json(safe);
}

async function putConfig(req: Request, env: Env, hubId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!isObject(body)) return json({ error: 'body must be an object' }, 400);

  const writes: Promise<unknown>[] = [];

  if (isObject(body.hub)) {
    const incoming = body.hub as Partial<HubConnection>;
    const existing = await loadHubConnection(env, hubId);
    const merged: HubConnection = {
      baseUrl: incoming.baseUrl ?? existing.baseUrl,
      appId: incoming.appId ?? existing.appId,
      token: incoming.token && incoming.token.length > 0 ? incoming.token : existing.token,
      isCloud: incoming.isCloud ?? existing.isCloud,
    };
    writes.push(env.CONFIG.put(hubKey(hubId, KV_HUB), JSON.stringify(merged)));
  }

  if (isObject(body.dashboard)) {
    const d = body.dashboard as Partial<DashboardConfig>;
    if (d.slots && !isObject(d.slots)) {
      return json({ error: 'dashboard.slots must be an object' }, 400);
    }
    const existing = await loadDashboardConfig(env, hubId);
    const merged: DashboardConfig = {
      title: typeof d.title === 'string' ? d.title : existing.title,
      pollSec: typeof d.pollSec === 'number' ? d.pollSec : existing.pollSec,
      slots: { ...existing.slots, ...((d.slots as Record<string, SlotConfig>) ?? {}) },
      layout: isObject(d.layout) ? (d.layout as Record<string, string[]>) : existing.layout,
      gridCols: typeof d.gridCols === 'number' ? d.gridCols : existing.gridCols,
      tileH: typeof d.tileH === 'number' ? d.tileH : existing.tileH,
    };
    writes.push(env.CONFIG.put(hubKey(hubId, KV_DASHBOARD), JSON.stringify(merged)));
  }

  if (isObject(body.dynamic)) {
    writes.push(env.CONFIG.put(hubKey(hubId, KV_DYNAMIC), JSON.stringify(body.dynamic)));
  }

  if (isObject(body.custom)) {
    writes.push(env.CONFIG.put(hubKey(hubId, KV_CUSTOM), JSON.stringify(body.custom)));
  }

  if (isObject(body.dashboardsVisible)) {
    writes.push(env.CONFIG.put(hubKey(hubId, KV_DASHBOARDS_VISIBLE), JSON.stringify(body.dashboardsVisible)));
  }

  if (Array.isArray(body.dashboardsOrder)) {
    writes.push(env.CONFIG.put(hubKey(hubId, KV_DASHBOARDS_ORDER), JSON.stringify(body.dashboardsOrder)));
  }

  if (isObject(body.statusBarPresenceDevices)) {
    writes.push(env.CONFIG.put(hubKey(hubId, KV_STATUS_BAR_PRESENCE), JSON.stringify(body.statusBarPresenceDevices)));
  }

  await Promise.all(writes);
  return json({ ok: true });
}

async function deleteConfig(env: Env, hubId: string): Promise<Response> {
  await Promise.all([
    env.CONFIG.delete(hubKey(hubId, KV_HUB)),
    env.CONFIG.delete(hubKey(hubId, KV_DASHBOARD)),
    env.CONFIG.delete(hubKey(hubId, KV_DYNAMIC)),
    env.CONFIG.delete(hubKey(hubId, KV_CUSTOM)),
    env.CONFIG.delete(hubKey(hubId, KV_DASHBOARDS_VISIBLE)),
    env.CONFIG.delete(hubKey(hubId, KV_DASHBOARDS_ORDER)),
    env.CONFIG.delete(hubKey(hubId, KV_STATUS_BAR_PRESENCE)),
    // Clear registration so the user can re-connect to a different hub after a full reset
    env.CONFIG.delete(KV_REGISTERED_HUB),
  ]);
  return json({ ok: true });
}

// ---- helpers ----

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
