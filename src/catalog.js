// 商品情報はR2の商品フォルダから読み込みます。購入者が入力した金額は信用しません。
export const PRODUCTS = Object.freeze([
  Object.freeze({ id: "sample-video", title: "サンプル動画", priceYen: 500, objectKey: "products/sample-video.mp4", downloadName: "sample-video.mp4", maxDownloads: 3 }),
]);

export function isVideoObjectKey(key) {
  return typeof key === "string" && /\.(?:mp4|m4v|mov|webm|avi|mkv)$/iu.test(key);
}

export function productIdForObjectKey(objectKey) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(String(objectKey))) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `r2-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function productFromObject(object, priceYen = 2000, maxDownloads = 3) {
  const objectKey = String(object?.key ?? "");
  if (!isVideoObjectKey(objectKey) || !Number.isSafeInteger(priceYen) || priceYen < 1) return null;
  const slash = objectKey.lastIndexOf("/");
  const downloadName = objectKey.slice(slash + 1);
  if (!downloadName) return null;
  return Object.freeze({ id: productIdForObjectKey(objectKey), title: downloadName, priceYen, objectKey, downloadName, maxDownloads });
}

export function findProduct(productId) {
  return PRODUCTS.find((product) => product.id === productId) ?? null;
}

export const DISCORD_COMMANDS = Object.freeze([
  { name: "buy", description: "商品を選び、PayPay受取リンクを送信します", type: 1 },
  { name: "shop", description: "購入画面を開きます（buyの簡単版）", type: 1 },
  { name: "panel", description: "管理者用：購入ボタンを販売チャンネルに設置します", type: 1 },

  { name: "claim", description: "管理者用：受取リンクを一度だけ表示します", type: 1, options: [{ name: "order", description: "注文番号", type: 3, required: true }] },
  { name: "approve", description: "管理者用：PayPay受取確認後に配布を有効化します", type: 1, options: [
    { name: "order", description: "注文番号", type: 3, required: true },
    { name: "amount", description: "PayPayで実際に受け取った金額（円）", type: 4, required: true, min_value: 1 },
  ] },
  { name: "cancel", description: "管理者用：未承認の注文を取り消します", type: 1, options: [{ name: "order", description: "注文番号", type: 3, required: true }] },
  { name: "pending", description: "管理者用：未処理注文の一覧を表示します", type: 1 },
  { name: "status", description: "自分の注文状況を表示します", type: 1, options: [{ name: "order", description: "あなたの注文番号", type: 3, required: true }] },
  { name: "download", description: "承認済み商品の受取リンクを表示します", type: 1, options: [{ name: "order", description: "あなたの注文番号", type: 3, required: true }] },
]);
