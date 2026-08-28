import assert from "node:assert/strict";
import test from "node:test";
import { __testables } from "../src/index.js";

const {
  extractPayPayReceiveLink,
  isFreshDiscordTimestamp,
  isUuid,
  normalizeDeliveryTerms,
  safeFilename,
  timingSafeEqual,
} = __testables;

test("PayPay受取リンクだけを正規化して取り出す", () => {
  assert.equal(
    extractPayPayReceiveLink("[PayPay] 受取リンク https://pay.paypay.ne.jp/AbcD_123456"),
    "https://pay.paypay.ne.jp/AbcD_123456",
  );
});

test("文末の日本語句読点があってもPayPay受取リンクを取り出す", () => {
  assert.equal(
    extractPayPayReceiveLink("こちらです。https://pay.paypay.ne.jp/AbcD_123456。"),
    "https://pay.paypay.ne.jp/AbcD_123456",
  );
});

test("偽装ホストのPayPay風リンクを拒否する", () => {
  assert.equal(extractPayPayReceiveLink("https://pay.paypay.ne.jp.example/AbcD_123456"), null);
  assert.equal(extractPayPayReceiveLink("https://paypay.ne.jp/AbcD_123456"), null);
});

test("クエリ・フラグメント・認証情報付きリンクを拒否する", () => {
  assert.equal(extractPayPayReceiveLink("https://pay.paypay.ne.jp/AbcD_123456?token=x"), null);
  assert.equal(extractPayPayReceiveLink("https://pay.paypay.ne.jp/AbcD_123456#x"), null);
  assert.equal(extractPayPayReceiveLink("https://user@pay.paypay.ne.jp/AbcD_123456"), null);
});

test("Discord署名タイムスタンプの鮮度を検査する", () => {
  const now = 1_800_000_000_000;
  assert.equal(isFreshDiscordTimestamp("1800000000", now), true);
  assert.equal(isFreshDiscordTimestamp("1800000000000", now), true);
  assert.equal(isFreshDiscordTimestamp("1799999699", now), false);
  assert.equal(isFreshDiscordTimestamp("1800000061", now), false);
});

test("注文条件スナップショットを厳密に検証する", () => {
  assert.deepEqual(normalizeDeliveryTerms({
    product_title: "動画",
    price_yen: 500,
    object_key: "products/movie.mp4",
    download_name: "movie.mp4",
    max_downloads: 3,
  }), {
    productTitle: "動画",
    priceYen: 500,
    objectKey: "products/movie.mp4",
    downloadName: "movie.mp4",
    maxDownloads: 3,
  });
  assert.equal(normalizeDeliveryTerms({
    product_title: "動画",
    price_yen: 0,
    object_key: "products/movie.mp4",
    download_name: "movie.mp4",
    max_downloads: 3,
  }), null);
});

test("UUID、ファイル名、署名比較を安全に扱う", () => {
  assert.equal(isUuid("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isUuid("not-a-uuid"), false);
  // スラッシュは必ず無害な文字へ置換されるため、パスとして解釈されない。
  assert.equal(safeFilename("../../動画?.mp4"), ".._..____.mp4");
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "ab"), false);
});
