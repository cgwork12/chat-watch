---
name: randomchat-watcher
description: >-
  Operate and maintain the randomchat.pnyo.jp group-call room watcher. Use when
  the user wants to watch a randomchat groupcall room, get Discord notifications
  on join/leave/full/empty transitions, bind UUIDs to display names, search
  rooms by title, or debug the Cloudflare Worker that powers all of this.
  Triggers: "ながら雑談", "部屋監視", "UID登録/紐付け", "bind", "満室通知",
  "退室通知", "chat-watch", "randomchat", "pnyo".
---

# randomchat-watcher

Monitors a specific randomchat.pnyo.jp **group-call room** and posts Discord
notifications when its occupancy changes. Runs entirely on free tiers
(Cloudflare Workers cron + KV). This skill is the operating manual.

## Repo / deploy locations

- **Local repo**: `/Users/gotou/Documents/workspece/randomchat-room`
- **GitHub remote**: `git@github-cgwork:cgwork12/chat-watch.git` (branch `main`)
- **Cloudflare Worker**: `chat-watch-worker` (cron `*/1 * * * *`), account
  subdomain `ran-cha.workers.dev`. HTTP entry not published (`workers_dev = false`).
- **KV namespace binding**: `STATE`
  - id `60a062f5f1b44f1eab6f5f281c99017d`
  - preview_id `32b15cf3d3a24666a248cc102ea875bc`
- There is ALSO an older, now-secondary GitHub Actions watcher
  (`.github/workflows/watch.yml`) whose cron is **disabled** — the Worker is
  the live system. Don't re-enable the Actions cron unless the Worker dies.

## Node / wrangler gotcha (IMPORTANT)

The user's default shell Node is **v10**, which breaks `npx wrangler`.
ALWAYS invoke Node 20 explicitly:

```bash
cd /Users/gotou/Documents/workspece/randomchat-room/worker
NODE=/Users/gotou/.nvm/versions/node/v20.20.1/bin/node
$NODE test/test.mjs                                   # run tests (should be 59/59)
$NODE node_modules/wrangler/bin/wrangler.js deploy    # deploy
$NODE node_modules/wrangler/bin/wrangler.js tail --format=pretty   # live logs
```

`worker/scripts/backfill.mjs` already spawns wrangler via `process.execPath`, so
run IT with Node 20 too and it self-heals the version.

## Auth (re-login needed periodically)

The wrangler OAuth token EXPIRES. Symptom: `Failed to fetch auth token: 400`
or a silent `bindings (0 entries)` / empty KV read. Fix:

```bash
cd /Users/gotou/Documents/workspece/randomchat-room/worker
/Users/gotou/.nvm/versions/node/v20.20.1/bin/node node_modules/wrangler/bin/wrangler.js login
```

This opens a browser — **only the user can complete it**. After login, KV
reads/writes and `wrangler tail` work again. If you get 0 bindings, SUSPECT
EXPIRED AUTH before assuming data loss.

## The watched room

- `TARGET_ID = 699244bce7401621a87adf10` (title "ながら雑談"), set in
  `worker/wrangler.toml` `[vars]`. Change TARGET_ID + redeploy to watch a
  different room. `TARGET_TITLE` is an alternative (paginates the list API)
  but ID mode is preferred — it fetches the room's SSR page directly.

## Notification transitions (4 kinds, priority high→low)

Only these fire; mid-room churn (1→2, 3→2) does NOT:

| kind | condition | emoji |
|------|-----------|-------|
| `ended`     | prev≥1 → cur=0            | ⚫ |
| `becameFull`| prev<limit → cur=limit    | 🔴 |
| `started`   | prev=0 → cur≥1            | 🟢 |
| `opened`    | prev=full → cur<limit     | 🟡 |

`@everyone` mention is prepended for started/becameFull/opened (via
`IMPORTANT_MENTION` var = `@everyone`), NOT for ended.

Notification line format (current):
```
👤 <色> <名前> [👑] (<N>回目) (<uuid>) (滞在 <session> / 総 <total>)
```
- `(N回目)` = distinct JST calendar days this UUID has been seen entering
  (NOT raw entry count; same-day re-entries don't bump it). Shown on
  入室/全員 lines, not 退室.
- 滞在 = current session; 総 = lifetime across sessions.
- 退室 lines carry only 滞在/総, no (N回目).
- Every message ends with `🕐 HH:MM:SS` (JST) so Discord's "X分前" grouping
  doesn't hide when each happened.

## Managing UUID → name bindings

Bindings map a call participant UUID to a `{color, char, isHost}` chat icon.
The public API only exposes UUIDs (names are intentionally hidden), so names
are entered **manually**. Auto-attribution from chat is OFF by default
(chat timing is unreliable); enable only via `AUTO_ATTRIBUTE_ICONS=1`.

Each binding is its OWN KV key: `room:<id>:binding:<uuid>` — this design
prevents cron read-modify-write races from wiping manual binds. The cron
only READS bindings, never writes them.

```bash
cd /Users/gotou/Documents/workspece/randomchat-room/worker
NODE=/Users/gotou/.nvm/versions/node/v20.20.1/bin/node

$NODE scripts/backfill.mjs list                        # show all bindings
$NODE scripts/backfill.mjs bind <uuid|prefix> '<#hex>' '<name>' [--host]
$NODE scripts/backfill.mjs unbind <uuid|prefix>
```
- `prefix` works for any UUID ever observed (current call OR dayCount history).
  If "no observed UUID starting with…", pass the FULL 36-char UUID.
- Overwriting an existing binding = just bind again with new values.

### Color hex → label map (worker/src/index.js `colorName`)

`#000000` 黒 / `#0fb9b1` ティール / `#26de81` 緑 / `#2bcbba` エメグリ /
`#2d98da` 青 / `#3867d6` 濃青 / `#45aaf2` 水色 / `#4b6584` 灰青 /
`#778ca3` グレー / `#a55eea` 紫 / `#d1d8e0` グレー / `#eb3b5a` 紅 /
`#f7b731` 黄 / `#fa8231` オレンジ / `#fc5c65` 赤 / `#fd9644` オレンジ

When the user names a shade not in the map, add it to BOTH
`worker/src/index.js` (colorName) and `worker/scripts/backfill.mjs`
(its inline copy), then redeploy.

## Search rooms by partial title

One-off, do NOT make recurring (API-polite):
```bash
/Users/gotou/.nvm/versions/node/v20.20.1/bin/node -e '
(async()=>{
  const Q="興味ナイナイ";
  const H={"Authorization":"Bearer ","Origin":"https://randomchat.pnyo.jp","Referer":"https://randomchat.pnyo.jp/","User-Agent":"Mozilla/5.0"};
  let cursor=null, hits=[];
  for(let i=0;i<200;i++){
    const u=cursor?`https://rc.pnyo.jp/api/web/boards/calls?lastUpdate=${encodeURIComponent(cursor)}`:"https://rc.pnyo.jp/api/web/boards/calls";
    const d=await (await fetch(u,{headers:H})).json();
    for(const b of d.boards) if(b.title&&b.title.includes(Q)) hits.push(b);
    if(d.isLast||!d.boards.length) break;
    cursor=d.boards[d.boards.length-1].update;
    await new Promise(r=>setTimeout(r,150));
  }
  for(const m of hits) console.log(m._id, JSON.stringify(m.title), `${m.callUserIds.length}/${m.callLimit}`);
})();'
```

## KV state schema (`room:<id>`, cron-managed)

```jsonc
{
  "title": "ながら雑談",
  "callUserIds": ["uuid", ...],   // current occupants
  "callNum": 3, "callLimit": 5,
  "dayCount":     { "uuid": N },   // distinct JST days seen
  "lastSeenDate": { "uuid": "YYYY-MM-DD" },
  "joinedAt":     { "uuid": "ISO" }, // current session start (deleted on leave)
  "totalMs":      { "uuid": 12345 }, // cumulative completed-session ms
  "lastSeenAt":   "ISO"
}
```
Read/edit KV:
```bash
NODE=/Users/gotou/.nvm/versions/node/v20.20.1/bin/node
$NODE node_modules/wrangler/bin/wrangler.js kv key get  --binding=STATE --preview=false 'room:699244bce7401621a87adf10'
$NODE node_modules/wrangler/bin/wrangler.js kv key put  --binding=STATE --preview=false 'room:699244bce7401621a87adf10' '<json>'
```
To rewind a bugged totalMs, read → edit the number → put back (see
HANDOFF.md "known incidents").

## Free-plan limits that have bitten us (READ BEFORE CHANGING SAMPLING)

Cloudflare Workers free plan: **10 ms CPU/request**, **30 s wall clock**,
**1,000 KV writes/day** per namespace.

Recurring failure mode = "same notification every minute for N minutes":
a busy cron tick hit a limit and got KILLED before `env.STATE.put`, so KV
froze on a stale snapshot and every later tick re-detected the same
join/leave. Two independent guards now exist — keep BOTH:

1. **Skip KV writes when nothing changed** (`dirty` flag). Idle ticks log
   `writes=0, skipped=1`. This keeps daily writes under 1,000.
2. **Index-based HTML parsing** (`extractRoomFromHtml` uses indexOf+slice,
   NOT regex) — the regex version tripped "Exceeded CPU Limit" on the 86 KB
   page × N samples.

Current sampling: `SAMPLES_PER_TICK=4`, `SAMPLE_INTERVAL_MS=5000` (defaults
in code). History: 8×3s and 6×4s both intermittently exceeded CPU. If you
raise sampling, WATCH `wrangler tail` for "Exceeded CPU Limit" and confirm
`elapsed < 30s`. The "💨 一瞬の出入り" ghost counter was REMOVED by user
request — don't re-add.

## Verify a change end-to-end

```bash
cd /Users/gotou/Documents/workspece/randomchat-room/worker
NODE=/Users/gotou/.nvm/versions/node/v20.20.1/bin/node
$NODE test/test.mjs                                    # 59/59
$NODE node_modules/wrangler/bin/wrangler.js deploy
# watch ~2 ticks; healthy = "Ok ... writes=0/1 ... elapsed<30s", no "Exceeded CPU Limit"
$NODE node_modules/wrangler/bin/wrangler.js tail --format=pretty
```
Then `git add -A && git commit && git push origin main`.

## Commit / push conventions

Conventional-commit style (`fix(worker):`, `feat(worker):`,
`perf(worker):`, `chore:`). Always run tests + deploy before committing
worker changes. Push to `origin main`.
