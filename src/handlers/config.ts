/**
 * /api/config — read/write the dashboard configuration in KV.
 *
 * KV keys:
 *   hub-connection        → HubConnection (server-side only by default)
 *   dashboard-config      → DashboardConfig (always safe to expose)
 *   dynamic-config        → DynamicConfig (hide/show per device on dynamic dashboards)
 *   custom-dashboards     → Record<string, CustomDashboard> (user-created dashboards)
 *   dashboards-visible    → Record<string, boolean> (which dashboards are visible)
 *   dashboards-order      → string[] (dashboard ordering preference)
 *
 * Routes:
 *   GET    /api/config                    → PublicConfig (no token)
 *   GET    /api/config?include_secrets=1  → FullConfig (admin only)
 *   PUT    /api/config                    → save body as full config (partial update)
 *   DELETE /api/config                    → wipe all keys
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

const KV_HUB = 'hub-connection';
const KV_DASHBOARD = 'dashboard-config';
const KV_DYNAMIC = 'dynamic-config';
const KV_CUSTOM = 'custom-dashboards';
const KV_DASHBOARDS_VISIBLE = 'dashboards-visible';
const KV_DASHBOARDS_ORDER = 'dashboards-order';
const KV_STATUS_BAR_PRESENCE = 'status-bar-presence-devices';

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

/** Public helper — used by hub-proxy too. */
export async function loadHubConnection(env: Env): Promise<HubConnection> {
  const raw = await env.CONFIG.get(KV_HUB, 'json');
  return { ...DEFAULT_HUB, ...(raw as Partial<HubConnection> | null) };
}

async function loadDashboardConfig(env: Env): Promise<DashboardConfig> {
  const raw = (await env.CONFIG.get(KV_DASHBOARD, 'json')) as Partial<DashboardConfig> | null;
  if (!raw) return structuredClone(DEFAULT_DASHBOARD);
  // Merge missing slot defaults so layout doesn't break after schema additions
  const slots: Record<string, SlotConfig> = { ...DEFAULT_SLOTS, ...(raw.slots ?? {}) };
  return {
    title: raw.title ?? DEFAULT_DASHBOARD.title,
    pollSec: raw.pollSec ?? DEFAULT_DASHBOARD.pollSec,
    slots,
    layout: raw.layout,       // pass through; undefined = client uses LAYOUT_DEFAULTS
    gridCols: raw.gridCols,   // grid column count (2–6)
    tileH: raw.tileH,         // tile row height in px
  };
}

async function loadDynamicConfig(env: Env): Promise<DynamicConfig> {
  const raw = await env.CONFIG.get(KV_DYNAMIC, 'json');
  return (raw as DynamicConfig | null) ?? { hidden: {} };
}

async function loadCustomDashboards(env: Env): Promise<Record<string, CustomDashboard>> {
  const raw = await env.CONFIG.get(KV_CUSTOM, 'json');
  return (raw as Record<string, CustomDashboard> | null) ?? {};
}

async function loadDashboardsVisible(env: Env): Promise<Record<string, boolean>> {
  const raw = await env.CONFIG.get(KV_DASHBOARDS_VISIBLE, 'json');
  return (raw as Record<string, boolean> | null) ?? {};
}

async function loadDashboardsOrder(env: Env): Promise<string[]> {
  const raw = await env.CONFIG.get(KV_DASHBOARDS_ORDER, 'json');
  return (raw as string[] | null) ?? [];
}

async function loadStatusBarPresenceDevices(env: Env): Promise<Record<string, unknown>> {
  const raw = await env.CONFIG.get(KV_STATUS_BAR_PRESENCE, 'json');
  return (raw as Record<string, unknown> | null) ?? {};
}

export async function handleConfig(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  switch (req.method) {
    case 'GET':
      return getConfig(env, url.searchParams.get('include_secrets') === '1');
    case 'PUT':
      return putConfig(req, env);
    case 'DELETE':
      return deleteConfig(env);
    default:
      return json({ error: 'method not allowed' }, 405);
  }
}

async function getConfig(env: Env, includeSecrets: boolean): Promise<Response> {
  const [hub, dashboard, dynamic, custom, dashboardsVisible, dashboardsOrder, statusBarPresence] = await Promise.all([
    loadHubConnection(env),
    loadDashboardConfig(env),
    loadDynamicConfig(env),
    loadCustomDashboards(env),
    loadDashboardsVisible(env),
    loadDashboardsOrder(env),
    loadStatusBarPresenceDevices(env),
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

async function putConfig(req: Request, env: Env): Promise<Response> {
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
    const existing = await loadHubConnection(env);
    const merged: HubConnection = {
      baseUrl: incoming.baseUrl ?? existing.baseUrl,
      appId: incoming.appId ?? existing.appId,
      token: incoming.token && incoming.token.length > 0 ? incoming.token : existing.token,
      isCloud: incoming.isCloud ?? existing.isCloud,
    };
    writes.push(env.CONFIG.put(KV_HUB, JSON.stringify(merged)));
  }

  if (isObject(body.dashboard)) {
    const d = body.dashboard as Partial<DashboardConfig>;
    if (d.slots && !isObject(d.slots)) {
      return json({ error: 'dashboard.slots must be an object' }, 400);
    }
    const existing = await loadDashboardConfig(env);
    const merged: DashboardConfig = {
      title: typeof d.title === 'string' ? d.title : existing.title,
      pollSec: typeof d.pollSec === 'number' ? d.pollSec : existing.pollSec,
      slots: { ...existing.slots, ...((d.slots as Record<string, SlotConfig>) ?? {}) },
      layout: isObject(d.layout) ? (d.layout as Record<string, string[]>) : existing.layout,
      gridCols: typeof d.gridCols === 'number' ? d.gridCols : existing.gridCols,
      tileH: typeof d.tileH === 'number' ? d.tileH : existing.tileH,
    };
    writes.push(env.CONFIG.put(KV_DASHBOARD, JSON.stringify(merged)));
  }

  // Dynamic dashboard visibility (full replace)
  if (isObject(body.dynamic)) {
    writes.push(env.CONFIG.put(KV_DYNAMIC, JSON.stringify(body.dynamic)));
  }

  // Custom dashboards (full replace)
  if (isObject(body.custom)) {
    writes.push(env.CONFIG.put(KV_CUSTOM, JSON.stringify(body.custom)));
  }

  // Dashboard visibility (full replace)
  if (isObject(body.dashboardsVisible)) {
    writes.push(env.CONFIG.put(KV_DASHBOARDS_VISIBLE, JSON.stringify(body.dashboardsVisible)));
  }

  // Dashboard order (full replace)
  if (Array.isArray(body.dashboardsOrder)) {
    writes.push(env.CONFIG.put(KV_DASHBOARDS_ORDER, JSON.stringify(body.dashboardsOrder)));
  }

  // Status bar presence devices (full replace)
  if (isObject(body.statusBarPresenceDevices)) {
    writes.push(env.CONFIG.put(KV_STATUS_BAR_PRESENCE, JSON.stringify(body.statusBarPresenceDevices)));
  }

  await Promise.all(writes);
  return json({ ok: true });
}

async function deleteConfig(env: Env): Promise<Response> {
  await Promise.all([
    env.CONFIG.delete(KV_HUB),
    env.CONFIG.delete(KV_DASHBOARD),
    env.CONFIG.delete(KV_DYNAMIC),
    env.CONFIG.delete(KV_CUSTOM),
    env.CONFIG.delete(KV_DASHBOARDS_VISIBLE),
    env.CONFIG.delete(KV_DASHBOARDS_ORDER),
    env.CONFIG.delete(KV_STATUS_BAR_PRESENCE),
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
