import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://rc.pnyo.jp/api/web/boards/calls';
const HEADERS = {
  'Authorization': 'Bearer ',
  'Accept': 'application/json',
  'Origin': 'https://randomchat.pnyo.jp',
  'Referer': 'https://randomchat.pnyo.jp/',
  'User-Agent': 'Mozilla/5.0 (randomchat-room-watcher)',
};

const TARGET_TITLE = process.env.TARGET_TITLE;
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_TYPE = (process.env.WEBHOOK_TYPE || 'discord').toLowerCase();
const MAX_PAGES = Number(process.env.MAX_PAGES || 80);
const PAGE_DELAY_MS = Number(process.env.PAGE_DELAY_MS || 250);
const STATE_PATH = process.env.STATE_PATH || 'state.json';
const DRY_RUN = process.env.DRY_RUN === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { rooms: {} };
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (!s || typeof s !== 'object' || !s.rooms) return { rooms: {} };
    return s;
  } catch (e) {
    console.warn(`state.json parse failed, starting fresh: ${e.message}`);
    return { rooms: {} };
  }
}

async function fetchPage(cursor) {
  const url = cursor ? `${BASE}?lastUpdate=${encodeURIComponent(cursor)}` : BASE;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`boards/calls ${res.status}: ${await res.text()}`);
  return res.json();
}

async function collectMatches() {
  const matched = [];
  let cursor = null;
  let pages = 0;
  let total = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const { boards, isLast } = await fetchPage(cursor);
    pages++;
    total += boards.length;
    for (const b of boards) if (b.title === TARGET_TITLE) matched.push(b);
    if (isLast || !boards.length) break;
    cursor = boards[boards.length - 1].update;
    if (i < MAX_PAGES - 1) await sleep(PAGE_DELAY_MS);
  }
  return { matched, pages, total };
}

async function notify(board, kind, prevNum, curNum) {
  const url = `https://randomchat.pnyo.jp/groupcall/${board._id}`;
  const limit = board.callLimit;
  let text;
  if (kind === 'started') {
    text =
      `🟢 「${board.title}」が始まりました\n` +
      `0 → ${curNum}/${limit}\n` +
      url;
  } else if (kind === 'becameFull') {
    text =
      `🔴 「${board.title}」が満室になりました\n` +
      `${prevNum}/${limit} → 満室(${curNum}/${limit})\n` +
      url;
  } else if (kind === 'opened') {
    text =
      `🟡 「${board.title}」に空きが出ました\n` +
      `満室(${prevNum}/${limit}) → ${curNum}/${limit}\n` +
      url;
  } else if (kind === 'ended') {
    text =
      `⚫ 「${board.title}」の通話が終了しました\n` +
      `${prevNum}/${limit} → 0/${limit}\n` +
      url;
  } else {
    text = `「${board.title}」 ${prevNum} → ${curNum}/${limit}\n${url}`;
  }
  if (DRY_RUN || !WEBHOOK_URL) {
    console.log(`[DRY_RUN notify:${kind}]`, text);
    return;
  }
  const body = WEBHOOK_TYPE === 'slack' ? { text } : { content: text };
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`webhook POST ${res.status}: ${await res.text()}`);
  }
}

// Pure function: decide which transition kind (if any) to notify for.
// Inputs are the previous state entry (or undefined) and the current board snapshot.
// Returns { kind, prevNum, curNum } or null if no transition.
export function decideTransition(prevEntry, board) {
  const curUsers = Array.isArray(board.callUserIds) ? board.callUserIds : [];
  const curNum = curUsers.length;
  const limit = Number(board.callLimit) || 0;
  if (!prevEntry) return null;
  const prevNum = Number.isFinite(prevEntry.callNum) ? prevEntry.callNum : 0;
  const prevLimit = Number.isFinite(prevEntry.callLimit) ? prevEntry.callLimit : limit;
  const wasEmpty = prevNum === 0;
  const wasFull = prevLimit > 0 && prevNum >= prevLimit;
  const isFull = limit > 0 && curNum >= limit;
  const isEmpty = curNum === 0;
  let kind = null;
  if (!wasEmpty && isEmpty) kind = 'ended';
  else if (!wasFull && isFull) kind = 'becameFull';
  else if (wasEmpty && curNum >= 1) kind = 'started';
  else if (wasFull && !isFull && curNum >= 1) kind = 'opened';
  return kind ? { kind, prevNum, curNum } : null;
}

function pruneOld(stateRooms, keepIds, now) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  const out = {};
  for (const [id, r] of Object.entries(stateRooms)) {
    if (keepIds.has(id)) continue;
    const ts = Date.parse(r.lastSeenAt);
    if (Number.isFinite(ts) && ts >= cutoff) out[id] = r;
  }
  return out;
}

async function main() {
  if (!TARGET_TITLE) {
    console.error('TARGET_TITLE is required');
    process.exit(1);
  }
  if (!DRY_RUN && !WEBHOOK_URL) {
    console.error('WEBHOOK_URL is required (or set DRY_RUN=1)');
    process.exit(1);
  }
  const t0 = Date.now();
  const state = loadState();
  const { matched, pages, total } = await collectMatches();
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);

  const seenIds = new Set();
  let notified = 0;
  for (const b of matched) {
    seenIds.add(b._id);
    const prevEntry = state.rooms[b._id];
    const decision = decideTransition(prevEntry, b);
    if (decision) {
      await notify(b, decision.kind, decision.prevNum, decision.curNum);
      notified++;
    }
  }

  const carried = pruneOld(state.rooms, seenIds, nowMs);
  const newState = { updatedAt: nowIso, rooms: { ...carried } };
  for (const b of matched) {
    const users = Array.isArray(b.callUserIds) ? b.callUserIds : [];
    newState.rooms[b._id] = {
      title: b.title,
      callUserIds: users,
      callNum: users.length,
      callLimit: Number(b.callLimit) || 0,
      lastSeenAt: nowIso,
    };
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(newState, null, 2) + '\n');

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `scanned ${pages} pages (${total} rooms), matched title=${matched.length}, ` +
      `notified=${notified}, elapsed=${elapsed}s`,
  );
}

// Run main() only when executed directly (not when imported for tests)
if (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
