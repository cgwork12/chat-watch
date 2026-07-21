// Cloudflare Worker: 1-minute reliable cron that polls rc.pnyo.jp,
// detects 4 transition kinds, and posts to a Discord webhook (or Slack).
//
// Why this exists:
//   GitHub Actions scheduled workflows are best-effort and on public free-tier
//   accounts can be delayed 20-30 minutes between fires. Cloudflare Worker cron
//   runs every 60 seconds reliably.
//
// Occupancy model (IMPORTANT — changed 2026-07):
//   randomchat stopped exposing the participant UUID list (`callUserIds`) in
//   its public data (SSR page + list API). Only the OCCUPANT COUNT (`callNum`)
//   and `callLimit` remain. So this watcher is COUNT-BASED: it can tell how
//   many people are in the room, but NOT who. Per-person features that used to
//   exist (names, "(N回目)", 滞在/総 time, UUID→name bindings) are no longer
//   possible from public data and have been removed. Notifications now fire on
//   the 4 count transitions only.
//
// Setup (see ../README.md):
//   wrangler kv namespace create STATE     -> id      -> wrangler.toml
//   wrangler kv namespace create STATE --preview -> preview_id
//   wrangler secret put WEBHOOK_URL
//   wrangler secret put TARGET_ID         (or TARGET_TITLE)
//   wrangler deploy
//
// State key schema in KV (binding STATE):
//   key "room:<id>"   value JSON {title, callNum, callLimit, lastSeenAt}

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

// Read a small non-negative integer that appears immediately after `label`
// inside the escaped-JSON region (e.g. `\"callNum\":3`).
function readIntAfter(region, label) {
  const c = region.indexOf(label);
  if (c < 0) return null;
  let d = '';
  for (let i = c + label.length; i < region.length; i++) {
    const ch = region[i];
    if (ch >= '0' && ch <= '9') d += ch; else break;
  }
  return d === '' ? null : Number(d);
}

export function extractRoomFromHtml(html, id) {
  // Index-based parsing instead of regex. The previous regex implementation
  // hit "Exceeded CPU Limit" on the Workers free plan because `[\s\S]*?`
  // patterns over 86 KB of HTML × N samples added up. indexOf + slice is O(N)
  // per call with no backtracking, dropping the parse cost dramatically.
  const idAnchor = `\\"_id\\":\\"${id}\\"`;
  const idIdx = html.indexOf(idAnchor);
  if (idIdx === -1) return null;
  // Limit our scans to a window right after _id (same JSON object).
  const region = html.slice(idIdx, idIdx + 4000);

  // title
  let title = '';
  {
    const k = '\\"title\\":\\"';
    const t = region.indexOf(k);
    if (t >= 0) {
      const s = t + k.length;
      const e = region.indexOf('\\",\\"category\\"', s);
      if (e >= 0) {
        try { title = JSON.parse('"' + region.slice(s, e) + '"'); }
        catch { title = region.slice(s, e); }
      }
    }
  }

  // callLimit / callNum — small integers after their labels. `callNum` is the
  // occupant count (the site no longer exposes the per-user `callUserIds`).
  const callLimit = readIntAfter(region, '\\"callLimit\\":') || 0;
  const callNum = readIntAfter(region, '\\"callNum\\":') || 0;

  return { _id: id, title, callNum, callLimit };
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
//   CPU limit. List-API boards already carry `callNum` and `callLimit`.
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

// ---------------------------------------------------------------------------
// Transition decision. Count-based: compares previous vs current occupant
// count (`callNum`) against the room limit. Priority (high→low):
//   ended > becameFull > started > opened.
// Mid-room churn (e.g. 1→2, 3→2) is intentionally NOT a transition.
// ---------------------------------------------------------------------------
export function decideTransition(prev, board) {
  const curNum = Number(board.callNum) || 0;
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

// Build the notification body for one of the 4 transitions. Returns null when
// there is no transition (so mid-room churn and no-change ticks are silent).
export function buildText(board, decision, now = new Date()) {
  if (!decision) return null;
  const url = `https://randomchat.pnyo.jp/groupcall/${board._id}`;
  const limit = Number(board.callLimit) || 0;
  const cur = Number(board.callNum) || 0;
  const prevNum = decision.prevNum;

  let header;
  if (decision.kind === 'started') {
    header = `🟢 「${board.title}」が始まりました\n0 → ${cur}/${limit}`;
  } else if (decision.kind === 'becameFull') {
    header = `🔴 「${board.title}」が満室になりました\n${prevNum}/${limit} → 満室(${cur}/${limit})`;
  } else if (decision.kind === 'opened') {
    header = `🟡 「${board.title}」に空きが出ました\n満室(${prevNum}/${limit}) → ${cur}/${limit}`;
  } else if (decision.kind === 'ended') {
    header = `⚫ 「${board.title}」の通話が終了しました\n${prevNum}/${limit} → 0/${limit}`;
  } else {
    return null;
  }

  return [header, url, `🕐 ${jstTimeString(now)}`].join('\n');
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

// JST time HH:MM:SS — embedded in each notification body so the user can
// tell apart messages that Discord groups together as "X minutes ago".
export function jstTimeString(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(11, 19);
}

// Process a single sample: detect a transition vs the in-memory state, send a
// notification if one fired, and return the new in-memory state. Does NOT
// touch KV — the caller persists once at the end of the cron tick, and only
// when the count/limit actually changed (dirty flag) to stay under the
// free-plan 1,000 KV-writes/day budget.
async function processSample(env, board, state) {
  const titleForDisplay = board.title || state?.title || '(タイトル不明)';
  const curNum = Number(board.callNum) || 0;
  const curLimit = Number(board.callLimit) || 0;
  const prevNum = Number.isFinite(state?.callNum) ? state.callNum : null;
  const prevLimit = Number.isFinite(state?.callLimit) ? state.callLimit : null;

  const decision = decideTransition(state, board);
  let notified = 0;
  if (decision) {
    const text = buildText({ ...board, title: titleForDisplay }, decision);
    if (text) {
      const ok = await postWebhook(env, text, decision.kind);
      if (ok) notified = 1;
      console.log(`[${decision.kind}] ${titleForDisplay} ${decision.prevNum}->${decision.curNum}/${curLimit}`);
    }
  }

  // Persist when this is the first observation, or the count / limit changed.
  // Advancing the stored count keeps transition headers accurate and lets the
  // next tick compare against a fresh baseline.
  const dirty = state == null || curNum !== prevNum || curLimit !== prevLimit;

  return {
    next: {
      title: board.title || state?.title || '',
      callNum: curNum,
      callLimit: curLimit,
      lastSeenAt: new Date().toISOString(),
    },
    notified,
    dirty,
  };
}

export async function handleCron(env) {
  const t0 = Date.now();
  // Multi-sample within a single 1-minute cron tick to reduce latency between
  // when a join/leave actually happens and when we notify. Stays inside the
  // free-plan budgets: 30s wall clock, 10ms CPU per request. 4 samples × ~0.8s
  // fetch + 3 sleeps × 5s ≈ 23s wall. Earlier denser settings (6×4s, 8×3s)
  // intermittently tripped "Exceeded CPU Limit" on busy ticks, killing
  // env.STATE.put before the state could persist and causing the same
  // notification to re-fire each subsequent tick. Erring on the safe side.
  const SAMPLES = Number(env.SAMPLES_PER_TICK || 4);
  const INTERVAL_MS = Number(env.SAMPLE_INTERVAL_MS || 5000);

  const stateCache = new Map();   // stateKey -> in-memory state
  const stateDirty = new Set();   // stateKeys with material changes that need a write
  let totalNotified = 0;
  let lastPagesInfo = '';

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
      const { next, notified, dirty } = await processSample(env, board, state);
      totalNotified += notified;
      stateCache.set(stateKey, next);
      if (dirty) stateDirty.add(stateKey);
    }
  }

  // Persist at the end, but ONLY for rooms whose count/limit actually changed.
  // Skipping writes when nothing happened keeps daily KV writes well under the
  // free-plan 1,000/day cap.
  let writes = 0;
  let skipped = 0;
  for (const [stateKey, state] of stateCache) {
    if (!stateDirty.has(stateKey)) { skipped++; continue; }
    try {
      await env.STATE.put(stateKey, JSON.stringify(state));
      writes++;
    } catch (e) {
      console.warn(`KV put failed for ${stateKey}: ${e?.message || e}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`samples=${SAMPLES} ${lastPagesInfo}, rooms=${stateCache.size}, ` +
    `notified=${totalNotified}, writes=${writes}, skipped=${skipped}, elapsed=${elapsed}s`);
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
