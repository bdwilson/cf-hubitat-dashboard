#!/usr/bin/env node
// Restores KV keys from a backup file produced by scripts/backup-kv.js.
// Writes directly to the live CONFIG namespace — the same one the dashboard
// reads from — so this will overwrite whatever is currently there.
//
// Usage:
//   npm run kv:restore -- kv-backups/2026-08-15T12-00-00-000Z.json          # restore every key in the file
//   npm run kv:restore -- kv-backups/2026-08-15T12-00-00-000Z.json --key=hub123:dashboard-config   # one key only
//   npm run kv:restore -- kv-backups/2026-08-15T12-00-00-000Z.json --yes    # skip the confirmation prompt

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const readline = require('node:readline');

// See the matching comment in backup-kv.js — strips a known informational nag
// line some wrangler installs print to stdout ahead of actual output.
function wrangler(args) {
  const raw = execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8' });
  return raw
    .split('\n')
    .filter((line) => !/Cloudflare agent skills are available/.test(line))
    .join('\n')
    .trim();
}

// Must match the exact placeholder backup-kv.js writes in place of a real
// token. Restoring this literally would clobber whatever real token is
// currently live in KV with garbage, breaking the hub connection - so any
// hub-connection key carrying it is skipped entirely rather than restored.
const REDACTED_TOKEN_MARKER = '[REDACTED — restore this manually via Settings, not from a backup file]';

function isRedactedHubConnection(key, value) {
  const isHubConnection = key === 'hub-connection' || key.endsWith(':hub-connection');
  return isHubConnection && value && typeof value === 'object' && value.token === REDACTED_TOKEN_MARKER;
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const filePath = args.find((a) => !a.startsWith('--'));
  const skipConfirm = args.includes('--yes');
  const onlyKeyArg = args.find((a) => a.startsWith('--key='));
  const onlyKey = onlyKeyArg ? onlyKeyArg.slice('--key='.length) : null;

  if (!filePath) {
    console.error('Usage: npm run kv:restore -- <backup-file.json> [--key=<single-key>] [--yes]');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`Backup file not found: ${filePath}`);
    process.exit(1);
  }

  const backup = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const allKeys = Object.keys(backup.keys || {});
  const keysToRestore = onlyKey ? allKeys.filter((k) => k === onlyKey) : allKeys;

  if (keysToRestore.length === 0) {
    console.error(onlyKey ? `Key "${onlyKey}" not found in ${filePath}` : `No keys found in ${filePath}`);
    process.exit(1);
  }

  const redactedKeys = keysToRestore.filter((k) => isRedactedHubConnection(k, backup.keys[k]));
  const restorableKeys = keysToRestore.filter((k) => !redactedKeys.includes(k));

  console.log(`This will overwrite the following key(s) in the LIVE CONFIG namespace, from backup dated ${backup.backedUpAt}:`);
  restorableKeys.forEach((k) => console.log(`  - ${k}`));
  if (redactedKeys.length > 0) {
    console.log(`\nSkipping (token was redacted at backup time — restoring it would overwrite your real token with a placeholder):`);
    redactedKeys.forEach((k) => console.log(`  - ${k} — re-enter the hub token manually via Settings if needed`));
  }

  if (restorableKeys.length === 0) {
    console.log('\nNothing left to restore.');
    return;
  }

  if (!skipConfirm) {
    const ok = await confirm('\nType "yes" to proceed: ');
    if (!ok) {
      console.log('Aborted.');
      process.exit(1);
    }
  }

  for (const key of restorableKeys) {
    const value = backup.keys[key];
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    console.log(`Restoring ${key}...`);
    wrangler(['kv', 'key', 'put', key, serialized, '--binding=CONFIG']);
  }

  console.log(`\nRestored ${restorableKeys.length} key(s).`);
}

main();
