/**
 * Shared types for the dashboard Worker.
 *
 * Keep this file as the single source of truth for KV schema. When the schema
 * changes, update here and add a default value in the relevant handler so old
 * configs still load.
 */

export interface Env {
  /** KV namespace for all persisted config */
  CONFIG: KVNamespace;
  /** Static asset binding (serves src/assets/) */
  ASSETS: Fetcher;
  /** Optional override for the email used in local dev */
  DEV_USER_EMAIL?: string;
  /**
   * Set to "true" to allow multiple hubs to share one Worker deployment.
   * Requires Cloudflare Access in front of this Worker — without it, any
   * caller can read/write any hub's config. Defaults to false (single-hub).
   */
  MULTI_HUB?: string;
  /**
   * CF Access service token for authenticating outbound Worker → tunnel requests.
   * Required when the Hubitat Cloudflare Tunnel is protected by CF Access.
   * Create in Zero Trust → Access → Service Auth → Service Tokens.
   * Add via: wrangler secret put CF_ACCESS_CLIENT_ID
   */
  CF_ACCESS_CLIENT_ID?: string;
  /**
   * Paired secret for CF_ACCESS_CLIENT_ID.
   * Add via: wrangler secret put CF_ACCESS_CLIENT_SECRET
   */
  CF_ACCESS_CLIENT_SECRET?: string;
}

/** Hub connection details — stored server-side in KV. */
export interface HubConnection {
  /** Base URL. Either `https://cloud.hubitat.com/api/<hub-uid>` or `https://your-tunnel.example.com` */
  baseUrl: string;
  /** Maker API app ID — the number after /apps/api/ or /apps/ in the URL */
  appId: string;
  /** Maker API access token */
  token: string;
  /** Whether this is a Hubitat cloud URL (changes path shape) — autodetected if omitted */
  isCloud?: boolean;
}

/** One tile's configuration. */
export interface SlotConfig {
  label: string;
  kind: SlotKind;
  deviceId?: string;
  attribute?: string;
  url?: string;
  urlNewTab?: boolean;
  style?: 'auto' | 'dark' | 'flat' | 'info';
  /** Show a confirmation modal before toggling a switch */
  requireConfirm?: boolean;
  /** Show timer picker for valves instead of direct toggle */
  valveTimer?: boolean;
  /** Portrait images span 2 rows in the cameras grid */
  imageOrientation?: 'landscape' | 'portrait';
  /** How many grid columns this tile spans (default 1; 0.5 = half column) */
  colSpan?: 0.5 | 1 | 2 | 3;
  /** How many grid rows this tile spans (default 1) */
  rowSpan?: 1 | 2;
  /** Manual icon override (MDI icon name). Falls back to the kind's default icon when unset. */
  icon?: string;
}

export type SlotKind =
  | 'switch'
  | 'bulb'
  | 'lock'
  | 'garage'
  | 'contact'
  | 'presence'
  | 'mode'
  | 'hsm'
  | 'image'
  | 'dashboard-link'
  | 'text'
  | 'water'
  | 'valve'
  | 'shade'
  | 'spacer'
  | 'hidden';

/** The dashboard config — safe to expose to the browser. */
export interface DashboardConfig {
  title: string;
  pollSec: number;
  slots: Record<string, SlotConfig>;
  /** Ordered slot IDs per section. If omitted, LAYOUT_DEFAULTS is used. */
  layout?: Record<string, string[]>;
  /** Number of grid columns per section (2–6). Default 3. */
  gridCols?: number;
  /** Tile row height in pixels. Default 80. */
  tileH?: number;
}

/** Dynamic dashboard visibility — hidden[deviceId] = true means hidden */
export interface DynamicConfig {
  hidden: Record<string, boolean>;
  /** Per-group device order for drag-to-reorder (array of deviceId strings) */
  order?: Record<string, string[]>;
}

/** One tile on a custom dashboard */
export interface CustomTile {
  slotId: string;
  deviceId: string;
  kind: SlotKind;
  label: string;
  colSpan?: 1 | 2 | 3;
  rowSpan?: 1 | 2;
  /** Manual icon override (MDI icon name). Falls back to the kind's default icon when unset. */
  icon?: string;
}

/** A user-created custom dashboard */
export interface CustomDashboard {
  title: string;
  tiles: CustomTile[];
  /** Column count override for this dashboard (2–6). Omit for auto. */
  gridCols?: number;
}

/** The full config blob returned by /api/config when include_secrets=1. */
export interface FullConfig {
  hub: HubConnection;
  dashboard: DashboardConfig;
  dynamic?: DynamicConfig;
  custom?: Record<string, CustomDashboard>;
  dashboardsVisible?: Record<string, boolean>;
  dashboardsOrder?: string[];
  statusBarPresenceDevices?: Record<string, unknown>;
}

/** What /api/config returns by default (no secrets). */
export interface PublicConfig {
  hub: Omit<HubConnection, 'token'> & { hasToken: boolean };
  dashboard: DashboardConfig;
  dynamic?: DynamicConfig;
  custom?: Record<string, CustomDashboard>;
  dashboardsVisible?: Record<string, boolean>;
  dashboardsOrder?: string[];
  statusBarPresenceDevices?: Record<string, unknown>;
}
