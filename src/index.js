import { findProduct } from "./catalog.js";

const DISCORD_PING = 1;
const DISCORD_APPLICATION_COMMAND = 2;
const DISCORD_MODAL_SUBMIT = 5;
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE = 4;
const RESPONSE_MODAL = 9;
const EPHEMERAL = 1 << 6;
const ORDER_TTL_MS = 30 * 60 * 1000;
const DOWNLOAD_TTL_SECONDS = 10 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/download") {
      return handleDownload(request, env, url);
    }

    if (request.method !== "POST" || url.pathname !== "/discord/interactions") {
      return new Response("Not found", { status: 404 });
    }

    try {
      const interaction = await verifyDiscordInteraction(request, env);
      return handleInteraction(interaction, env);
    } catch (error) {
      // Never log a submitted receive-link or any Discord interaction body.
      console.error("Interaction rejected or failed", error instanceof Error ? error.message : "unknown error");
      return new Response("Bad request", { status: 400 });
    }
  },
};

async function handleInteraction(interaction, env) {
  if (interaction.type === DISCORD_PING) {
    return json({ type: RESPONSE_PONG });
  }

  if (!isAllowedSalesContext(interaction, env)) {
    return ephemeral("この販売ボットは指定された販売チャンネルでのみ利用できます。");
  }

  if (interaction.type === DISCORD_APPLICATION_COMMAND) {
    return handleCommand(interaction, env);
  }

  if (interaction.type === DISCORD_MODAL_SUBMIT) {
    return handlePaymentLinkSubmission(interaction, env);
  }

  return ephemeral("この操作には対応していません。");
}

async function handleCommand(interaction, env) {
  const command = interaction.data?.name;
  if (command === "buy") return openPaymentModal(interaction);
  if (command === "claim") return claimPaymentLink(interaction, env);
  if (command === "approve") return approveOrder(interaction, env);
  if (command === "cancel") return cancelOrder(interaction, env);
  if (command === "download") return createDownloadLink(interaction, env);
  return ephemeral("未知のコマンドです。");
}

function openPaymentModal(interaction) {
  const productId = optionValue(interaction, "product");
  const product = findProduct(productId);
  if (!product) return ephemeral("商品が見つかりません。商品一覧からもう一度選んでください。");

  return json({
    type: RESPONSE_MODAL,
    data: {
      custom_id: `paypay-receive-link:${product.id}`,
      title: `お支払い：${product.title}`,
      components: [
        actionRow(textInput(
          "paypay_receive_link",
          "PayPay受取リンク",
          "[PayPay] 受取リンクの全文、または https://pay.paypay.ne.jp/... を貼り付け",
          2,
          true,
          20,
          512,
        )),
      ],
    },
  });
}

async function handlePaymentLinkSubmission(interaction, env) {
  const customId = interaction.data?.custom_id ?? "";
  const productId = customId.startsWith("paypay-receive-link:")
    ? customId.slice("paypay-receive-link:".length)
    : "";
  const product = findProduct(productId);
  if (!product) return ephemeral("商品情報を確認できませんでした。もう一度 /buy からやり直してください。");

  const submitted = modalValue(interaction, "paypay_receive_link");
  const receiveLink = extractPayPayReceiveLink(submitted);
  if (!receiveLink) {
    return ephemeral("PayPayの受取リンクを確認できませんでした。pay.paypay.ne.jp のリンクをそのまま貼り付けてください。");
  }

  const buyerId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!buyerId) return ephemeral("購入者情報を確認できませんでした。");

  const now = new Date();
  const recentOrder = await env.DB.prepare(
    `SELECT code FROM orders
       WHERE buyer_discord_id = ?
         AND product_id = ?
         AND status = 'awaiting_manual_acceptance'
         AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
  ).bind(buyerId, product.id, new Date(now.getTime() - 15 * 60 * 1000).toISOString()).first();

  if (recentOrder?.code) {
    return ephemeral(`同じ商品の未処理注文があります（注文番号：${recentOrder.code}）。受取リンクの期限が切れた場合は、管理者へ取り消しを依頼してから再注文してください。`);
  }

  const orderId = crypto.randomUUID();
  const code = createOrderCode();
  const expiresAt = new Date(now.getTime() + ORDER_TTL_MS).toISOString();
  const ciphertext = await encryptReceiveLink(receiveLink, env.PAYPAY_LINK_ENCRYPTION_KEY);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO orders (
        id, code, buyer_discord_id, guild_id, product_id, status,
        paypay_receive_link_ciphertext, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'awaiting_manual_acceptance', ?, ?, ?)`,
    ).bind(orderId, code, buyerId, interaction.guild_id ?? null, product.id, ciphertext, now.toISOString(), expiresAt),
    auditStatement(env, orderId, buyerId, "payment_link_submitted", { productId: product.id }),
  ]);

  return ephemeral(
    `注文を受け付けました。\n注文番号：**${code}**\n商品：${product.title}（${formatYen(product.priceYen)}）\n` +
      `管理者がPayPayで受取確認後、/download order:${code} で受け取れます。\n` +
      "重要：リンクのパスワード・PayPayの暗証番号・ログイン情報は送らないでください。",
  );
}

async function claimPaymentLink(interaction, env) {
  const denied = requireOwner(interaction, env);
  if (denied) return denied;
  const order = await orderByCode(env, optionValue(interaction, "order"));
  if (!order) return ephemeral("注文が見つかりません。");
  if (order.status !== "awaiting_manual_acceptance") return ephemeral(`この注文は ${order.status} 状態です。`);
  if (Date.parse(order.expires_at) <= Date.now()) {
    await expireOrder(env, order.id);
    return ephemeral("この注文の確認時間（30分）が切れました。購入者に新しい受取リンクを送ってもらってください。");
  }

  const ownerId = interaction.member?.user?.id ?? interaction.user?.id;
  const link = await decryptReceiveLink(order.paypay_receive_link_ciphertext, env.PAYPAY_LINK_ENCRYPTION_KEY);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders
         SET claimed_at = COALESCE(claimed_at, ?), claimed_by_discord_id = COALESCE(claimed_by_discord_id, ?)
       WHERE id = ?`,
    ).bind(new Date().toISOString(), ownerId, order.id),
    auditStatement(env, order.id, ownerId, "payment_link_revealed_to_owner", {}),
  ]);

  const product = findProduct(order.product_id);
  return ephemeral(
    `注文：${order.code}\n商品：${product?.title ?? order.product_id}\n確認額：${formatYen(product?.priceYen ?? 0)}\n\n` +
      `受取リンク（管理者だけに表示）：\n<${link}>\n\n` +
      "PayPayアプリで金額と受取完了を確認してから、/approve order:注文番号 を実行してください。",
  );
}

async function approveOrder(interaction, env) {
  const denied = requireOwner(interaction, env);
  if (denied) return denied;
  const order = await orderByCode(env, optionValue(interaction, "order"));
  if (!order) return ephemeral("注文が見つかりません。");
  if (order.status !== "awaiting_manual_acceptance") return ephemeral(`この注文は ${order.status} 状態です。`);
  if (!order.claimed_at) return ephemeral("先に /claim で受取リンクを確認し、PayPayで受取完了を確認してください。");
  if (Date.parse(order.expires_at) <= Date.now()) {
    await expireOrder(env, order.id);
    return ephemeral("確認期限が切れています。承認できません。");
  }

  const ownerId = interaction.member?.user?.id ?? interaction.user?.id;
  const result = await env.DB.prepare(
    `UPDATE orders
       SET status = 'approved', approved_at = ?, approved_by_discord_id = ?, paypay_receive_link_ciphertext = ''
     WHERE id = ? AND status = 'awaiting_manual_acceptance' AND claimed_at IS NOT NULL`,
  ).bind(new Date().toISOString(), ownerId, order.id).run();

  if (result.meta.changes !== 1) return ephemeral("この注文は別の操作で更新されました。/claim で状態を確認してください。");
  await auditStatement(env, order.id, ownerId, "delivery_approved", {}).run();
  return ephemeral(`承認しました。購入者は /download order:${order.code} で、期限付きの受取リンクを表示できます。`);
}

async function cancelOrder(interaction, env) {
  const denied = requireOwner(interaction, env);
  if (denied) return denied;
  const order = await orderByCode(env, optionValue(interaction, "order"));
  if (!order) return ephemeral("注文が見つかりません。");
  if (order.status !== "awaiting_manual_acceptance") return ephemeral(`この注文は ${order.status} 状態です。`);
  const ownerId = interaction.member?.user?.id ?? interaction.user?.id;
  const result = await env.DB.prepare(
    "UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancelled_by_discord_id = ?, paypay_receive_link_ciphertext = '' WHERE id = ? AND status = 'awaiting_manual_acceptance'",
  ).bind(new Date().toISOString(), ownerId, order.id).run();
  if (result.meta.changes !== 1) return ephemeral("この注文は別の操作で更新されました。");
  await auditStatement(env, order.id, ownerId, "order_cancelled", {}).run();
  return ephemeral(`注文 ${order.code} を取り消しました。`);
}

async function createDownloadLink(interaction, env) {
  const order = await orderByCode(env, optionValue(interaction, "order"));
  if (!order) return ephemeral("注文が見つかりません。");
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  if (order.buyer_discord_id !== userId) return ephemeral("この注文の受取リンクは購入者本人だけが表示できます。");
  if (order.status !== "approved") return ephemeral("まだ配布可能ではありません。PayPay受取確認後に有効になります。");
  const product = findProduct(order.product_id);
  if (!product) return ephemeral("商品ファイルの設定を確認できません。管理者へ連絡してください。");
  if (order.download_uses >= product.maxDownloads) return ephemeral("この注文のダウンロード上限に達しています。必要な場合は管理者へ連絡してください。");

  const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
  const signature = await signDownload(order.id, expires, env.PRODUCT_DOWNLOAD_SIGNING_KEY);
  const link = new URL("/download", env.PUBLIC_BASE_URL);
  link.searchParams.set("order", order.id);
  link.searchParams.set("expires", String(expires));
  link.searchParams.set("sig", signature);

  return json({
    type: RESPONSE_CHANNEL_MESSAGE,
    data: {
      flags: EPHEMERAL,
      content: `受取リンクは10分間有効です。残り回数：${product.maxDownloads - order.download_uses}回`,
      components: [
        actionRow({ type: 2, style: 5, label: "動画を受け取る", url: link.toString() }),
      ],
    },
  });
}

async function handleDownload(request, env, url) {
  const orderId = url.searchParams.get("order") ?? "";
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("sig") ?? "";
  if (!isUuid(orderId) || !Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000) || signature.length < 20) {
    return new Response("This download link is invalid or expired.", { status: 403 });
  }
  const expected = await signDownload(orderId, expires, env.PRODUCT_DOWNLOAD_SIGNING_KEY);
  if (!timingSafeEqual(signature, expected)) return new Response("This download link is invalid.", { status: 403 });

  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
  const product = order ? findProduct(order.product_id) : null;
  if (!order || !product || order.status !== "approved") return new Response("This product is unavailable.", { status: 404 });
  if (order.download_uses >= product.maxDownloads) return new Response("Download limit reached.", { status: 429 });

  const object = await env.PRODUCT_ASSETS.get(product.objectKey);
  if (!object) return new Response("Product file is unavailable. Please contact support.", { status: 503 });

  const update = await env.DB.prepare(
    `UPDATE orders
       SET download_uses = download_uses + 1, last_downloaded_at = ?
     WHERE id = ? AND status = 'approved' AND download_uses < ?`,
  ).bind(new Date().toISOString(), order.id, product.maxDownloads).run();
  if (update.meta.changes !== 1) return new Response("Download limit reached.", { status: 429 });

  await auditStatement(env, order.id, null, "download_served", { requestMethod: request.method }).run();
  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename=\"${safeFilename(product.downloadName)}\"`);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (object.size != null) headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

async function verifyDiscordInteraction(request, env) {
  const signatureHex = request.headers.get("X-Signature-Ed25519") ?? "";
  const timestamp = request.headers.get("X-Signature-Timestamp") ?? "";
  if (!/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d{10,13}$/.test(timestamp)) throw new Error("Missing Discord signature");
  const body = await request.text();
  const key = await crypto.subtle.importKey("raw", hexToBytes(env.DISCORD_APPLICATION_PUBLIC_KEY), { name: "Ed25519" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key,
    hexToBytes(signatureHex),
    new TextEncoder().encode(timestamp + body),
  );
  if (!valid) throw new Error("Invalid Discord signature");
  return JSON.parse(body);
}

function extractPayPayReceiveLink(input) {
  if (typeof input !== "string" || input.length > 512) return null;
  const match = input.match(/https:\/\/pay\.paypay\.ne\.jp\/[A-Za-z0-9_-]{6,128}(?:\/?)(?!\S)/);
  if (!match) return null;
  try {
    const url = new URL(match[0]);
    if (url.protocol !== "https:" || url.hostname !== "pay.paypay.ne.jp" || url.username || url.password || url.search || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function requireOwner(interaction, env) {
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  return userId === env.OWNER_DISCORD_ID ? null : ephemeral("このコマンドは管理者専用です。");
}

function isAllowedSalesContext(interaction, env) {
  if (!env.SALES_GUILD_ID || interaction.guild_id !== env.SALES_GUILD_ID) return false;
  return !env.SALES_CHANNEL_ID || interaction.channel_id === env.SALES_CHANNEL_ID;
}

async function orderByCode(env, value) {
  const code = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(code)) return null;
  return env.DB.prepare("SELECT * FROM orders WHERE code = ?").bind(code).first();
}

async function expireOrder(env, orderId) {
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET status = 'expired', paypay_receive_link_ciphertext = '' WHERE id = ? AND status = 'awaiting_manual_acceptance'").bind(orderId),
    auditStatement(env, orderId, null, "order_expired", {}),
  ]);
}

function auditStatement(env, orderId, actorId, eventType, details) {
  return env.DB.prepare(
    "INSERT INTO order_audit_events (id, order_id, actor_discord_id, event_type, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), orderId, actorId, eventType, new Date().toISOString(), JSON.stringify(details));
}

async function encryptReceiveLink(value, encodedKey) {
  const key = await importAesKey(encodedKey, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}

async function decryptReceiveLink(payload, encodedKey) {
  const [version, ivPart, encryptedPart] = String(payload).split(".");
  if (version !== "v1" || !ivPart || !encryptedPart) throw new Error("Invalid encrypted payment-link payload");
  const key = await importAesKey(encodedKey, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64urlBytes(ivPart) },
    key,
    base64urlBytes(encryptedPart),
  );
  return new TextDecoder().decode(plaintext);
}

async function importAesKey(encodedKey, usages) {
  const keyBytes = base64urlBytes(encodedKey);
  if (keyBytes.byteLength !== 32) throw new Error("PAYPAY_LINK_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, usages);
}

async function signDownload(orderId, expires, secret) {
  if (!secret || secret.length < 32) throw new Error("PRODUCT_DOWNLOAD_SIGNING_KEY must be at least 32 characters");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${orderId}.${expires}`));
  return base64url(new Uint8Array(signature));
}

function optionValue(interaction, name) {
  return interaction.data?.options?.find((option) => option.name === name)?.value;
}

function modalValue(interaction, expectedId) {
  const rows = interaction.data?.components ?? [];
  for (const row of rows) {
    for (const component of row.components ?? []) {
      if (component.custom_id === expectedId) return component.value ?? "";
    }
  }
  return "";
}

function textInput(customId, label, placeholder, style, required, minLength, maxLength) {
  return { type: 4, custom_id: customId, label, placeholder, style, required, min_length: minLength, max_length: maxLength };
}

function actionRow(component) {
  return { type: 1, components: [component] };
}

function ephemeral(content) {
  return json({ type: RESPONSE_CHANNEL_MESSAGE, data: { flags: EPHEMERAL, content } });
}

function json(value) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json; charset=UTF-8" } });
}

function createOrderCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(random, (byte) => alphabet[byte % alphabet.length]).join("");
}

function hexToBytes(value) {
  if (typeof value !== "string" || !/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) throw new Error("Invalid hexadecimal value");
  return Uint8Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64urlBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url value");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function timingSafeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeFilename(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "download";
}

function formatYen(value) {
  return `${Number(value).toLocaleString("ja-JP")}円`;
}
