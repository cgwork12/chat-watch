#!/usr/bin/env node
// Backfill UUID -> chat icon mapping from existing chat history.
//
// Reads the current KV state for the watched room, pulls all visible chat
// messages, and:
//   - Auto-binds when there's exactly 1 unmapped in-call UUID AND exactly
//     1 chat icon that's never been mapped before.
//   - Otherwise prints (and posts to Discord) the candidate list so you can
//     decide manually.
//
// Optional flags:
//   --apply        actually persist the (unambiguous) auto-binding to KV
//   --dry          just print, don't post to Discord (default if no --notify)
//   --notify       also post the report to Discord (uses Worker's WEBHOOK_URL)
//
// Usage:
//   node scripts/backfill.mjs                   # dry-run
//   node scripts/backfill.mjs --apply           # auto-bind unambiguous case + persist
//   node scripts/backfill.mjs --apply --notify  # also send report to Discord
import { spawnSync } from 'node:child_process';

import fs from 'node:fs';

const sub = process.argv[2];
const apply = process.argv.includes('--apply');
const notify = process.argv.includes('--notify');

// We piggyback on wrangler.toml for TARGET_ID and KV namespace binding name.
const wt = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const targetId = (wt.match(/TARGET_ID\s*=\s*"([^"]+)"/) || [])[1];
if (!targetId) {
  console.error('TARGET_ID not found in wrangler.toml');
  process.exit(1);
}

function wrangler(args) {
  const r = spawnSync('npx', ['wrangler', ...args], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function kvGet(key) {
  const r = wrangler(['kv', 'key', 'get', '--binding=STATE', '--preview=false', key]);
  if (r.code !== 0) return null;
  return r.stdout;
}
function kvPut(key, value) {
  // wrangler accepts the value as the next positional arg
  const r = wrangler(['kv', 'key', 'put', '--binding=STATE', '--preview=false', key, value]);
  if (r.code !== 0) {
    console.error('KV put failed:', r.stderr || r.stdout);
    return false;
  }
  return true;
}

// Subcommand: bind <uuid_or_prefix> <#color> <name> [--host]
if (sub === 'bind') {
  await manualBind();
  process.exit(0);
}
// Subcommand: unbind <uuid_or_prefix>
if (sub === 'unbind') {
  await manualUnbind();
  process.exit(0);
}
// Subcommand: list  — show current uuidToIcon mapping
if (sub === 'list') {
  await listMapping();
  process.exit(0);
}

// ---------- helpers (mirror src/index.js) ----------
function iconKey(icon) { return `${icon.color}|${icon.char}|${icon.isHost ? 1 : 0}`; }
function colorName(hex) {
  const m = {
    '#0fb9b1': 'ティール','#26de81': '緑','#2bcbba': 'ミント','#2d98da': '青','#3867d6': '濃青',
    '#45aaf2': '水色','#4b6584': '灰青','#778ca3': 'グレー','#a55eea': '紫','#d1d8e0': 'グレー',
    '#eb3b5a': '紅','#f7b731': '黄','#fa8231': '橙','#fc5c65': '赤','#fd9644': '橙',
  };
  return m[hex.toLowerCase()] || hex;
}
const fmtIcon = (i) => `${colorName(i.color)} ${i.char}${i.isHost ? ' 👑' : ''}`;

// ---------- main ----------
console.log('reading KV state...');
const stateRaw = kvGet(`room:${targetId}`);
if (!stateRaw) { console.error('no KV state found'); process.exit(1); }
const state = JSON.parse(stateRaw);
const mapping = { ...(state.uuidToIcon || {}) };
console.log(`room: ${state.title}  members=${state.callNum}/${state.callLimit}`);

console.log('fetching chat messages...');
const r = await fetch(`https://rc.pnyo.jp/api/web/board/messages?boardId=${targetId}`, {
  headers: {
    'Authorization': 'Bearer ',
    'Origin': 'https://randomchat.pnyo.jp',
    'Referer': 'https://randomchat.pnyo.jp/',
    'User-Agent': 'Mozilla/5.0 (chat-watch-backfill)',
  },
});
if (!r.ok) { console.error('fetch failed', r.status); process.exit(1); }
const j = await r.json();
const messages = (j.messages || []).slice().sort((a, b) => Number(a.num) - Number(b.num));
console.log(`got ${messages.length} messages, latest num=${messages.at(-1)?.num}`);

// distinct icons in chat history (oldest first)
const seenKeys = new Set();
const distinctIcons = [];
const iconCounts = new Map();
for (const m of messages) {
  const ic = m.userIcon || m.anonymousIcon;
  if (!ic?.color || !ic?.char) continue;
  const k = iconKey(ic);
  iconCounts.set(k, (iconCounts.get(k) || 0) + 1);
  if (!seenKeys.has(k)) { seenKeys.add(k); distinctIcons.push(ic); }
}

const usedKeys = new Set(Object.values(mapping).map(iconKey));
const unmappedIcons = distinctIcons.filter((i) => !usedKeys.has(iconKey(i)));
const unmappedUuids = (state.callUserIds || []).filter((u) => !mapping[u]);

console.log(`mapped already: ${Object.keys(mapping).length}`);
console.log(`unmapped UUIDs in call: ${unmappedUuids.length}`);
console.log(`distinct icons in chat: ${distinctIcons.length}  (unmapped: ${unmappedIcons.length})`);

let bound = null;
if (unmappedUuids.length === 1 && unmappedIcons.length === 1) {
  // The one unambiguous case: bind.
  const uid = unmappedUuids[0];
  const ic = unmappedIcons[0];
  bound = { uid, icon: ic };
  mapping[uid] = { color: ic.color, char: ic.char, isHost: !!ic.isHost };
  console.log(`✅ unambiguous: ${uid} -> ${fmtIcon(ic)}`);
}

// Build report
const lines = [`📋 「${state.title}」 ${state.callNum}/${state.callLimit} 状態スナップショット`];
lines.push('');
lines.push('**現在の通話メンバー:**');
for (const u of state.callUserIds || []) {
  if (mapping[u]) lines.push(`  • ${u} → ${fmtIcon(mapping[u])}`);
  else lines.push(`  • ${u} → ?`);
}
if (unmappedIcons.length > 0) {
  lines.push('');
  lines.push('**未紐付けのチャットアイコン候補（チャット履歴上の発言数）:**');
  for (const ic of unmappedIcons) {
    const k = iconKey(ic);
    const count = iconCounts.get(k);
    lines.push(`  • ${fmtIcon(ic)}  (発言数: ${count})`);
  }
}
if (bound) {
  lines.push('');
  lines.push(`🔗 自動紐付け: ${bound.uid.slice(0, 8)}… → ${fmtIcon(bound.icon)}`);
}
const report = lines.join('\n');
console.log('\n--- report ---');
console.log(report);
console.log('---');

// persist mapping if requested
if (apply) {
  // also bump lastMessageNum to current latest
  const nextLastMessageNum = Math.max(state.lastMessageNum || 0, ...messages.map((m) => Number(m.num)));
  const next = { ...state, uuidToIcon: mapping, lastMessageNum: nextLastMessageNum };
  if (kvPut(`room:${targetId}`, JSON.stringify(next))) {
    console.log('💾 KV updated.');
  }
} else {
  console.log('(dry run; pass --apply to persist)');
}

async function manualUnbind() {
  const uuidArg = process.argv[3];
  if (!uuidArg) { console.error('Usage: node scripts/backfill.mjs unbind <uuid_or_prefix>'); process.exit(2); }
  const stateRaw = kvGet(`room:${targetId}`);
  if (!stateRaw) { console.error('no KV state'); process.exit(1); }
  const state = JSON.parse(stateRaw);
  const mapping = { ...(state.uuidToIcon || {}) };
  // Resolve prefix → full UUID
  const matches = Object.keys(mapping).filter((u) => u === uuidArg || u.startsWith(uuidArg));
  if (matches.length === 0) { console.error(`no mapping for ${uuidArg}`); process.exit(1); }
  if (matches.length > 1) { console.error(`ambiguous prefix ${uuidArg}: ${matches.join(', ')}`); process.exit(1); }
  delete mapping[matches[0]];
  const next = { ...state, uuidToIcon: mapping };
  if (kvPut(`room:${targetId}`, JSON.stringify(next))) {
    console.log(`✅ unbound ${matches[0]}`);
  }
}

async function listMapping() {
  const stateRaw = kvGet(`room:${targetId}`);
  if (!stateRaw) { console.error('no KV state'); process.exit(1); }
  const state = JSON.parse(stateRaw);
  const mapping = state.uuidToIcon || {};
  const inCall = new Set(state.callUserIds || []);
  console.log(`mapping (${Object.keys(mapping).length} entries):`);
  for (const [uuid, ic] of Object.entries(mapping)) {
    const here = inCall.has(uuid) ? ' [現在通話中]' : '';
    console.log(`  ${uuid}  →  ${colorName(ic.color)} ${ic.char}${ic.isHost ? ' 👑' : ''}${here}`);
  }
}

async function manualBind() {
  const uuidArg = process.argv[3];
  const color = process.argv[4];
  const char = process.argv[5];
  const isHost = process.argv.includes('--host');
  if (!uuidArg || !color || !char) {
    console.error('Usage: node scripts/backfill.mjs bind <uuid_or_prefix> <#color> <name> [--host]');
    console.error('Example: node scripts/backfill.mjs bind 5c9f6f48 "#d1d8e0" "主" --host');
    process.exit(2);
  }
  const stateRaw = kvGet(`room:${targetId}`);
  if (!stateRaw) { console.error('no KV state'); process.exit(1); }
  const state = JSON.parse(stateRaw);
  // expand prefix to full UUID against current callUserIds
  let full = uuidArg;
  if (!uuidArg.includes('-')) {
    const cand = (state.callUserIds || []).filter((u) => u.startsWith(uuidArg));
    if (cand.length === 0) { console.error(`no UUID starting with ${uuidArg} in current call`); process.exit(1); }
    if (cand.length > 1) { console.error(`ambiguous prefix ${uuidArg}: ${cand.join(', ')}`); process.exit(1); }
    full = cand[0];
  }
  const next = { ...state, uuidToIcon: { ...(state.uuidToIcon || {}), [full]: { color, char, isHost } } };
  if (kvPut(`room:${targetId}`, JSON.stringify(next))) {
    console.log(`✅ bound ${full} → ${colorName(color)} ${char}${isHost ? ' 👑' : ''}`);
  }
}

// notify Discord
if (notify) {
  // get the secret value via environment? wrangler doesn't expose secret values.
  // Instead, accept it via env var passed from caller, or fall back to no-op.
  const url = process.env.WEBHOOK_URL;
  if (!url) {
    console.warn('WEBHOOK_URL env not set; skipping Discord notify. Pass it explicitly:');
    console.warn('  WEBHOOK_URL="..." node scripts/backfill.mjs --apply --notify');
  } else {
    const body = { content: report };
    const wr = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log(`📨 Discord report sent: HTTP ${wr.status}`);
  }
}
