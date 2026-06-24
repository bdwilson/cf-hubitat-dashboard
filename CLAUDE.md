# CLAUDE.md — Hubitat Dashboard (Cloudflare Worker)

This file gives future Claude sessions enough context to be useful immediately. **Read this before making any changes.**

## What this is

A Smartly-style replacement dashboard for Hubitat Elevation, hosted on a Cloudflare Worker with config persisted in KV. Designed for locks, garage doors, presence sensors, virtual image devices, mode/HSM controls, and dashboard links. Smartly is no longer supported; Hubitat's native dashboard is too rigid; Hestia is room-based rather than security-panel-based.

The dashboard is a single static HTML file (`src/assets/index.html`) served by the Worker via Cloudflare Workers Assets. All interactivity is vanilla JS — no build step for the HTML, no React. The Worker is TypeScript and uses Wrangler.

## Architecture

```
  Browser   ────────HTTPS (CF Access)────────►  Cloudflare Worker
  (phone,                                              │
   iPad,                                               │
   desktop)                                            │
                                                       ├─► KV (CONFIG)
                                                       │     - hub-connection:        {baseUrl, appId, token}
                                                       │     - dashboard-config:      {title, pollSec, slots, layout, gridCols, tileH}
                                                       │     - dynamic-config:        {hidden, order, overrides}
                                                       │     - custom-dashboards:     Record<string, CustomDashboard>
                                                       │     - dashboards-visible:    Record<string, boolean>
                                                       │     - dashboards-order:      string[]
                                                       │     - status-bar-presence-devices: Record<string, unknown>
                                                       │
                                                       └─► Hubitat hub  (via Cloud Maker API or
                                                            Cloudflare Tunnel — configurable)
```

**Why a Worker instead of hosting on the hub itself**: cross-device config sync (KV is the source of truth), public access via CF Access without exposing the hub to the internet, no localStorage drift between phone/iPad/desktop, and no CORS gymnastics.

**Why credentials in KV not env vars**: hub connection can be edited from the dashboard UI without redeploying. The Worker reads from KV at request time; secrets never reach the browser unless the request is `GET /api/config?include_secrets=1` (admin UI only).

## File layout

```
hubitat-dashboard/
├── CLAUDE.md                  ← you are here
├── README.md                  ← end-user setup
├── wrangler.toml              ← Worker config; KV binding lives here (gitignored — use wrangler.toml.example)
├── wrangler.toml.example      ← template for new deployments
├── package.json               ← npm scripts and deps
├── tsconfig.json
├── .dev.vars.example          ← template for local dev secrets
├── .gitignore
└── src/
    ├── index.ts               ← Worker entry; route dispatch
    ├── types.ts               ← TypeScript types (SlotKind, DashboardConfig, etc.)
    ├── handlers/
    │   ├── config.ts          ← /api/config GET/PUT/DELETE — KV-backed
    │   └── hub-proxy.ts       ← /api/hub/* — proxy to Hubitat, injects token
    └── assets/
        └── index.html         ← The entire UI — vanilla JS + HTML. No build step.
```

Workers Assets ([assets] in wrangler.toml) serves `src/assets/index.html` at `/` automatically.

## Key conventions

### Tile slots (main dashboard)
Tile layout is hardcoded in `index.html` (`LAYOUT` const and `LAYOUT_DEFAULTS`) — three rows of 3-up status tiles, a cameras section + right column, plus three bottom toggles. Slot IDs (`s1`–`s9`, `cam1`–`cam6`, `r1`–`r9`, `b1`–`b3`) are **stable identifiers keyed in KV**. **Never renumber them.** To add new tiles, append new IDs.

### Tile kinds
All valid kinds are the union type in `src/types.ts`:

```
switch | bulb | lock | garage | contact | presence | mode | hsm
image | dashboard-link | text | water | valve | shade | spacer | hidden
```

- **`bulb`**: dimmer/light. Tapping opens a level picker (25/50/75/100% + Off). Rendered with lightbulb icon + level %.
- **`spacer`**: invisible placeholder tile for layout gaps. Shows a dashed outline in edit mode only.
- **`image`**: Virtual Image device or static URL. Renders full-bleed with `<img>` + cache-busted URL. Tapping opens a lightbox. Works on both main dashboard and custom dashboards.
- **`text`**: shows an arbitrary device attribute as text. Attribute is configurable in the tile editor.

Each kind has a render branch in `renderTile()` (main dashboard), `dynValueForDevice()` (dynamic dashboards), and `renderCustomDashboard()` (custom dashboards). Click handlers: `onTileClick()`, `onDynTileClick()`, `onCustomTileClick()`.

### Mode and HSM
**Never cycle on tap.** Both open a picker modal. Cycling was rejected as too easy to accidentally skip past the intended state.

### Hub proxy paths
Browser calls `/api/hub/devices/all`. Worker rewrites to `${baseUrl}/apps/api/${appId}/devices/all?access_token=${token}` and forwards. Browser never sees the token.

For Hubitat Cloud Maker API the base URL is `https://cloud.hubitat.com/api/{hub-uid}`. The app path becomes `/apps/{app_id}` (no `/api`). For local LAN via Tunnel it's the hub IP. Both are handled by `buildHubUrl()` in `hub-proxy.ts`.

### KV keys
| Key | Contents |
|-----|----------|
| `hub-connection` | `{baseUrl, appId, token, isCloud?}` — server-side only |
| `dashboard-config` | `{title, pollSec, slots, layout?, gridCols?, tileH?}` — safe to expose |
| `dynamic-config` | `{hidden, order?, overrides?}` — hide/show and device-kind overrides |
| `custom-dashboards` | `Record<string, CustomDashboard>` |
| `dashboards-visible` | `Record<string, boolean>` — nav chip visibility |
| `dashboards-order` | `string[]` — nav chip ordering |
| `status-bar-presence-devices` | presence device IDs for status bar |

Keys are flat strings. Don't add namespacing prefixes — breaks existing data.

### Dynamic dashboards
Auto-generated from Hubitat device capabilities. Seven groups:

```js
const DYNAMIC_GROUPS = [
  { key:'switches', label:'Switches',        match: d => dynKindForDevice(d) === 'switch' },
  { key:'lights',   label:'Lights',          match: d => dynKindForDevice(d) === 'bulb' },
  { key:'locks',    label:'Locks',           match: d => dynKindForDevice(d) === 'lock' },
  { key:'battery',  label:'Battery',         match: d => getAttr(d,'battery') != null },
  { key:'presence', label:'Presence',        match: d => dynKindForDevice(d) === 'presence' },
  { key:'contact',  label:'Contact Sensors', match: d => dynKindForDevice(d) === 'contact' },
  { key:'shades',   label:'Shades',          match: d => dynKindForDevice(d) === 'shade' },
];
```

Groups use **kind-based exclusive matching** — a dimmer only appears in Lights, not Switches. Battery is attribute-based and can overlap.

To add a new auto-generated group, append an entry to `DYNAMIC_GROUPS`. It will automatically appear in the nav, the "Auto-generated Dashboards" settings checkbox, and the dashboard manager.

**Device reclassification**: `dynamicOverrides = {}` state (keyed by deviceId → kind string, persisted in `dynamic.overrides`) lets users manually move devices between groups. In edit mode, tapping a dynamic tile opens a kind picker (`showDynKindPicker()`). Choosing "Auto-detect" resets to capability detection.

`dynKindForDevice(d)` checks `dynamicOverrides[String(d.id)]` first, then auto-detects from capabilities.

### Custom dashboards
User-created dashboards stored in KV under `custom-dashboards`. Each has a title and an array of `CustomTile` objects (`{slotId, deviceId, kind, label, colSpan?, rowSpan?, ...}`).

Rendered by `renderCustomDashboard(name)`. All tile interactions handled by `onCustomTileClick()`.

**Image tiles in custom dashboards**: rendered with `image-tile` CSS class (same as main dashboard cameras). `aspect-ratio` is unset in `#custom-grid` so tiles fill their assigned grid cells (col/row span controls sizing). The `<img>` has `pointer-events: none; -webkit-user-drag: none` to prevent the browser from hijacking the tile drag with its own image-drag behavior.

### Navigation / routing
URL hash `#custom/pool`, `#dynamic/switches`, `#main` etc. encodes the current view. `readHash()` sets `currentView`. `renderView()` shows/hides the `view-main`, `view-dynamic`, `view-custom` divs. **Both must be called in sequence.** In `boot()`, `renderView()` is called twice — once before config loads (correct section visibility immediately) and once after `applyServerConfig()` (custom dashboard data available).

### Temperature / unit formatting
When displaying text attributes with units, the unit is appended without a space if it starts with `°` (degree symbol), with a space otherwise:
```js
const unit = rawUnit ? (rawUnit.startsWith('°') ? rawUnit : ` ${rawUnit}`) : '';
```
Applied in both `renderTile()` (text kind) and `renderCustomDashboard()`.

### requireConfirm behavior
- Auto-set to `true` when tile kind is changed to `lock` or `garage`.
- **Never auto-cleared** when changing kinds — preserves explicit user choice.
- Must be explicitly read from the tile/slot object when opening the editor and written back on save.

### Tile editor (tile editor modal)
`syncTileEditorVisibility()` shows/hides editor fields based on selected kind. When kind changes, the current device selection is preserved (not cleared). Duplication copies all fields including style, requireConfirm, valveTimer, url, colSpan, rowSpan.

### Spacer tiles
`kind: 'spacer'` — invisible in normal mode (opacity 0, no pointer events), dashed outline in edit mode. Used to hold grid gaps so tiles don't flow-fill empty cells.

## Common commands

```bash
npm install
npm run dev          # → http://localhost:8787, uses .dev.vars
npm run deploy       # deploy to Cloudflare
npx wrangler tail    # tail production logs
npx wrangler kv key get hub-connection --binding=CONFIG
npx wrangler kv key get dashboard-config --binding=CONFIG
npx wrangler kv key get dynamic-config --binding=CONFIG
npx wrangler kv key get custom-dashboards --binding=CONFIG
```

## Dev workflow

`npm run dev` runs miniflare locally. For HTML/JS changes: edit `src/assets/index.html`, refresh browser, done. No build step. For Worker changes: `npm run dev` hot-reloads. **Do not commit `.dev.vars`** — gitignored. **Do not commit `wrangler.toml`** — gitignored; contains account ID and KV namespace IDs. Use `wrangler.toml.example` as the template.

## Security model

- **Auth**: Cloudflare Access in front of the Worker. Worker reads `CF-Access-Authenticated-User-Email`.
- **Hub token**: lives in KV. Browser only receives it via `/api/config?include_secrets=1` (admin only). Hub-proxy injects it server-side; browser never sees it during normal operation.
- **Camera image URLs**: the Worker does NOT proxy camera images — the browser fetches them directly. If cameras are on LAN and dashboard is accessed via CF Access, snapshots won't load remotely. Known limitation. Options: (a) Cloudflare Tunnel for cameras, (b) add `/api/image-proxy?url=...` route.
- **Rate limiting**: not enforced. Cloudflare's free tier rate limiting can be added separately.
- **CSP**: not set. Should be added: `default-src 'self'; img-src *; connect-src 'self'`.

## Gotchas

1. **Hubitat Cloud Maker API rate limits.** Don't poll faster than 5s. Default is 5s.
2. **Hubitat Cloud vs LAN URL shape.** LAN: `/apps/api/{id}`. Cloud: `/apps/{id}`. `buildHubUrl()` handles both — don't bypass it.
3. **`image` capability ≠ `ImageUrl`.** Virtual Image devices expose `ImageUrl` with attribute `imageUrl`. Other devices may expose `image` (base64) or `ImageCapture`. Current code handles `imageUrl`, `image`, `imageUri` in `isImageDevice()` and `getImageUrl()`. New drivers may need additional attribute names — extend both functions together. The `refreshRate` attribute from Hubitat's Virtual Image driver is in **seconds** (`SetRefreshRateInSeconds`). Both the main dashboard and custom dashboard multiply by 1000 to get ms.
4. **Mode picker requires modes to be loaded.** If `/api/hub/modes` hasn't returned, picker shows error. Transient on load — refresh handles it.
5. **HSM commands**: `armAway`, `armHome`, `armNight`, `disarm`, `armRules`, `disarmRules`, `cancelAlerts`. Maps to `/hsm/{cmd}`, not `/hsm` with body.
6. **Slot config schema migrations**: always default new fields when reading. Old configs won't have new fields. Don't assume `s.style`, `s.url`, `s.requireConfirm`, etc. exist.
7. **KV writes are eventually consistent.** Don't build retry logic that assumes strict read-after-write consistency.
8. **Image tiles in custom dashboards**: `<img>` must have `pointer-events: none; -webkit-user-drag: none` or the browser hijacks the tile drag with its own image-drag behavior. The drag/resize handles need `z-index: 3` to appear above the image element. The CSS `aspect-ratio` must be unset for `#custom-grid .image-tile` to let row-span control height.
9. **Dynamic dashboard kind-based matching is exclusive**: a device auto-detected as `bulb` won't appear in Switches. The `battery` group overlaps (attribute-based, not kind-based). `dynamicOverrides` lets users manually reclassify devices.
10. **`renderView()` must always be called after `readHash()`**: setting `currentView` alone doesn't change which DOM sections are visible. Boot calls both, `navigate()` calls both. Missing either one causes the wrong view to show.

## Things to not change without thinking

- The slot ID scheme (`s1`, `s2`, ..., `cam1`, `r1`, `b1`, etc.). Breaks existing KV data.
- The KV key names. Same reason.
- The hub proxy URL shape (`/api/hub/*`). Keeps debugging simple.
- The "Auto" style behavior for switches (green when on). Users build muscle memory around this.
- The "flat / light gray" style for the three bottom toggles. Visually distinct on purpose.
- The `dynKindForDevice()` auto-detection priority order. Changes which group devices land in.

## Open questions / future work

- [ ] Image proxy route so remote cameras work behind CF Access (`/api/image-proxy?url=...`)
- [ ] WebSocket eventstream from hub for real-time updates (currently polling every 5s) — this is the main benefit Cloudflare Tunnel would unlock; cloud Maker API does not support WebSocket
- [ ] Per-user config isolation (key KV by CF-Access user email)
- [ ] Backup/snapshot of KV to git (scheduled GitHub Action)

## Reference links

- Hubitat Maker API docs: <https://docs2.hubitat.com/en/apps/maker-api>
- Cloudflare Workers Assets: <https://developers.cloudflare.com/workers/static-assets/>
- Cloudflare KV: <https://developers.cloudflare.com/kv/>
- Cloudflare Access setup: <https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/>
