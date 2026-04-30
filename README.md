# randomchat-room watcher

randomchat.pnyo.jp のグループ通話で、**ルーム ID** または **タイトル完全一致**で指定したルームを監視し、以下 4 つのタイミングだけ Discord / Slack に Webhook 通知を飛ばす：

- 🟢 **started**: 0 → 1 以上（誰もいなかった部屋に人が入って通話開始）
- 🔴 **becameFull**: 人数 < 上限 → 上限到達（満室になった）
- 🟡 **opened**: 満室 → 上限未満（空きが出た）
- ⚫ **ended**: 1 人以上 → 0 人（通話終了・空室化）

途中の入退出（1→2、3→2 等）は通知しない。

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
