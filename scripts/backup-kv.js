#!/usr/bin/env node
// Dumps every key in the CONFIG KV namespace to a single timestamped JSON file
// under kv-backups/, so dashboard config, hub connection, custom dashboards,
// etc. have a git history and can be restored if KV ever gets overwritten
// (e.g. by a fresh Worker deploy writing default config over real data).
//
// Usage: npm run kv:backup
// Requires: wrangler CLI configured (same credentials used by `npm run dev`/
// `npm run deploy` — either `wrangler login` or a CLOUDFLARE_API_TOKEN env var).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Some wrangler installs print an informational nag line (e.g. about Claude Code
// skills integration) to stdout ahead of the actual command output, which would
// otherwise corrupt JSON parsing / get treated as part of a key's value. Strip
// any line matching that known pattern; a no-op when it isn't present.
function wrangler(args) {
  const raw = execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8' });
  return raw
    .split('\n')
    .filter((line) => !/Cloudflare agent skills are available/.test(line))
    .join('\n')
    .trim();
}

// {hubId}:hub-connection (or the legacy unprefixed hub-connection key) can
// hold the hub's Maker API token in plaintext — the CLI-only "full KV" auth
// path described in CLAUDE.md's security model. This repo is public, so a
// backup must never commit a live credential into git history. Config the
// dashboard actually needs backed up (title/slots/layout/custom dashboards/
// dynamic config) carries no secrets; only this one key does.
function redactSecrets(key, value) {
  const isHubConnection = key === 'hub-connection' || key.endsWith(':hub-connection');
  if (isHubConnection && value && typeof value === 'object' && typeof value.token === 'string' && value.token) {
    return { ...value, token: '[REDACTED — restore this manually via Settings, not from a backup file]' };
  }
  return value;
}

function main() {
  console.log('Listing keys in CONFIG namespace...');
  const listRaw = wrangler(['kv', 'key', 'list', '--binding=CONFIG']);
  const keys = JSON.parse(listRaw).map((k) => k.name);

  if (keys.length === 0) {
    console.error('No keys found in CONFIG namespace — nothing to back up (or wrangler isn\'t pointed at the right namespace).');
    process.exit(1);
  }

  console.log(`Found ${keys.length} key(s). Fetching values...`);

  const backup = { backedUpAt: new Date().toISOString(), keys: {} };
  for (const key of keys) {
    console.log(`  - ${key}`);
    const raw = wrangler(['kv', 'key', 'get', key, '--binding=CONFIG']);
    // Most values are JSON (dashboard-config, custom-dashboards, etc.) but
    // hub-connection's token and the registered-hub-id singleton are plain
    // strings — keep whichever form round-trips correctly on restore.
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    backup.keys[key] = redactSecrets(key, value);
  }

  const outDir = path.join(__dirname, '..', 'kv-backups');
  fs.mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${timestamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(backup, null, 2) + '\n');

  console.log(`Backup written to ${path.relative(process.cwd(), outFile)}`);
}

main();
