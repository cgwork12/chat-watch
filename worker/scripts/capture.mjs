#!/usr/bin/env node
// Toggle UID-capture mode in the deployed Cloudflare Worker.
// Capture mode: every callUserIds change is notified with full UUIDs.
// The flag is a KV key with TTL — auto-expires so you can't leave it on by mistake.
//
// Usage:
//   node scripts/capture.mjs on [minutes]   # default 30, max 1440 (24h)
//   node scripts/capture.mjs off
//   node scripts/capture.mjs status
import { spawnSync } from 'node:child_process';

const KEY = 'mode:capture';
const BINDING = 'STATE';
const cmd = process.argv[2];
const arg = process.argv[3];

function wrangler(args) {
  const r = spawnSync('npx', ['wrangler', ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function isoLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

if (cmd === 'on') {
  const minutes = Math.min(1440, Math.max(1, Number(arg || 30)));
  const ttl = minutes * 60;
  const r = wrangler(['kv', 'key', 'put', `--binding=${BINDING}`, '--remote', KEY, '1', `--expiration-ttl=${ttl}`]);
  if (r.code !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
  const expiry = new Date(Date.now() + ttl * 1000);
  console.log(`✅ capture mode ON for ${minutes} min (auto-off at ${isoLocal(expiry)})`);
  console.log('Watch logs:  npx wrangler tail --format=pretty');
} else if (cmd === 'off') {
  const r = wrangler(['kv', 'key', 'delete', `--binding=${BINDING}`, '--remote', KEY]);
  if (r.code !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
  console.log('✅ capture mode OFF');
} else if (cmd === 'status') {
  const r = wrangler(['kv', 'key', 'get', `--binding=${BINDING}`, '--remote', KEY]);
  if (r.code === 0 && r.stdout.includes('1')) {
    console.log('🔍 capture mode is ON (will auto-expire when its TTL runs out)');
  } else {
    console.log('🟢 capture mode is OFF (normal 4-transition notifications)');
  }
} else {
  console.log('Usage:');
  console.log('  node scripts/capture.mjs on [minutes]   # default 30, max 1440');
  console.log('  node scripts/capture.mjs off');
  console.log('  node scripts/capture.mjs status');
  process.exit(2);
}
