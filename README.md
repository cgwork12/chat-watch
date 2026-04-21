# randomchat-room watcher

randomchat.pnyo.jp のグループ通話で、**タイトル完全一致**で指定したルームに新規参加者があった時、Discord / Slack に Webhook 通知を飛ばす。

GitHub Actions の cron（5 分毎）で動作し、無料・Mac 非依存で 24/7 稼働する。

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
     - `TARGET_TITLE` = アプリ上のルームタイトル（完全一致、改行・絵文字込み）
     - `MAX_PAGES` = `80`（任意、未設定でも動く）

4. Actions タブで `watch-groupcall` を有効化（初回は手動で有効化が必要）
5. `Run workflow` から `workflow_dispatch` で手動実行 → ログで以下を確認
   - `scanned N pages (M rooms), matched title=X, notified=Y, firstRun=true`
   - `chore: update state` のコミットが生成される

## ローカルでの smoke test

```bash
TARGET_TITLE='<タイトル>' DRY_RUN=1 node scripts/watch.mjs
```

`DRY_RUN=1` で Webhook は叩かず、通知メッセージを stdout に吐く。`state.json` は実際に更新される。

## 挙動メモ

- 初回実行時（state.json 空）はルーム初回発見の「既存参加者」は通知しない（`SUPPRESS_FIRST_RUN=1` がデフォルト）
- 2 回目以降、`callUserIds` に前回無かった UUID が増えたら通知
- 同じタイトルの部屋が複数あれば、全てに対して通知
- 24 時間以上見かけなかったルームは state から自動削除
- cron は `*/5 * * * *`（GitHub の最小間隔）。実際の発火は 5〜15 分ずれることあり

## カスタマイズしやすい環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `TARGET_TITLE` | **必須** | 監視対象タイトル（完全一致） |
| `WEBHOOK_URL` | **必須**（DRY_RUN 時除く） | 通知先 |
| `WEBHOOK_TYPE` | `discord` | `discord` / `slack` |
| `MAX_PAGES` | `80` | 1 回の実行で舐める最大ページ数 |
| `PAGE_DELAY_MS` | `250` | ページ取得間のスリープ |
| `STATE_PATH` | `state.json` | state ファイル |
| `DRY_RUN` | なし | `1` にすると Webhook を叩かず stdout 出力 |
| `SUPPRESS_FIRST_RUN` | `1` | `0` にすると state が空でも既存参加者を通知 |

## 既知の制約

- タイトルに `※3人目❌` のような状態表記を含むルームは、入退出のたびに作成者が書き換えるため完全一致が破れる場合あり。ブレない固定文字列のタイトルを監視するのが堅い
- LINE Notify は 2025-03-31 に終了済みのため非対応
- GitHub Actions の cron は best-effort（ピーク時遅延あり）
