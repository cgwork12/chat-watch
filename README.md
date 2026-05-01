# randomchat-room watcher

randomchat.pnyo.jp のグループ通話で、**ルーム ID** または **タイトル完全一致**で指定したルームを監視し、以下 4 つのタイミングだけ Discord / Slack に Webhook 通知を飛ばす：

- 🟢 **started**: 0 → 1 以上（誰もいなかった部屋に人が入って通話開始）
- 🔴 **becameFull**: 人数 < 上限 → 上限到達（満室になった）
- 🟡 **opened**: 満室 → 上限未満（空きが出た）
- ⚫ **ended**: 1 人以上 → 0 人（通話終了・空室化）

途中の入退出（1→2、3→2 等）は通知しない。

## 2 つの実装

このリポには同じロジックの **2 つのランタイム実装**が入っている：

| 実装 | cron 粒度 | 信頼性 | 場所 |
|------|----------|--------|------|
| GitHub Actions（旧） | `*/5 * * * *` | best-effort、実測 20〜25 分間隔まで遅延あり | `scripts/watch.mjs` + `.github/workflows/watch.yml` |
| **Cloudflare Worker（推奨）** | `*/1 * * * *` | 1 分粒度で安定 | `worker/` |

**GitHub Actions 版は無料 public リポでは scheduled workflow が間引きされる**実装上の問題がある（公式の "best-effort" 仕様）。早く・確実に通知が欲しいなら Cloudflare Worker 版へ移行を推奨。両方同時に動かすと通知が二重に飛ぶので、移行後は片方を無効化すること。

## セットアップ

1. このディレクトリの中身を GitHub の **public リポジトリ**に push する  
   （private だと月 2000 分のキャップで回らなくなる可能性あり）

2. Webhook URL を用意する
   - **Discord**: 対象チャンネル右クリック → サーバー設定 → 連携サービス → ウェブフック → 新しいウェブフック → URL コピー
   - **Slack**: <https://api.slack.com/messaging/webhooks> で Incoming Webhook アプリを追加

3. リポジトリの Settings で以下を設定
   - **Secrets** → Repository secrets → `New repository secret`
     - `WEBHOOK_URL` = コピーした Webhook URL
   - **Variables** → Repository variables → `New repository variable`
     - `WEBHOOK_TYPE` = `discord` または `slack`
     - **`TARGET_ID` または `TARGET_TITLE` のどちらか**
       - `TARGET_ID`（推奨）: アプリのルーム URL `https://randomchat.pnyo.jp/groupcall/<ID>` の `<ID>` 部分。タイトルが書き換わる部屋でも安定して追跡可能
       - `TARGET_TITLE`: ルーム名の完全一致（改行・絵文字込み）。タイトルが変わると追跡失敗
       - 両方セットされている場合は `TARGET_ID` が優先される
     - `MAX_PAGES` = `80`（任意、未設定でも動く）

4. Actions タブで `watch-groupcall` を有効化（初回は手動で有効化が必要）
5. `Run workflow` から `workflow_dispatch` で手動実行 → ログで以下を確認
   - `watch mode: id=...` または `watch mode: title="..."`
   - `scanned N pages (M rooms), matched=X, notified=Y`
   - `chore: update state` のコミットが生成される

## ローカルでの smoke test

```bash
# ID 監視
TARGET_ID='<24桁の_id>' DRY_RUN=1 node scripts/watch.mjs

# タイトル監視
TARGET_TITLE='<タイトル>' DRY_RUN=1 node scripts/watch.mjs
```

`DRY_RUN=1` で Webhook は叩かず、通知メッセージを stdout に吐く。`state.json` は実際に更新される。

## 挙動メモ

- 「現在の人数」は `callUserIds.length` を正本として扱う（API の `callNum` フィールドではなく実際のユーザー UUID 配列の長さ）
- 通知が飛ぶのは次の 4 ケースのみ（同時成立する遷移は優先度の高い方を採用）
  - 🟢 **`started`**: 前回 0 人 → 今回 1 人以上
  - 🔴 **`becameFull`**: 前回 < 上限 → 今回 上限到達
  - 🟡 **`opened`**: 前回が満室 → 今回 上限未満（1 人以上残ってる）
  - ⚫ **`ended`**: 前回 1 人以上 → 今回 0 人
  - 優先度: `ended` > `becameFull` > `started` > `opened`（例: 0→満室 は `becameFull` のみ、満室→0 は `ended` のみ通知）
- それ以外のトランジション（1→2、3→1、2→2、満室維持 など）は通知しない
- 初めて見つけたルーム（state に未登録）は記録のみ。通知は次回以降の差分から
- 同じタイトルの部屋が複数あれば、全てに対して個別判定 & 個別通知
- 24 時間以上見かけなかったルームは state から自動削除
- cron は `*/5 * * * *`（GitHub の最小間隔）。実際の発火は 5〜15 分ずれることあり

## カスタマイズしやすい環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `TARGET_ID` | `TARGET_TITLE` とどちらか必須 | 監視対象ルームの `_id`（推奨）。指定時はタイトルチェックは無視、見つけ次第ページング打ち切り |
| `TARGET_TITLE` | `TARGET_ID` とどちらか必須 | 監視対象タイトル（完全一致）。同名ルーム複数あれば全てに通知 |
| `WEBHOOK_URL` | **必須**（DRY_RUN 時除く） | 通知先 |
| `WEBHOOK_TYPE` | `discord` | `discord` / `slack` |
| `MAX_PAGES` | `80` | 1 回の実行で舐める最大ページ数 |
| `PAGE_DELAY_MS` | `250` | ページ取得間のスリープ |
| `STATE_PATH` | `state.json` | state ファイル |
| `DRY_RUN` | なし | `1` にすると Webhook を叩かず stdout 出力 |

## 既知の制約

- タイトルに `※3人目❌` のような状態表記を含むルームは、入退出のたびに作成者が書き換えるため完全一致が破れる場合あり。ブレない固定文字列のタイトルを監視するのが堅い
- LINE Notify は 2025-03-31 に終了済みのため非対応
- GitHub Actions の cron は best-effort（ピーク時遅延あり）

---

## Cloudflare Worker 版へ移行（1 分粒度）

GitHub Actions の cron 遅延（実測 20〜25 分間隔）が気になる場合は Cloudflare Worker に切り替える。  
無料枠で十分（100k リクエスト/日 + KV 100k 読み 1k 書き/日）。

### セットアップ

```bash
cd worker
npm install                                     # wrangler を入れる
npx wrangler login                              # ブラウザでログイン（カード不要、無料アカウント可）
npx wrangler kv namespace create STATE          # 出力された id を控える
npx wrangler kv namespace create STATE --preview # preview_id を控える
```

`worker/wrangler.toml` を編集：
- `[[kv_namespaces]]` の `id` と `preview_id` を上で控えた値に置き換え
- `[vars]` の `TARGET_ID` を監視対象のルーム ID に（または `TARGET_TITLE`）

シークレットを設定：
```bash
npx wrangler secret put WEBHOOK_URL    # Discord webhook URL を貼る
# 任意: npx wrangler secret put RUN_TOKEN  # POST /run の手動実行を許可するトークン
```

デプロイ：
```bash
npx wrangler deploy
```

### 動作確認

```bash
npx wrangler tail   # ライブログを見る
```

ログに次の行が 1 分毎に出る：
```
scanned N pages (M rooms), matched=1, notified=Y, elapsed=Xs
```

### GitHub Actions 版を停止

Worker 版で通知が来ているのを確認したら、GH Actions 版を止めて二重通知を防ぐ：

リポの Settings → Actions → General → "Disable actions" にするか、もしくは
リポの `.github/workflows/watch.yml` の先頭を以下に変更して push：

```yaml
on:
  workflow_dispatch: {}   # cron トリガーを外して手動実行のみに
```

### 環境変数早見表（Worker 版）

| 名前 | 種別 | デフォルト | 内容 |
|------|------|-----------|------|
| `WEBHOOK_URL` | secret | **必須** | Discord/Slack の Webhook URL |
| `WEBHOOK_TYPE` | var | `discord` | `discord` / `slack` |
| `TARGET_ID` | var or secret | `TARGET_TITLE` とどちらか必須 | 24 桁 ObjectId |
| `TARGET_TITLE` | var | `TARGET_ID` とどちらか必須 | タイトル完全一致 |
| `MAX_PAGES` | var | `80` | 1 回の poll で舐める最大ページ数 |
| `RUN_TOKEN` | secret | (任意) | POST /run の Bearer 認証用 |

### UID 捕獲モード（一時的に全入退室を通知）

普段は上の 4 トランジションだけ通知するが、**自分の UUID を特定したい時**などに、一時的に「入退室を全部・フル UUID で通知する」モードに切り替えられる。

```bash
# 30 分だけ捕獲モード ON（デフォルト 30 分、最大 1440 分）
node scripts/capture.mjs on
node scripts/capture.mjs on 60     # 60 分

# 状態確認
node scripts/capture.mjs status

# 早めに OFF
node scripts/capture.mjs off
```

仕組み：
- KV に `mode:capture` キーを TTL 付きで書く
- Worker は毎 cron 実行前に存在チェック → ON なら捕獲モード分岐
- TTL 経過で自動消滅（つけっぱなし防止）

捕獲モード時の通知フォーマット例：
```
🔍 [UID捕獲モード] 「ながら雑談」 3/5 → 4/5
+ 入室: 5e3c9ad9-6799-4b1a-930e-1413359f30f4
👥 全員:
  119a30b3-d725-49a4-aaed-dbd0d0561eba
  5c9f6f48-64e8-40ab-a48b-0f1dec11abb6
  26c6ec94-26d1-4620-90da-e82a8dfd256e
  5e3c9ad9-6799-4b1a-930e-1413359f30f4
https://randomchat.pnyo.jp/groupcall/...
```

通常モードでは `+ 入室` / `- 退室` 系の細かい通知は出ず、4 トランジションだけ。
