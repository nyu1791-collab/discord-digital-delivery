// 商品情報はサーバー側だけで定義します。購入者が指定した金額は一切信用しません。
// 実販売前に title / priceYen / objectKey / downloadName を置き換えてください。
export const PRODUCTS = Object.freeze([
  Object.freeze({
    id: "sample-video",
    title: "サンプル動画",
    priceYen: 500,
    objectKey: "products/sample-video.mp4",
    downloadName: "sample-video.mp4",
    maxDownloads: 3,
  }),
]);

export function findProduct(productId) {
  return PRODUCTS.find((product) => product.id === productId) ?? null;
}

export const DISCORD_COMMANDS = Object.freeze([
  {
    name: "buy",
    description: "商品を選び、PayPay受取リンクを送信します",
    type: 1,
    options: [
      {
        name: "product",
        description: "購入する商品",
        type: 3,
        required: true,
        choices: PRODUCTS.map((product) => ({
          name: `${product.title}（${product.priceYen.toLocaleString("ja-JP")}円）`,
          value: product.id,
        })),
      },
    ],
  },
  {
    name: "claim",
    description: "管理者用：受取リンクを一度だけ表示します",
    type: 1,
    options: [{ name: "order", description: "注文番号", type: 3, required: true }],
  },
  {
    name: "approve",
    description: "管理者用：PayPay受取確認後に配布を有効化します",
    type: 1,
    options: [
      { name: "order", description: "注文番号", type: 3, required: true },
      { name: "amount", description: "PayPayで実際に受け取った金額（円）", type: 4, required: true, min_value: 1 },
    ],
  },
  {
    name: "cancel",
    description: "管理者用：未承認の注文を取り消します",
    type: 1,
    options: [{ name: "order", description: "注文番号", type: 3, required: true }],
  },
  {
    name: "download",
    description: "承認済み商品の受取リンクを表示します",
    type: 1,
    options: [{ name: "order", description: "あなたの注文番号", type: 3, required: true }],
  },
]);
