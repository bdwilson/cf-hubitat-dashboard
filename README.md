# Hubitat Dashboard (Cloudflare Worker)

Smartly-style replacement dashboard for Hubitat Elevation, hosted on Cloudflare Workers with config in KV.

## What you get

- Single-page dashboard accessible from anywhere (phone, iPad, desktop)
- Configuration synced across all devices via Cloudflare KV
- Hub credentials never reach the browser
- Authentication via Cloudflare Access (Zero Trust)
- ~50 lines of YAML/JSON to deploy, no servers to maintain

## Requirements

- A Cloudflare account (free tier works)
- Wrangler CLI: `npm install -g wrangler`
- Node 18+
- A Hubitat hub with Maker API enabled
- Either Hubitat **Cloud Access** enabled in Maker API (simplest), **or** Cloudflare Tunnel set up to your hub (no rate limits)

## Quick start

```bash
git clone <this-repo>
cd hubitat-dashboard
npm install
npx wrangler login
```

### Create the KV namespace

```bash
npx wrangler kv namespace create CONFIG
npx wrangler kv namespace create CONFIG --preview
```

Paste both IDs into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CONFIG"
id = "abc123..."           # from the first command
preview_id = "def456..."   # from the second
```

### Deploy

```bash
npm run deploy
```

Wrangler prints your Worker URL, e.g. `https://hubitat-dashboard.your-subdomain.workers.dev`.

### First-run config

Open the Worker URL in a browser. You'll see the dashboard with all tiles in "unmapped" state. Click ⚙ → fill in your Hubitat connection:

- **Base URL** for Cloud: `https://cloud.hubitat.com/api/YOUR-HUB-UID` (find your hub UID in Hubitat: Settings → Hub Details, or in any Maker API cloud URL)
- **Base URL** for Tunnel: `https://your-tunnel-hostname.example.com`
- **App ID**: the number after `/apps/api/` in your Maker API URL
- **Access Token**: from Maker API → URLs

Click "Test & Load Devices", then "Save to KV". You're persisted.

### Lock it down (recommended)

In the Cloudflare dashboard:

1. Go to **Zero Trust → Access → Applications**
2. Add a self-hosted application
3. Domain: your worker hostname (e.g. `hubitat-dashboard.your-subdomain.workers.dev`)
4. Policy: allow your email(s) only
5. Save

Now only you can reach the dashboard.

## Optional: Cloudflare Tunnel to your hub

Skip Hubitat Cloud, expose your local hub to the Worker via Tunnel.

1. Install `cloudflared` on homer (or any LAN host that can reach the hub)
2. `cloudflared tunnel login`
3. `cloudflared tunnel create hubitat`
4. Create a config:
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /root/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: hubitat.yourdomain.com
       service: http://192.168.1.10  # your hub IP
     - service: http_status:404
   ```
5. Route the DNS: `cloudflared tunnel route dns hubitat hubitat.yourdomain.com`
6. Run: `cloudflared tunnel run hubitat`
7. In the dashboard settings, use `https://hubitat.yourdomain.com` as the Base URL
8. **Add a CF Access policy on that hostname too** so only the Worker can reach it (service token auth)

## Configuration backup

- **Save to KV**: pushes current settings to Cloudflare KV (cross-device sync)
- **Reload from KV**: pull latest config
- **Download Config**: JSON file backup
- **Upload Config File**: restore from JSON
- **Copy / Paste Clipboard**: quick transfer between devices

KV is the source of truth. localStorage is no longer used.

## Architecture

See [CLAUDE.md](CLAUDE.md) for the technical deep-dive.

## License

MIT (assumed; add a LICENSE file if you publish).
