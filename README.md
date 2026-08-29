# Discordデジタル商品 配布ボット（PayPay受取リンク・手動受取確認型）

これは、自分が販売権を持つ動画・PDF・画像素材などをDiscordで配布するためのCloudflare Workerです。

## 重要な安全上の仕様

- PayPay受取リンクは、購入者がDiscordのモーダルに貼り付けます。
- リンクはAES-GCMで暗号化してD1に保存します。ログ、監査記録、購入者への返信には出力しません。
- `OWNER_DISCORD_ID` と一致する管理者だけが、注文通知DMまたは `/claim` で一時的に確認できます。
- PayPayアプリで**管理者本人が金額と受取完了を確認した後だけ** `/approve` を実行します（金額入力は不要です）。
- `/approve` 成功後、購入者へ期限付きの動画受取ボタンをBotがDM送信します。
- 承認・取消・期限切れの時点で、保存していた受取リンクの暗号文も削除します。
- **PayPayリンクのパスワード、PayPayログイン情報、暗証番号を入力・保存・送信する欄はありません。**
- PayPay受取操作や金額判定を自動化しません。個人間送金の受取をボットに委ねる設計は安全ではないためです。
- WorkerはPayPayリンク先を読み取らず、PayPayアカウントへログインもしません。管理者がPayPayアプリで受取完了を確認した後にだけ `/approve` を実行します。
- 販売価格は商品登録時に固定され、承認時の金額入力は不要です。BotはPayPayの実際の受取状況を自動判定しません。

## 注文の安全性と運用上の前提

- 注文作成時に、商品名・価格・R2の配布ファイル・ファイル名・ダウンロード回数を保存します。後から商品設定を変更しても、すでに作成された注文の条件は変わりません。
- 同じ購入者が同じ商品について未処理の注文を複数作ることはできません。承認・取消・期限切れになると次の注文を作れます。
- PayPayリンクの確認期限は30分です。期限切れ、取消、承認のいずれでも暗号化済みリンクを削除します。
- Discordの同一操作が再送されても、操作IDを記録して重複注文・重複承認を防ぎます。Discord署名は5分より古いものも受け付けません。
- ダウンロードURLは10分間のみ有効です。R2の配布ファイルは公開せず、Worker経由で最大回数を原子的に消費します。

この方式は「受取操作は管理者が手動で行う」ことを前提としています。Workerが確認できるのは、**管理者が入力した確認額が、注文時に固定された商品価格と一致しているか**だけです。購入者のリンクを一般チャンネル、DM、外部フォーム、ログへ転載しないでください。

## 購入者の流れ

1. 販売チャンネルの商品一覧から動画を選ぶ。
2. 表示されたフォームにPayPayの受取リンクだけを貼る。
3. 管理者の確認後、BotのDMに届く「動画を受け取る」ボタンを押す。

## 管理者の流れ

1. Botの管理者DMで、注文番号・商品・金額・PayPay受取リンクを確認する。
2. PayPayで受取完了を確認する。
3. 販売チャンネルで `/approve order:注文番号` を実行する。購入者にはBotから動画受取ボタンがDMで届きます。
5. 誤送信・期限切れは `/cancel order:注文番号` を実行する。

`/claim`、`/approve`、`/cancel`、`/pending` は設定済みの管理者IDだけが、同じ販売サーバー内の管理チャンネルから実行できます。購入者は `/status order:注文番号` で自分の注文状態だけを確認できます。受取リンクは管理者DMへ送信され、注文通知DMが届かない場合だけ `/claim` で確認できます。

## セットアップ

### 1. Cloudflareリソース

```bash
npx wrangler d1 create discord-digital-delivery
npx wrangler r2 bucket create discord-digital-products
npx wrangler d1 execute discord-digital-delivery --remote --file=./migrations/0001_orders.sql
npx wrangler d1 execute discord-digital-delivery --remote --file=./migrations/0002_order_integrity.sql
```

作成されたD1のIDを`wrangler.toml`の`database_id`へ設定します。R2には、`src/catalog.js`で指定した`objectKey`と同じキーで販売ファイルをアップロードします。Worker名は、すでに作成済みの`discord-digital-deriver`に合わせています。

### 2. シークレット

以下はWorkerにだけ登録します。Discordのメッセージ・GitHub・ソースファイルには貼り付けません。

```bash
npx wrangler secret put DISCORD_APPLICATION_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put OWNER_DISCORD_ID
npx wrangler secret put SALES_GUILD_ID
npx wrangler secret put SALES_CHANNEL_ID
npx wrangler secret put PAYPAY_LINK_ENCRYPTION_KEY
npx wrangler secret put PRODUCT_DOWNLOAD_SIGNING_KEY
```

`PAYPAY_LINK_ENCRYPTION_KEY`は32バイトのランダム値をbase64url形式にしたものです。`PRODUCT_DOWNLOAD_SIGNING_KEY`は32文字以上のランダム文字列にします。
`SALES_GUILD_ID`は販売を許可するDiscordサーバー、`SALES_CHANNEL_ID`は販売用チャンネルです。未設定では販売操作を受け付けないため、別サーバーで誤ってリンクを送ることを防げます。

### 3. デプロイとDiscord設定

```bash
npm run check
npx wrangler deploy
```

デプロイ後のHTTPS URLを`PUBLIC_BASE_URL`に設定して再デプロイします。Discord Developer Portalの **Interactions Endpoint URL** には次を設定します。

```
https://あなたのWorkerのURL/discord/interactions
```

開発用サーバーのIDを環境変数に指定して、コマンドを登録します。

```bash
DISCORD_APPLICATION_ID="..." DISCORD_BOT_TOKEN="..." DISCORD_GUILD_ID="..." npm run register-commands
```

## 販売前チェック

- `src/catalog.js`の価格・ファイル名・R2キーを実商品に合わせた。
- R2に対象ファイルをアップロードした。
- テスト用Discordアカウントで、商品選択 → 管理者DM → `/approve` → BotのDMボタン受取を確認した。
- `npm run check` が成功し、`/pending`、`/status`、期限切れ注文、重複承認も確認した。
- 購入ページに価格、配布時期、返金条件、問い合わせ先、販売者情報、利用規約を明記した。
- Discordロールで一般利用者に管理コマンドを使わせないのではなく、Worker側の`OWNER_DISCORD_ID`照合で拒否できることを確認した。

## 運用上の注意

PayPay受取リンクは金銭を受け取れる情報です。購入者のリンクを一般チャンネル、DM、サポートチケット、外部のフォーム通知へ転載しないでください。`/claim`は管理者本人のDiscordアカウントから、PayPayの受取確認を行う直前だけ使います。

この仕組みは、正規に販売できる自作・許諾済みのデジタルコンテンツだけに使用してください。
