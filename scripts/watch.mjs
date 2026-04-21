import fs from 'node:fs';
import path from 'node:path';

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
const SUPPRESS_FIRST_RUN = process.env.SUPPRESS_FIRST_RUN !== '0';

if (!TARGET_TITLE) {
  console.error('TARGET_TITLE is required');
  process.exit(1);
}
if (!DRY_RUN && !WEBHOOK_URL) {
  console.error('WEBHOOK_URL is required (or set DRY_RUN=1)');
  process.exit(1);
}

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

async function notify(board, joiners) {
  const url = `https://randomchat.pnyo.jp/groupcall/${board._id}`;
  const text =
    `🟢 「${board.title}」に新規入室\n` +
    `+${joiners.length}人（現在 ${board.callNum}/${board.callLimit}）\n` +
    url;
  if (DRY_RUN || !WEBHOOK_URL) {
    console.log('[DRY_RUN notify]', text);
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
  const t0 = Date.now();
  const state = loadState();
  const isFirstRun = Object.keys(state.rooms).length === 0;
  const { matched, pages, total } = await collectMatches();
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);

  const seenIds = new Set();
  let notified = 0;
  for (const b of matched) {
    seenIds.add(b._id);
    const prev = state.rooms[b._id]?.callUserIds ?? [];
    const cur = b.callUserIds ?? [];
    const joiners = cur.filter((u) => !prev.includes(u));
    const shouldNotify =
      joiners.length > 0 && !(SUPPRESS_FIRST_RUN && isFirstRun && prev.length === 0);
    if (shouldNotify) {
      await notify(b, joiners);
      notified++;
    }
  }

  const carried = pruneOld(state.rooms, seenIds, nowMs);
  const newState = { updatedAt: nowIso, rooms: { ...carried } };
  for (const b of matched) {
    newState.rooms[b._id] = {
      title: b.title,
      callUserIds: b.callUserIds ?? [],
      callNum: b.callNum ?? 0,
      lastSeenAt: nowIso,
    };
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(newState, null, 2) + '\n');

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `scanned ${pages} pages (${total} rooms), matched title=${matched.length}, ` +
      `notified=${notified}, firstRun=${isFirstRun}, elapsed=${elapsed}s`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
