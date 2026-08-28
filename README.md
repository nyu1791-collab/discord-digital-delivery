# Discordデジタル商品 配布ボット（PayPay受取リンク・手動受取確認型）

これは、自分が販売権を持つ動画・PDF・画像素材などをDiscordで配布するためのCloudflare Workerです。

## 重要な安全上の仕様

- PayPay受取リンクは、購入者がDiscordのモーダルに貼り付けます。
- リンクはAES-GCMで暗号化してD1に保存します。ログ、監査記録、購入者への返信には出力しません。
- `OWNER_DISCORD_ID` と一致する管理者だけが `/claim` で一時的に確認できます。
- PayPayアプリで**管理者本人が金額と受取完了を確認した後だけ** `/approve` を実行します。
- 承認後、購入者は `/download` で短時間だけ有効な受取リンクを取得できます。
- 承認・取消・期限切れの時点で、保存していた受取リンクの暗号文も削除します。
- **PayPayリンクのパスワード、PayPayログイン情報、暗証番号を入力・保存・送信する欄はありません。**
- PayPay受取操作や金額判定を自動化しません。個人間送金の受取をボットに委ねる設計は安全ではないためです。

## 購入者の流れ

1. `/buy product:サンプル動画` を実行する。
2. 表示されたフォームにPayPayの受取リンクだけを貼る。
3. 表示された注文番号を控える。
4. 管理者の受取確認後、`/download order:注文番号` を実行する。

## 管理者の流れ

1. `#管理`などの管理チャンネルで `/claim order:注文番号` を実行する。
2. 自分だけに表示されたリンクをPayPayアプリで開き、商品価格と受取完了を確認する。
3. `/approve order:注文番号` を実行する。
4. 誤送信・期限切れは `/cancel order:注文番号` を実行する。

`/buy` と `/download` は販売用チャンネルでのみ実行できます。`/claim`、`/approve`、`/cancel` は設定済みの管理者IDだけが、同じ販売サーバー内の管理チャンネルから実行できます。受取リンクは管理者へ一度だけ表示されます。

## セットアップ

### 1. Cloudflareリソース

```bash
npx wrangler d1 create discord-digital-delivery
npx wrangler r2 bucket create discord-digital-products
npx wrangler d1 execute discord-digital-delivery --remote --file=./migrations/0001_orders.sql
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
- テスト用Discordアカウントで、`/buy` → `/claim` → `/approve` → `/download` を確認した。
- 購入ページに価格、配布時期、返金条件、問い合わせ先、販売者情報、利用規約を明記した。
- Discordロールで一般利用者に管理コマンドを使わせないのではなく、Worker側の`OWNER_DISCORD_ID`照合で拒否できることを確認した。

## 運用上の注意

PayPay受取リンクは金銭を受け取れる情報です。購入者のリンクを一般チャンネル、DM、サポートチケット、外部のフォーム通知へ転載しないでください。`/claim`は管理者本人のDiscordアカウントから、PayPayの受取確認を行う直前だけ使います。

この仕組みは、正規に販売できる自作・許諾済みのデジタルコンテンツだけに使用してください。
