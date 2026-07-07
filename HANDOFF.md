# randomchat-watcher — 乗り換えハンドオフ

別アカウントの Claude Code に引き継ぐためのドキュメント。運用手順は
`.claude/skills/randomchat-watcher/SKILL.md`、こちらは**経緯・現状・未処理事項**。

作成: 2026-07-07 / 最終コミット `b1f145b`

---

## 1. これは何か

randomchat.pnyo.jp というランダムチャットの**グループ通話部屋**を監視し、
人の出入り（0→1 開始 / 満室 / 空き / 終了）を **Discord に通知**するシステム。
さらに参加者 UUID に手動で名前を付けて「誰が入ってきたか」を通知に出す。

全部 **無料枠**（Cloudflare Workers cron + KV、GitHub、Discord webhook）で
Mac を閉じても動く。

## 2. 構成

```
Cloudflare Worker "chat-watch-worker"  (cron */1 * * * *)
  ├─ 毎分起動 → 1分内に SAMPLES_PER_TICK(=4) 回、5秒間隔でサンプリング
  ├─ 各サンプル: https://randomchat.pnyo.jp/groupcall/<id> の SSR HTML を取得
  │              → callUserIds / callLimit / title を index 抽出
  ├─ 前回状態(KV)と差分 → 4種トランジション判定 → Discord webhook POST
  └─ 変化があった時だけ KV に書き戻し (dirty フラグ)

KV namespace "STATE"
  ├─ room:<id>                    … 通話状態 (cron が読み書き)
  └─ room:<id>:binding:<uuid>     … UUID→名前 (backfill.mjs だけが書く)
```

- リポ: `/Users/gotou/Documents/workspece/randomchat-room`
- GitHub: `git@github-cgwork:cgwork12/chat-watch.git` (main)
- 監視部屋: `TARGET_ID=699244bce7401621a87adf10` (「ながら雑談」)
- Worker サブドメイン: `ran-cha.workers.dev`（HTTP 非公開、cron のみ）

## 3. 引き継ぎ先が最初にやること

### 3-1. wrangler 再ログイン（ほぼ必須）
このチャット終了時点で **wrangler の OAuth トークンが失効**している
（`Failed to fetch auth token: 400` / `bindings (0 entries)` はこれが原因、
データ消失ではない）。ブラウザ操作が要るのでユーザー本人が実行:

```bash
cd /Users/gotou/Documents/workspece/randomchat-room/worker
/Users/gotou/.nvm/versions/node/v20.20.1/bin/node node_modules/wrangler/bin/wrangler.js login
```

**注意**: Cloudflare アカウントも別アカウントに移すなら、Worker と KV を
新アカウントで作り直す必要がある（`wrangler.toml` の KV id 差し替え +
`wrangler secret put WEBHOOK_URL` + `wrangler deploy`）。同じ Cloudflare
アカウントを使い続けるなら再ログインだけで OK。

### 3-2. Node は必ず v20
デフォルト shell の Node は v10 で wrangler が動かない。
`/Users/gotou/.nvm/versions/node/v20.20.1/bin/node` を明示。

### 3-3. bindings の健在確認
ログイン後:
```bash
cd /Users/gotou/Documents/workspece/randomchat-room/worker
/Users/gotou/.nvm/versions/node/v20.20.1/bin/node scripts/backfill.mjs list
```
下の「5. 現在の bindings」と照合。もし本当に消えていたら同節の表から
再投入（`bind` コマンドを並べる）。

## 4. Secrets / Vars（新アカウント移行時に必要）

Worker secret（`wrangler secret put <NAME>` で対話入力）:
- `WEBHOOK_URL` … Discord webhook URL。**最新は下記**（2026-05-01 に旧→新へ移行済）
  `https://discord.com/api/webhooks/1499608283789529100/ANrxbNnSJuTb2hRb9ENF8iB_qUUk01bnzkrNxZHny4zPXnOX8s3YRG5IGLU6rIBk6lSN`
  （旧 webhook 1496062990154338355 は現在未使用）

`wrangler.toml` `[vars]`（平文、リポにコミット済）:
- `TARGET_ID = "699244bce7401621a87adf10"`
- `WEBHOOK_TYPE = "discord"`
- `IMPORTANT_MENTION = "@everyone"`
- `MAX_PAGES = "10"`（title モード用、ID モードでは不使用）

## 5. 現在の bindings（会話履歴から再構成／29件）

`bind <uuid> '<hex>' '<name>' [--host]` の形で再投入できる。auth 復帰後は
`backfill.mjs list` の実データを正とすること。

| UUID (先頭8) | フル UUID | 色hex | 表示名 | host |
|---|---|---|---|---|
| 5c9f6f48 | 5c9f6f48-64e8-40ab-a48b-0f1dec11abb6 | #d1d8e0 | 主 | ✅ |
| 3a49167f | 3a49167f-2a1f-4bb5-9d39-676ba572ac72 | #fd9644 | 石川 | |
| 7b24864b | 7b24864b-c376-4186-91b1-902c9a5b8b26 | #2d98da | 山口さん | |
| 5e3c9ad9 | 5e3c9ad9-6799-4b1a-930e-1413359f30f4 | #26de81 | 橋本 | |
| 2f134a3b | 2f134a3b-6be0-4bcb-ae07-565076240ccd | #2d98da | 松本ちゃん | |
| 4d485d07 | 4d485d07-f2ac-4de7-acf4-ffd298833e55 | #2d98da | 橋本くん | |
| 47e6a618 | 47e6a618-11bd-41a3-8a01-1b6bdd877ec0 | #fc5c65 | 山下さん | |
| a0240174 | a0240174-2635-4238-8060-25d275935865 | #2d98da | 吉田さん | |
| d68f5387 | d68f5387-cb43-427c-83e3-ee5534267ec3 | #f7b731 | 伊藤さん（男性）テレワーク | |
| 545abbc8 | 545abbc8-13e6-49dc-94d3-2b62af0e58ac | #2d98da | 伊藤さん（８月らしい） | |
| 20131a1c | 20131a1c-0070-4b0d-b2f5-c35200ebf090 | #2bcbba | 山本さん（サックス） | |
| 8de4b42a | 8de4b42a-a84c-4f6f-a5f7-2e11a8ce095c | #2d98da | 中島くん（中学生） | |
| 119a30b3 | 119a30b3-d725-49a4-aaed-dbd0d0561eba | #f7b731 | 中島さん | |
| 7774323a | 7774323a-5a19-4907-b4d1-47fd731070cb | #2bcbba | 田中さん（元小林さん） | |
| 63847091 | 63847091-2cd1-431d-bf00-84c30462e231 | #fd9644 | 井上さん（女性）高校生 | |
| 0c527bde | 0c527bde-7dc4-46bf-81cc-c80e4bdbeeb3 | #2d98da | 中村さん（女性・バイク） | |
| a8a9fdfb | a8a9fdfb-1d83-4893-a2bc-2af47c49a490 | #fc5c65 | 佐藤さん（女性） | |
| 5a65cc64 | 5a65cc64-7d36-423c-bc4a-256f970afc3f | #2d98da | 松本さん（女性）専門（職人） | |
| a55c580e | a55c580e-3595-4816-b954-9f3f4917ecb7 | #fc5c65 | 橋本さん（男性） | |
| 90225dcd | 90225dcd-7aec-4ea6-9b0b-8da9ec6d8ab0 | #fc5c65 | 渡辺さん（男性？女性？） | |
| e16df1bb | e16df1bb-a127-420e-b6d7-d54b76330c1e | #fc5c65 | 山本さん（女性） | |
| a518e296 | a518e296-719b-454a-95aa-1cd17de13e74 | #f7b731 | 佐藤さん（男性） | |
| cefce2f8 | cefce2f8-6195-4802-b243-0be36e64f1fa | #fd9644 | 阿部さん（女性）23 | |
| 97655ef4 | 97655ef4-b96d-442d-89d9-51485f83e4ae | #fc5c65 | 井上さん（男性） | |
| 5b60fb14 | 5b60fb14-e46f-47d8-95d3-23acae6886c0 | #000000 | 仕切り女性らしい | |
| 5f578440 | 5f578440-69f2-4be8-a114-f8f6ebb6e7bc | #2d98da | 鈴木さん（女性）きららさん | |
| 13f0fec1 | 13f0fec1-9e2e-43cd-a30b-c1ba24ea1728 | #fd9644 | 伊藤さん（男性） | |
| 0977af0a | 0977af0a-2884-4f14-a367-8c4d5daf5fe8 | #2d98da | 中島さん（女性） | |
| 381be82d | 381be82d-f857-45ec-987f-0ea13b1d3240 | #fc5c65 | 鈴木💢 | |

> 再投入スクリプト例（auth 復帰後、消えていた場合のみ）:
> ```bash
> cd /Users/gotou/Documents/workspece/randomchat-room/worker
> N=/Users/gotou/.nvm/versions/node/v20.20.1/bin/node
> $N scripts/backfill.mjs bind 5c9f6f48-64e8-40ab-a48b-0f1dec11abb6 '#d1d8e0' '主' --host
> $N scripts/backfill.mjs bind 3a49167f-2a1f-4bb5-9d39-676ba572ac72 '#fd9644' '石川'
> # …以下、表の全 UUID を並べる
> ```

## 6. 通知フォーマット（現行）

```
🟢 「ながら雑談」が始まりました
0 → 1/5
+ 入室: 👤 グレー 主 👑 (25回目) (5c9f6f48-64e8-40ab-a48b-0f1dec11abb6) (滞在 0秒 / 総 44時間38分)
👥 全員:
  👤 グレー 主 👑 (25回目) (5c9f6f48-...) (滞在 0秒 / 総 44時間38分)
https://randomchat.pnyo.jp/groupcall/699244bce7401621a87adf10
🕐 14:24:47
```
- 名前が先頭、`(N回目)`＝観測した別日数、次に UUID、最後に 滞在/総。
- 退室行は 滞在/総 のみ（回目なし）。
- started/becameFull/opened は `@everyone` 付き、ended は無し。

## 7. これまでの主な変更（新しい順）

| commit | 内容 |
|---|---|
| b1f145b | サンプル 6→4・binding 遅延ロード（CPU 余裕確保） |
| 5eec086 | (N回目) を名前と UUID の間へ移動 |
| ea7734e | 名前を UUID より前に表示 |
| 76817c8 | dirty フラグで KV write、6サンプル化、💨ゴースト撤去 |
| da2bfe2 | HTML 抽出を正規表現→indexOf（CPU超過対策） |
| e908117 | 変化なし時 KV write スキップ（1000write/日 対策の初手） |
| 5a2abb4 | 密サンプリング＋💨ゴースト検知（※後に撤去） |
| 80ac3cd | binding を 1UUID1キーに分離（レース根絶） |
| c2c4f20 | cron内マルチサンプル＋日次別カウント |
| 92b7e35 | UUIDごとの入室回数「(N回目)」導入 |
| （初期） | GitHub Actions版→Cloudflare Worker版へ移行 |

`git log --oneline` で全 40+ コミット参照可。

## 8. 既知のトラブルと対処法（再発しやすい）

### 8-1. 「毎分同じ通知が降ってくる」= CPU/write 上限超過
最頻の障害。busy な cron tick が Free 枠の **10ms CPU** か **1000 write/日**
に当たり、`env.STATE.put` 到達前に kill → KV が古いまま → 毎 tick 同じ差分を
再検知。対策は導入済み（dirty フラグ / index 抽出 / サンプル削減）だが、
**サンプリングを増やすと再発する**。`wrangler tail` で `Exceeded CPU Limit`
が出ていないか、`elapsed < 30s` かを必ず確認。健全な idle tick のログ:
```
samples=4 1p/1r, rooms=1, notified=0, writes=0, skipped=1, elapsed=22s
```

### 8-2. 滞在時間の巻き戻し
バグ期間中に session が水増しされたら KV の `totalMs[uuid]` を直接編集。
実例（このチャットで実施）: 2b276298 を 1h39m→1h12m 等。手順は SKILL.md の
「KV state schema」の put コマンド参照。

### 8-3. wrangler が動かない
- `Requires Node v16+`: v10 を拾ってる。Node 20 を明示。
- `Failed to fetch auth token: 400` / `Not logged in`: 再ログイン（3-1）。

## 9. ユーザーの好み・決定事項（Claude への申し送り）

- **通知は 4 トランジションのみ**。中間の出入り（1→2 等）は通知しない。
- **💨「一瞬の出入り」カウンタは撤去済**。復活させない。
- **自動 UUID 名前付けは OFF**（チャット投稿タイミングが不正確なため）。
  名前は必ず手動 bind。
- 色は日本語ラベルで（オレンジ/青/赤/黄/緑/エメグリ/グレー/黒 等）。
  「橙」ではなく「オレンジ」表記。
- (N回目) = **その日何回入っても 1**、別日に入ったら +1（日数カウント）。
- bind 依頼は「<uuid先頭> <色><名前>（補足）」形式で来る。色hex に変換して bind。
- 返信は日本語、簡潔に。デプロイ→tail確認→commit&push まで一気にやる。

## 10. 未処理・保留

- **アプリのシャドウバン部屋 `69c286cb7c328a1b32eca492`（「…完全に興味ナイナイ…」）**:
  URL は判明済みだが、iOS アプリで直接開く手段は**存在しないと結論**
  （Universal Link / URL scheme / OneLink 全て不可）。中の人に招待して
  もらうのが唯一の現実解。深掘り保留中（Console.app / IPA解析の話が途中）。
- 特に他の未完タスクは無し。Worker は正常稼働中（最終確認 `elapsed 22〜24s`）。
