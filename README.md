# Hubitat Dashboard (Cloudflare Worker)

Smartly-style replacement dashboard for Hubitat Elevation, hosted on Cloudflare Workers with config in KV.

## What you get

- Single-page dashboard accessible from anywhere (phone, iPad, desktop)
- Configuration synced across all devices via Cloudflare KV
- Hub credentials never reach the browser
- Authentication via Cloudflare Access (Zero Trust)
- No servers to maintain — runs entirely on Cloudflare's free infrastructure

---

## Before you start

### Cloudflare account

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up). Cloudflare is the platform that hosts the dashboard — think of it as the server, except you never have to manage one.

### Cloudflare billing

KV storage (used to persist your dashboard config) requires the **Cloudflare Workers Paid plan ($5/month)**. The free tier does not include KV in production. Personal dashboard usage stays well within the included limits (100k reads/day, 1k writes/day, 1GB storage), so you will not pay more than the base $5/month fee.

Enable billing: Cloudflare dashboard → **Workers & Pages → Plans → Upgrade to Paid**.

### Hubitat Maker API

The dashboard talks to your hub via the Maker API app. If you haven't set it up yet:

1. In Hubitat: go to **Apps → Add Built-in App → Maker API**
2. Select the devices you want to expose
3. Enable **Allow Access via Cloud** (simplest option — no local network setup needed)
4. Save — you'll see a list of URLs. You need the **Cloud Endpoint URL** and the **Access Token** shown on that page.

---

## Option A: Deploy via GitHub (recommended — no local tools required)

This is the easiest path. You only need a browser, a GitHub account, and a Cloudflare account. No Node, npm, or command-line tools needed on your machine. GitHub's servers do all the build and deploy work for free.

### Step 1 — Fork this repo on GitHub

1. Click **Fork** at the top of this page
2. Choose your GitHub account as the destination
3. Click **Create fork**

You can keep the fork **public** — no sensitive values are ever committed to the repository. All secrets live in GitHub Actions secrets and Cloudflare KV, never in the code.

> If you prefer extra privacy (e.g., you want to add personal notes to the code), make it private: **Settings → General → Danger Zone → Change repository visibility → Make private**.

### Step 2 — Enable Cloudflare Workers Paid plan

If you haven't already: Cloudflare dashboard → **Workers & Pages → Plans → Upgrade to Paid**.

### Step 3 — Create your KV namespaces in Cloudflare

KV (Key-Value) is Cloudflare's storage system — it holds your dashboard config so it syncs across all your devices. You need two namespaces: one for production and one for previews/testing.

1. Log in to [dash.cloudflare.com](https://dash.cloudflare.com)
2. In the left sidebar, click **Workers & Pages**
3. Click **KV** in the left sidebar (under Workers & Pages)
4. Click **Create namespace**
5. Name it `hubitat-dashboard-CONFIG` → click **Add**
6. You'll see the new namespace in the list with an **ID** next to it — copy and save that ID somewhere (e.g. a text file). This is your **production namespace ID**.
7. Click **Create namespace** again
8. Name it `hubitat-dashboard-CONFIG-preview` → click **Add**
9. Copy and save that **ID** too. This is your **preview namespace ID**.

### Step 4 — Get your Cloudflare account ID

1. In the Cloudflare dashboard, click **Workers & Pages** in the left sidebar
2. On the right side of the page you'll see an **Account ID** field — copy it and save it alongside your namespace IDs.

### Step 5 — Create a Cloudflare API token

This is the credential that allows GitHub to deploy to your Cloudflare account on your behalf. It can be revoked at any time without affecting the dashboard itself.

1. In the Cloudflare dashboard, click your profile icon (top right) → **My Profile**
2. Click **API Tokens** in the left sidebar
3. Click **Create Token**
4. Find the **"Edit Cloudflare Workers"** template and click **Use template**
5. Under **Account Resources**: make sure your account is selected
6. Under **Zone Resources**: leave as "All zones" (or restrict to a specific zone if you prefer)
7. Click **Continue to summary** → **Create Token**
8. **Copy the token now** — it's only shown once. Save it alongside your other values.

### Step 6 — Add secrets to your GitHub repo

GitHub Actions secrets are encrypted values that GitHub injects into your workflow at deploy time. They are never visible in logs or to other users, even on a public repo.

1. Go to your forked repo on GitHub
2. Click **Settings** (the gear icon in the top repo menu)
3. In the left sidebar, click **Secrets and variables → Actions**
4. Click **New repository secret** and add each of the following four secrets one at a time:

| Secret name | Where to find the value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Copied in Step 4 |
| `CLOUDFLARE_API_TOKEN` | Copied in Step 5 |
| `KV_NAMESPACE_ID` | Production namespace ID from Step 3 |
| `KV_PREVIEW_NAMESPACE_ID` | Preview namespace ID from Step 3 |

For each one: type the **Secret name** exactly as shown, paste the value, click **Add secret**.

### Step 7 — Deploy

1. In your forked repo, click the **Actions** tab
2. Click **Deploy to Cloudflare Workers** in the left sidebar
3. Click **Run workflow → Run workflow**
4. Wait about 30 seconds for it to complete — a green checkmark means success
5. Click into the completed run → click the **Deploy** job → expand the **Deploy** step to find your Worker URL

It will look like: `https://hubitat-dashboard.YOUR-SUBDOMAIN.workers.dev`

From now on, every push to `main` automatically redeploys. No manual steps needed for updates.

---

## Option B: Deploy from your local machine

If you're comfortable with Node.js and the command line:

### Requirements

- Node 18+
- Wrangler CLI: `npm install -g wrangler`
- A Hubitat hub with Maker API enabled

### Setup

```bash
git clone <this-repo>
cd hubitat-dashboard
npm install
npx wrangler login
cp wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml` — fill in your `account_id` and KV namespace IDs (see Steps 3 and 4 above for how to find these).

### Create the KV namespaces via CLI

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

---

## First-run dashboard config (both options)

Open your Worker URL in a browser. The settings panel opens automatically since no hub is configured yet.

Fill in your Hubitat connection:

- **Base URL**: `https://cloud.hubitat.com/api/YOUR-HUB-UID`
  - Your hub UID is in Hubitat under **Settings → Hub Details**, or visible in any Maker API cloud URL
- **App ID**: the number after `/apps/api/` in your Maker API URL
- **Access Token**: shown on the Maker API page in Hubitat under **URLs**

Click **Test & Load Devices** — if successful it shows your device count. Then click **Save to KV** to persist your config across all devices.

---

## Lock it down with Cloudflare Access (strongly recommended)

Without this, anyone who knows your Worker URL can see your dashboard. Cloudflare Access puts a login gate in front of it — only the email addresses you allow can get through, and authentication is handled entirely by Cloudflare (no passwords stored anywhere).

1. In the Cloudflare dashboard, go to **Zero Trust** (left sidebar)
   - If prompted, create a Zero Trust organization name (any name works — it's just a label)
2. Go to **Access → Applications → Add an application**
3. Choose **Self-hosted**
4. Fill in:
   - **Application name**: `Hubitat Dashboard` (or anything you like)
   - **Session duration**: how long before it asks you to log in again (e.g. `1 month`)
   - **Application domain**: your Worker URL without `https://` (e.g. `hubitat-dashboard.your-subdomain.workers.dev`)
5. Click **Next**
6. Create a policy:
   - **Policy name**: `Allow me`
   - **Action**: Allow
   - Under **Configure rules → Include**: set Selector to `Emails` and enter your email address
7. Click **Next → Add application**

Now visiting your Worker URL will redirect to a Cloudflare login page first. After authenticating with your email (via a one-time code), you're in.

---

## Optional: Cloudflare Tunnel to your hub

> **Most users don't need this.** The Hubitat Cloud Maker API works fine and is the recommended starting point. A Tunnel bypasses Hubitat Cloud, but currently provides no meaningful advantage — the dashboard polls for updates either way. The one future benefit would be real-time WebSocket updates: if the Worker could proxy the hub's event stream over a Tunnel, tiles would update instantly instead of polling every 5 seconds. That isn't implemented yet, but it's the reason the Tunnel path exists.

If you want to use a Tunnel anyway (e.g., to avoid Hubitat Cloud rate limits or keep all traffic local):

1. Install `cloudflared` on any machine on your LAN that can reach the hub
2. `cloudflared tunnel login`
3. `cloudflared tunnel create hubitat`
4. Create a config file:
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /root/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: hubitat.yourdomain.com
       service: http://192.168.1.x  # your hub's LAN IP
     - service: http_status:404
   ```
5. `cloudflared tunnel route dns hubitat hubitat.yourdomain.com`
6. `cloudflared tunnel run hubitat`
7. In the dashboard settings, use `https://hubitat.yourdomain.com` as the Base URL
8. Add a CF Access policy on that hostname too so only the Worker can reach it

---

## Configuration backup & restore

- **Save to KV**: pushes current settings to Cloudflare KV (cross-device sync)
- **Download Config**: saves a JSON backup to your device
- **Upload Config File**: restores from a JSON backup
- **Copy / Paste**: quick transfer between devices via clipboard

KV is the source of truth. Browser localStorage is only used as a short-term cache.

---

## Architecture

See [CLAUDE.md](CLAUDE.md) for the technical deep-dive.

## License

MIT
