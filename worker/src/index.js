// Cloudflare Worker: 1-minute reliable cron that polls rc.pnyo.jp,
// detects 4 transition kinds, and posts to a Discord webhook (or Slack).
//
// Why this exists:
//   GitHub Actions scheduled workflows are best-effort and on public free-tier
//   accounts can be delayed 20-30 minutes between fires. Cloudflare Worker cron
//   runs every 60 seconds reliably.
//
// Setup (see ../README.md):
//   wrangler kv namespace create STATE     -> id      -> wrangler.toml
//   wrangler kv namespace create STATE --preview -> preview_id
//   wrangler secret put WEBHOOK_URL
//   wrangler secret put TARGET_ID         (or TARGET_TITLE)
//   wrangler deploy
//
// State key schema in KV (binding STATE):
//   key "room:<id>"   value JSON {title, callNum, callLimit, callUserIds, lastSeenAt}

const API_BASE = 'https://rc.pnyo.jp/api/web/boards/calls';
const HEADERS = {
  'Authorization': 'Bearer ',
  'Accept': 'application/json',
  'Origin': 'https://randomchat.pnyo.jp',
  'Referer': 'https://randomchat.pnyo.jp/',
  'User-Agent': 'Mozilla/5.0 (chat-watch-worker)',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Strategy A: When watching by ID, hit the per-room SSR HTML page directly.
//   1 subrequest per cron tick, regardless of where the room is in the list.
//   The page is `cache-control: no-cache, no-store` so it's always fresh.
//
//   The board record is embedded in the Next.js streaming bundle as JSON
//   inside JS strings, so values appear with `\"` escaping.
// ---------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export function extractRoomFromHtml(html, id) {
  if (!html.includes(id)) return null;
  // Anchor on the room's _id, then capture callUserIds and callLimit that
  // appear later within a bounded window (same JSON object).
  const blockRe = new RegExp(
    `\\\\"_id\\\\":\\\\"${id}\\\\"[\\s\\S]{0,4000}?callUserIds\\\\":\\[([^\\]]*)\\][\\s\\S]{0,500}?callLimit\\\\":(\\d+)`,
  );
  const m = html.match(blockRe);
  if (!m) return null;
  const callUserIds = m[1].match(UUID_RE) || [];
  const callLimit = Number(m[2]);
  // Title is right after _id. Best effort; fall back to empty.
  let title = '';
  const tm = html.match(
    new RegExp(`\\\\"_id\\\\":\\\\"${id}\\\\",\\\\"title\\\\":\\\\"([\\s\\S]*?)\\\\",\\\\"category\\\\"`),
  );
  if (tm) {
    try { title = JSON.parse('"' + tm[1] + '"'); } catch { title = tm[1]; }
  }
  // update (last activity timestamp on the board) and messageLength (total chat
  // count). We use these together to detect "ghost visits": when update advances
  // sample-to-sample but callUserIds and messageLength haven't changed, somebody
  // briefly joined and left in the gap.
  let update = '';
  const um = html.match(
    new RegExp(`\\\\"_id\\\\":\\\\"${id}\\\\"[\\s\\S]{0,4000}?update\\\\":\\\\"([0-9T:.\\-Z]+)\\\\"`),
  );
  if (um) update = um[1];
  let messageLength = 0;
  const lm = html.match(
    new RegExp(`\\\\"_id\\\\":\\\\"${id}\\\\"[\\s\\S]{0,4000}?messageLength\\\\":(\\d+)`),
  );
  if (lm) messageLength = Number(lm[1]);
  // userId2voiceChatInfo: anything inside this object changing (socketId,
  // isMediaSoupSupported, mute flags, etc) means a voice state change that
  // we want to *not* mistake for a ghost visit. We capture it as a raw
  // string and compare sample-to-sample.
  let voiceInfo = '';
  const vm = html.match(
    new RegExp(`\\\\"_id\\\\":\\\\"${id}\\\\"[\\s\\S]{0,4000}?userId2voiceChatInfo\\\\":(\\{[\\s\\S]*?\\}),\\\\"views\\\\":`),
  );
  if (vm) voiceInfo = vm[1];
  return { _id: id, title, callUserIds, callLimit, update, messageLength, voiceInfo };
}

async function fetchRoomById(id) {
  const url = `https://randomchat.pnyo.jp/groupcall/${id}?_=${Date.now()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': HEADERS['User-Agent'], 'Cache-Control': 'no-cache' },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`groupcall page ${res.status}`);
  const html = await res.text();
  return extractRoomFromHtml(html, id);
}

// ---------------------------------------------------------------------------
// Strategy B: When watching by title, paginate the API list and match exactly.
//   Used only when TARGET_ID is not set. Keep MAX_PAGES small to fit free-plan
//   CPU limit.
// ---------------------------------------------------------------------------

async function fetchPage(cursor) {
  const url = cursor ? `${API_BASE}?lastUpdate=${encodeURIComponent(cursor)}` : API_BASE;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`boards/calls ${res.status}`);
  return res.json();
}

async function findByTitle(targetTitle, maxPages) {
  const matched = [];
  let cursor = null;
  let pages = 0;
  let total = 0;
  for (let i = 0; i < maxPages; i++) {
    const { boards, isLast } = await fetchPage(cursor);
    pages++;
    total += boards.length;
    for (const b of boards) if (b.title === targetTitle) matched.push(b);
    if (isLast || !boards.length) break;
    cursor = boards[boards.length - 1].update;
    if (i < maxPages - 1) await sleep(200);
  }
  return { matched, pages, total };
}

// ---------------------------------------------------------------------------
// Chat icons: fetch board/messages and extract (color, char, isHost) per message.
// We use these to heuristically map UUIDs (call participants) to chat identities.
// ---------------------------------------------------------------------------

async function fetchChatMessages(boardId) {
  const res = await fetch(`${API_BASE.replace('/boards/calls', '/board/messages')}?boardId=${boardId}`, {
    headers: HEADERS,
  });
  if (!res.ok) return null;
  const d = await res.json();
  return Array.isArray(d.messages) ? d.messages : [];
}

export function iconKey(icon) {
  return `${icon.color}|${icon.char}|${icon.isHost ? 1 : 0}`;
}

export function colorName(hex) {
  if (!hex) return '';
  const m = {
    '#000000': '黒',
    '#0fb9b1': 'ティール',
    '#26de81': '緑',
    '#2bcbba': 'エメグリ',
    '#2d98da': '青',
    '#3867d6': '濃青',
    '#45aaf2': '水色',
    '#4b6584': '灰青',
    '#778ca3': 'グレー',
    '#a55eea': '紫',
    '#d1d8e0': 'グレー',
    '#eb3b5a': '紅',
    '#f7b731': '黄',
    '#fa8231': 'オレンジ',
    '#fc5c65': '赤',
    '#fd9644': 'オレンジ',
  };
  return m[hex.toLowerCase()] || hex;
}

export function renderUuidWithIcon(uuid, mapping) {
  const icon = mapping?.[uuid];
  if (!icon) return `👤 ${uuid}`;
  const name = icon.char || '';
  const color = colorName(icon.color);
  const host = icon.isHost ? ' 👑' : '';
  return `👤 ${uuid} (${color} ${name}${host})`;
}

// Greedy attribution: if exactly 1 UUID joined this tick AND there is a chat
// icon that posted only after the join (= new since the previous tick's
// lastMessageNum, and not previously seen for any in-room UUID), bind them.
//
// state shape:
//   { ..., lastMessageNum: number, uuidToIcon: { [uuid]: {color, char, isHost} } }
export function attemptAttribution(prev, joined, allMessagesSorted) {
  const mapping = { ...(prev?.uuidToIcon || {}) };
  const prevLastNum = Number.isFinite(prev?.lastMessageNum) ? prev.lastMessageNum : 0;
  const newMessages = allMessagesSorted.filter((m) => Number(m.num) > prevLastNum);
  // distinct icons in new messages, ordered by first appearance (oldest first)
  const seen = new Set();
  const newIcons = [];
  for (const m of newMessages) {
    const ic = m.userIcon || m.anonymousIcon;
    if (!ic || !ic.color || !ic.char) continue;
    const k = iconKey(ic);
    if (seen.has(k)) continue;
    seen.add(k);
    newIcons.push(ic);
  }
  // Exclude icons already mapped to existing UUIDs
  const usedKeys = new Set(Object.values(mapping).map((i) => iconKey(i)));
  const candidateIcons = newIcons.filter((i) => !usedKeys.has(iconKey(i)));

  // Only attribute when there's exactly one new joiner and exactly one fresh icon.
  if (joined.length === 1 && candidateIcons.length === 1) {
    const ic = candidateIcons[0];
    mapping[joined[0]] = { color: ic.color, char: ic.char, isHost: !!ic.isHost };
  }

  // Compute new lastMessageNum (max of any seen number)
  let lastMessageNum = prevLastNum;
  for (const m of allMessagesSorted) {
    if (Number(m.num) > lastMessageNum) lastMessageNum = Number(m.num);
  }
  return { mapping, lastMessageNum, candidateIconCount: candidateIcons.length, newMessageCount: newMessages.length };
}

async function findMatched(env) {
  const targetId = env.TARGET_ID || '';
  const targetTitle = env.TARGET_TITLE || '';
  if (!targetId && !targetTitle) throw new Error('TARGET_ID or TARGET_TITLE is required');
  if (targetId) {
    const room = await fetchRoomById(targetId);
    if (!room) return { matched: [], pages: 1, total: 0, mode: 'id' };
    return { matched: [room], pages: 1, total: 1, mode: 'id' };
  }
  const maxPages = Number(env.MAX_PAGES || 10);
  const r = await findByTitle(targetTitle, maxPages);
  return { ...r, mode: 'title' };
}

// Same transition decision as scripts/watch.mjs (priority: ended > becameFull > started > opened)
export function decideTransition(prev, board) {
  const curUsers = Array.isArray(board.callUserIds) ? board.callUserIds : [];
  const curNum = curUsers.length;
  const limit = Number(board.callLimit) || 0;
  if (!prev) return null;
  const prevNum = Number.isFinite(prev.callNum) ? prev.callNum : 0;
  const prevLimit = Number.isFinite(prev.callLimit) ? prev.callLimit : limit;
  const wasEmpty = prevNum === 0;
  const wasFull = prevLimit > 0 && prevNum >= prevLimit;
  const isFull = limit > 0 && curNum >= limit;
  const isEmpty = curNum === 0;
  let kind = null;
  if (!wasEmpty && isEmpty) kind = 'ended';
  else if (!wasFull && isFull) kind = 'becameFull';
  else if (wasEmpty && curNum >= 1) kind = 'started';
  else if (wasFull && !isFull && curNum >= 1) kind = 'opened';
  return kind ? { kind, prevNum, curNum, limit } : null;
}

// Build notification body. Always fires on any callUserIds change.
// Uses 4 special transition headers when applicable, else a generic 🔵 header.
// Returns null if there's no actual change (= no notification needed).
//
// `mapping`   { [uuid]: {color, char, isHost} } — UUIDs rendered as "uuid (色 苗字)".
// `joinCount` { [uuid]: number }                 — total joins observed so far,
//                                                  appended as "(N回目)" on 入室 lines.
export function buildText(board, decision, prev, mapping, joinCount, durations, now = new Date(), ghostVisitsToday = 0) {
  const url = `https://randomchat.pnyo.jp/groupcall/${board._id}`;
  const curIds = Array.isArray(board.callUserIds) ? board.callUserIds : [];
  const prevIds = Array.isArray(prev?.callUserIds) ? prev.callUserIds : [];
  const limit = Number(board.callLimit) || 0;
  const prevSet = new Set(prevIds);
  const curSet = new Set(curIds);
  const joined = curIds.filter((u) => !prevSet.has(u));
  const left = prevIds.filter((u) => !curSet.has(u));
  if (joined.length === 0 && left.length === 0) return null;

  let header;
  if (decision?.kind === 'started') {
    header = `🟢 「${board.title}」が始まりました\n0 → ${curIds.length}/${limit}`;
  } else if (decision?.kind === 'becameFull') {
    header = `🔴 「${board.title}」が満室になりました\n${prevIds.length}/${limit} → 満室(${curIds.length}/${limit})`;
  } else if (decision?.kind === 'opened') {
    header = `🟡 「${board.title}」に空きが出ました\n満室(${prevIds.length}/${limit}) → ${curIds.length}/${limit}`;
  } else if (decision?.kind === 'ended') {
    header = `⚫ 「${board.title}」の通話が終了しました\n${prevIds.length}/${limit} → 0/${limit}`;
  } else {
    header = `🔵 「${board.title}」 ${prevIds.length}/${limit} → ${curIds.length}/${limit}`;
  }

  const r = (u) => renderUuidWithIcon(u, mapping || {});
  const visit = (u) => {
    const n = (joinCount && joinCount[u]) || 0;
    return n > 0 ? ` (${n}回目)` : '';
  };
  const stay = (u) => {
    const d = durations && durations[u];
    if (!d) return '';
    return ` (滞在 ${formatDuration(d.sessionMs)} / 総 ${formatDuration(d.totalMs)})`;
  };
  const lines = [header];
  for (const u of joined) lines.push(`+ 入室: ${r(u)}${visit(u)}${stay(u)}`);
  for (const u of left) lines.push(`- 退室: ${r(u)}${stay(u)}`);
  if (curIds.length > 0) {
    lines.push(`👥 全員:\n${curIds.map((u) => `  ${r(u)}${visit(u)}${stay(u)}`).join('\n')}`);
  }
  lines.push(url);
  lines.push(`🕐 ${jstTimeString(now)}`);
  if (Number(ghostVisitsToday) > 0) {
    lines.push(`💨 一瞬の出入り（本日）: ${ghostVisitsToday}回`);
  }
  return lines.join('\n');
}

// Discord mentions need both an explicit allowed_mentions object AND the
// inline syntax (<@id>, <@&roleId>, @everyone, @here). Webhook posts default
// to "no mentions allowed" for safety.
export function inferAllowedMentions(mention) {
  if (!mention) return null;
  if (/@everyone|@here/.test(mention)) return { parse: ['everyone'] };
  const m1 = mention.match(/<@!?(\d{5,})>/);
  if (m1) return { users: [m1[1]] };
  const m2 = mention.match(/<@&(\d{5,})>/);
  if (m2) return { roles: [m2[1]] };
  return null;
}

const IMPORTANT_KINDS = new Set(['started', 'becameFull', 'opened']);

async function postWebhook(env, text, kind) {
  const url = env.WEBHOOK_URL;
  if (!url) throw new Error('WEBHOOK_URL is required');
  const type = (env.WEBHOOK_TYPE || 'discord').toLowerCase();
  const mention = env.IMPORTANT_MENTION || '';
  const wantsMention = mention && IMPORTANT_KINDS.has(kind);
  const finalText = wantsMention ? `${mention}\n${text}` : text;
  const body = type === 'slack' ? { text: finalText } : { content: finalText };
  if (type === 'discord' && wantsMention) {
    const allow = inferAllowedMentions(mention);
    if (allow) body.allowed_mentions = allow;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.warn(`webhook ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.ok;
}

// JST calendar date (YYYY-MM-DD) used for daily joinCount reset.
export function jstDateString(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// JST time HH:MM:SS — embedded in each notification body so the user can
// tell apart messages that Discord groups together as "X minutes ago".
export function jstTimeString(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(11, 19);
}

// Human-readable duration: "12秒" / "5分" / "2時間15分" etc.
export function formatDuration(ms) {
  const x = Number(ms) || 0;
  if (x < 60_000) return `${Math.floor(x / 1000)}秒`;
  if (x < 3_600_000) return `${Math.floor(x / 60_000)}分`;
  const h = Math.floor(x / 3_600_000);
  const m = Math.floor((x % 3_600_000) / 60_000);
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

// Process a single sample: detect transition vs the in-memory state, send a
// notification if there is a change, and return the new in-memory state.
// Does NOT touch KV — caller persists once at end of cron tick.
//
// `mapping` is read separately (from the bindings KV key, never written by
// cron) so that manual binds survive eventual-consistency races with the
// cron-managed state key.
async function processSample(env, board, state, mapping) {
  const titleForDisplay = board.title || state?.title || '(タイトル不明)';
  const curIds = Array.isArray(board.callUserIds) ? board.callUserIds : [];
  const prevIds = Array.isArray(state?.callUserIds) ? state.callUserIds : [];
  const prevSet = new Set(prevIds);
  const curSet = new Set(curIds);
  const justJoined = curIds.filter((u) => !prevSet.has(u));
  const justLeft = prevIds.filter((u) => !curSet.has(u));

  // Distinct-days count: each UUID counts +1 for each calendar day (JST) it
  // appeared. Multiple re-entries within the same day stay at the same count.
  // So "(3回目)" means "3 distinct days seen", not "3 entries".
  const today = jstDateString();
  const dayCount = { ...(state?.dayCount || {}) };
  const lastSeenDate = { ...(state?.lastSeenDate || {}) };
  for (const u of justJoined) {
    if (lastSeenDate[u] !== today) {
      dayCount[u] = (dayCount[u] || 0) + 1;
      lastSeenDate[u] = today;
    }
  }

  // Session timing.
  //   joinedAt[u] = ISO string of when the current (uncompleted) session began
  //   totalMs[u]  = sum of all completed sessions for u, in ms
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const oldJoinedAt = state?.joinedAt || {};
  const joinedAt = { ...oldJoinedAt };
  const totalMs = { ...(state?.totalMs || {}) };

  // Departed this tick: close their session, add to totalMs, drop joinedAt
  for (const u of justLeft) {
    const ja = Date.parse(oldJoinedAt[u] || '');
    if (Number.isFinite(ja)) totalMs[u] = (totalMs[u] || 0) + (nowMs - ja);
    delete joinedAt[u];
  }
  // Newly joined: start a fresh session
  for (const u of justJoined) joinedAt[u] = nowIso;
  // First-ever observation of an existing member (e.g. seeded by migration):
  // give them a joinedAt of "now" so we start counting from here
  for (const u of curIds) if (!joinedAt[u]) joinedAt[u] = nowIso;

  // Build durations map used by buildText: per-UUID { sessionMs, totalMs }
  const durations = {};
  for (const u of curIds) {
    const ja = Date.parse(oldJoinedAt[u] || '');
    const session = Number.isFinite(ja) && !justJoined.includes(u) ? (nowMs - ja) : 0;
    durations[u] = { sessionMs: session, totalMs: (state?.totalMs?.[u] || 0) + session };
  }
  for (const u of justLeft) {
    const ja = Date.parse(oldJoinedAt[u] || '');
    const session = Number.isFinite(ja) ? (nowMs - ja) : 0;
    durations[u] = { sessionMs: session, totalMs: totalMs[u] || 0 };  // totalMs already includes this session
  }

  // Ghost-visit detection: someone joined and left between this sample and the
  // previous one. Heuristic — board.update advanced AND
  //   * callUserIds is unchanged (no join or leave we saw), AND
  //   * messageLength didn't change (no chat), AND
  //   * userId2voiceChatInfo is unchanged (no mute toggle / voice state change).
  // Daily counter, resets at JST midnight.
  let ghostVisitsToday = (state?.ghostResetDate === today)
    ? Number(state?.ghostVisitsToday || 0)
    : 0;
  const prevUpdate = state?.boardUpdate || '';
  const prevMsgLen = Number(state?.boardMessageLength) || 0;
  const prevVoice = state?.boardVoiceInfo || '';
  const curUpdate = String(board.update || '');
  const curMsgLen = Number(board.messageLength) || 0;
  const curVoice = String(board.voiceInfo || '');
  const callUserIdsUnchanged = justJoined.length === 0 && justLeft.length === 0;
  if (
    prevUpdate &&
    curUpdate &&
    curUpdate > prevUpdate &&
    callUserIdsUnchanged &&
    curMsgLen === prevMsgLen &&
    curVoice === prevVoice
  ) {
    ghostVisitsToday += 1;
    console.log(`[ghost] ${titleForDisplay} update ${prevUpdate} → ${curUpdate} (count=${ghostVisitsToday})`);
  }

  const decision = decideTransition(state, board);
  const text = buildText({ ...board, title: titleForDisplay }, decision, state, mapping, dayCount, durations, undefined, ghostVisitsToday);
  let notified = 0;
  if (text) {
    const ok = await postWebhook(env, text, decision?.kind || 'change');
    if (ok) notified = 1;
    const tag = decision?.kind || 'change';
    console.log(`[${tag}] ${titleForDisplay} ${prevIds.length}->${curIds.length}/${board.callLimit}`);
  }

  return {
    next: {
      title: board.title || state?.title || '',
      callUserIds: curIds,
      callNum: curIds.length,
      callLimit: Number(board.callLimit) || 0,
      dayCount,
      lastSeenDate,
      joinedAt,
      totalMs,
      boardUpdate: curUpdate,
      boardMessageLength: curMsgLen,
      boardVoiceInfo: curVoice,
      ghostVisitsToday,
      ghostResetDate: today,
      lastSeenAt: nowIso,
    },
    notified,
  };
}

export async function handleCron(env) {
  const t0 = Date.now();
  // Multi-sample within a single 1-minute cron tick to reduce latency between
  // when a join/leave actually happens and when we notify. Stays inside the
  // free-plan 30s wall-clock budget: 8 samples × ~0.8s fetch + 7 sleeps × 3s ≈ 27s.
  // Denser sampling (every 3s) catches short in-and-out events that 4s missed.
  const SAMPLES = Number(env.SAMPLES_PER_TICK || 8);
  const INTERVAL_MS = Number(env.SAMPLE_INTERVAL_MS || 3000);

  // Load each room's KV state once. We use the room id from env.TARGET_ID for
  // the ID-watching path; the title-watching path still works but only on the
  // first sample (we re-find the matched rooms each sample anyway).
  const stateCache = new Map();   // stateKey -> in-memory state
  let totalNotified = 0;
  let lastPagesInfo = '';

  // Bindings: one KV key per UUID at `room:<id>:binding:<uuid>`. Read once
  // per cron tick (not per sample) and cached in memory for the rest of the
  // tick. Per-key storage avoids the KV eventual-consistency races we hit
  // with a single aggregated bindings key.
  const bindingCache = new Map();   // boardId -> { uuid -> {color,char,isHost} }
  async function loadBindings(boardId) {
    if (bindingCache.has(boardId)) return bindingCache.get(boardId);
    const prefix = `room:${boardId}:binding:`;
    const out = {};
    let cursor;
    do {
      const list = await env.STATE.list({ prefix, cursor });
      for (const k of list.keys) {
        const uuid = k.name.slice(prefix.length);
        const v = await env.STATE.get(k.name);
        if (v) try { out[uuid] = JSON.parse(v); } catch {}
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
    bindingCache.set(boardId, out);
    return out;
  }

  for (let i = 0; i < SAMPLES; i++) {
    if (i > 0) await sleep(INTERVAL_MS);
    let pages, total, matched;
    try {
      ({ matched, pages, total } = await findMatched(env));
    } catch (e) {
      console.warn(`findMatched failed at sample ${i}: ${e.message}`);
      continue;
    }
    lastPagesInfo = `${pages}p/${total}r`;
    for (const board of matched) {
      const stateKey = `room:${board._id}`;
      let state = stateCache.get(stateKey);
      if (state === undefined) {
        const raw = await env.STATE.get(stateKey);
        state = raw ? JSON.parse(raw) : null;
      }
      const mapping = await loadBindings(board._id);
      const { next, notified } = await processSample(env, board, state, mapping);
      totalNotified += notified;
      stateCache.set(stateKey, next);
    }
  }

  // Persist once at the end (one KV write per room per cron tick)
  for (const [stateKey, state] of stateCache) {
    await env.STATE.put(stateKey, JSON.stringify(state));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`samples=${SAMPLES} ${lastPagesInfo}, rooms=${stateCache.size}, notified=${totalNotified}, elapsed=${elapsed}s`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (request.method === 'POST' && url.pathname === '/run') {
      // Manual trigger — guard with a shared secret in env.RUN_TOKEN
      const auth = request.headers.get('Authorization') || '';
      const token = (env.RUN_TOKEN || '').trim();
      if (!token || auth !== `Bearer ${token}`) {
        return new Response('unauthorized', { status: 401 });
      }
      try {
        await handleCron(env);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e) }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('Not Found', { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  },
};
