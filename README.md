# Stripe自動販売・R2動画配布

自分が正規に販売できる動画・PDF・画像などを、**支払い確認から受取まで自動化**するCloudflare Workerです。

購入者は販売者から届いた商品リンクを開き、Stripe Checkoutで支払います。支払いが確定すると同じ画面に受取ボタンが表示され、R2の非公開ファイルを期限付きリンクから受け取れます。販売者のDiscord操作、入金確認、ファイルのダウンロード・再送は必要ありません。

## 購入者の流れ

1. Xなどで届いた商品リンクを開く。
2. Stripe Checkoutで表示金額を支払う。
3. 決済完了画面で「動画を受け取る」を押す。

ダウンロードリンクの有効期限は15分、受取上限は商品ごとに3回です。

## 販売者の流れ

1. 販売ページ `/` を開く。
2. 販売したい動画を選び、表示された商品ページURLをXで送る。
3. 以後の決済・配布は自動です。

販売URLは `https://discord-digital-deriver.n-yu1791.workers.dev/` です。動画の追加・削除はR2の `products/ロリ/` 以下で行います。1本ごとの価格は現在2,000円です。

## Stripe設定

Stripe DashboardでAPIキーを作成し、次の2つをWorkerのシークレットに登録します。

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

次にStripe DashboardのWebhookエンドポイントへ、以下を登録します。

```
https://discord-digital-deriver.n-yu1791.workers.dev/stripe/webhook
```

受信イベントは次の2つです。

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

Webhook署名が正しいイベントだけを受け付けます。購入者のブラウザが決済完了画面に戻った際も、WorkerがStripeへ決済状況を照会するため、Webhookの到着が少し遅れてもそのまま配布できます。

## デプロイ

既存のD1へ新しいテーブルを追加してからデプロイします。

```bash
npx wrangler d1 execute discord-digital-delivery --remote --file=./migrations/0003_stripe_checkout.sql
npm run check
npx wrangler deploy
```

## 注意

- Stripeのキー、Webhook署名シークレット、R2の認証情報をX・Discord・GitHubへ貼らないでください。
- Stripeをテストモードで確認してから本番キーへ切り替えてください。
- 旧Discord/PayPay販売パネルは、新規注文を受け付けない案内に自動置換されます。
- この仕組みは、正規に販売できる自作・許諾済みのデジタルコンテンツだけに使用してください。
