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
  return { _id: id, title, callUserIds, callLimit };
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
    '#0fb9b1': 'ティール',
    '#26de81': '緑',
    '#2bcbba': 'ミント',
    '#2d98da': '青',
    '#3867d6': '濃青',
    '#45aaf2': '水色',
    '#4b6584': '灰青',
    '#778ca3': 'グレー',
    '#a55eea': '紫',
    '#d1d8e0': 'グレー',
    '#eb3b5a': '紅',
    '#f7b731': '黄',
    '#fa8231': '橙',
    '#fc5c65': '赤',
    '#fd9644': '橙',
  };
  return m[hex.toLowerCase()] || hex;
}

export function renderUuidWithIcon(uuid, mapping) {
  const icon = mapping?.[uuid];
  if (!icon) return uuid;
  const name = icon.char || '';
  const color = colorName(icon.color);
  const host = icon.isHost ? ' 👑' : '';
  return `${uuid} (${color} ${name}${host})`;
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
// `mapping` is { [uuid]: {color, char, isHost} } — when present, UUIDs are
// rendered as "uuid (色 苗字)".
export function buildText(board, decision, prev, mapping) {
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
  const lines = [header];
  for (const u of joined) lines.push(`+ 入室: ${r(u)}`);
  for (const u of left) lines.push(`- 退室: ${r(u)}`);
  if (curIds.length > 0) {
    lines.push(`👥 全員:\n${curIds.map((u) => `  ${r(u)}`).join('\n')}`);
  }
  lines.push(url);
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

export async function handleCron(env) {
  const t0 = Date.now();
  const { matched, pages, total } = await findMatched(env);
  let notified = 0;

  for (const board of matched) {
    const stateKey = `room:${board._id}`;
    const prevRaw = await env.STATE.get(stateKey);
    const prev = prevRaw ? JSON.parse(prevRaw) : null;
    const titleForDisplay = board.title || prev?.title || '(タイトル不明)';

    const curIds = Array.isArray(board.callUserIds) ? board.callUserIds : [];
    const prevIds = Array.isArray(prev?.callUserIds) ? prev.callUserIds : [];
    const prevSet = new Set(prevIds);
    const justJoined = curIds.filter((u) => !prevSet.has(u));

    // UUID → chat-icon mapping is **manual only by default**. Chat timing is
    // unreliable (someone may post 30 min after joining, mis-attributing the
    // join), so we don't want the worker silently writing potentially-wrong
    // bindings. Set AUTO_ATTRIBUTE_ICONS=1 to opt in to the heuristic.
    let mapping = prev?.uuidToIcon || {};
    let lastMessageNum = Number.isFinite(prev?.lastMessageNum) ? prev.lastMessageNum : 0;
    let attribCount = 0;
    if (env.AUTO_ATTRIBUTE_ICONS === '1' && justJoined.length > 0) {
      try {
        const messages = await fetchChatMessages(board._id);
        if (messages) {
          messages.sort((a, b) => Number(a.num) - Number(b.num));
          const r = attemptAttribution(prev, justJoined, messages);
          attribCount = Object.keys(r.mapping).length - Object.keys(mapping).length;
          mapping = r.mapping;
          lastMessageNum = r.lastMessageNum;
        }
      } catch (e) {
        console.warn(`fetchChatMessages failed: ${e.message}`);
      }
    }
    // (Mappings are kept across leaves — same person often comes back with the
    // same UUID, and KV storage is essentially free at this scale.)

    const decision = decideTransition(prev, board);
    const text = buildText({ ...board, title: titleForDisplay }, decision, prev, mapping);
    if (text) {
      const ok = await postWebhook(env, text, decision?.kind || 'change');
      if (ok) notified++;
      const tag = decision?.kind || 'change';
      console.log(`[${tag}] ${titleForDisplay} ${prevIds.length}->${curIds.length}/${board.callLimit}` +
        (attribCount > 0 ? `  +icon-binding=${attribCount}` : ''));
    }
    const users = curIds;
    const next = {
      title: board.title || prev?.title || '',
      callUserIds: users,
      callNum: users.length,
      callLimit: Number(board.callLimit) || 0,
      uuidToIcon: mapping,
      lastMessageNum,
      lastSeenAt: new Date().toISOString(),
    };
    await env.STATE.put(stateKey, JSON.stringify(next));
  }

  // For matchByTitle, missing rooms (= room ended/disappeared) handling could go here.
  // For matchById (single room), if not found we just leave state as-is — when the room
  // re-appears in the list the diff will fire normally.

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`scanned ${pages} pages (${total} rooms), matched=${matched.length}, notified=${notified}, elapsed=${elapsed}s`);
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
