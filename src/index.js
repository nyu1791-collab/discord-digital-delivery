import { PRODUCTS, findProduct, isVideoObjectKey, productFromObject } from "./catalog.js";

const DISCORD_PING = 1;
const DISCORD_APPLICATION_COMMAND = 2;
const DISCORD_MODAL_SUBMIT = 5;
const DISCORD_MESSAGE_COMPONENT = 3;
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE = 4;
const RESPONSE_MODAL = 9;
const EPHEMERAL = 1 << 6;
const ORDER_TTL_MS = 30 * 60 * 1000;
const DOWNLOAD_TTL_SECONDS = 10 * 60;
const DISCORD_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const DISCORD_SIGNATURE_MAX_FUTURE_SKEW_MS = 60 * 1000;
const PROCESSED_INTERACTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_ORDERS_TO_CLEAN = 50;

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(reconcilePurchasePanel(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return landingPage();
    }

    if (request.method === "GET" && url.pathname === "/products") {
      return webProductsJson(env);
    }

    if (request.method === "GET" && url.pathname === "/download") {
      return handleDownload(request, env, url);
    }

    if (request.method !== "POST" || url.pathname !== "/discord/interactions") {
      return new Response("Not found", { status: 404 });
    }

    try {
      const interaction = await verifyDiscordInteraction(request, env);
      return handleInteraction(interaction, env, ctx);
    } catch (error) {
      // Never log a submitted receive-link or any Discord interaction body.
      console.error("Interaction rejected or failed", error instanceof Error ? error.message : "unknown error");
      // Always return a valid Discord interaction response. A plain HTTP 400 makes
      // Discord show "application did not respond" and hides the actionable error.
      return ephemeral("処理中にエラーが発生しました。販売パネルの「商品を選ぶ」を押して、もう一度お試しください。");
    }
  },
};

async function handleInteraction(interaction, env, ctx) {
  if (interaction.type === DISCORD_PING) {
    return json({ type: RESPONSE_PONG });
  }

  if (!isAllowedGuildContext(interaction, env)) {
    return ephemeral("この販売ボットは指定された販売サーバー内でのみ利用できます。");
  }

  const componentId = interaction.type === DISCORD_MESSAGE_COMPONENT
    ? String(interaction.data?.custom_id ?? "")
    : "";
  // The catalog is already embedded in Discord's persistent panel, so selecting
  // a product can open its modal without waiting on R2 or D1.
  const readOnlyInteraction =
    interaction.type === DISCORD_MODAL_SUBMIT ||
    (interaction.type === DISCORD_MESSAGE_COMPONENT && componentId.startsWith("product-select:"));
  if (!readOnlyInteraction && !await markInteractionAsNew(interaction, env)) {
    return ephemeral("この操作はすでに受け付け済みです。重複して注文・配布されることはありません。");
  }

  if (interaction.type === DISCORD_APPLICATION_COMMAND) {
    return handleCommand(interaction, env, ctx);
  }

  if (interaction.type === DISCORD_MODAL_SUBMIT) {
    return deferPaymentLinkSubmission(interaction, env, ctx);
  }

  if (interaction.type === DISCORD_MESSAGE_COMPONENT) {
    return handleComponentInteraction(interaction, env, ctx);
  }

  return ephemeral("この操作には対応していません。");
}

async function handleCommand(interaction, env, ctx) {
  const command = interaction.data?.name;
  if (command === "claim") return claimPaymentLink(interaction, env);
  if (command === "approve") return approveOrder(interaction, env, ctx);
  if (command === "cancel") return cancelOrder(interaction, env);
  if (command === "pending") return listPendingOrders(interaction, env);
  if (command === "status") return showOrderStatus(interaction, env);
  return ephemeral("未知のコマンドです。");
}

function openPaymentModal(interaction, env, selectedProductId = null) {
  const productId = selectedProductId ?? optionValue(interaction, "product");
  if (!productId || (!/^r2-[0-9a-f]{8}$/i.test(String(productId)) && !findProduct(String(productId)))) {
    return ephemeral("商品が見つかりません。販売パネルを更新して、もう一度お試しください。");
  }

  return json({
    type: RESPONSE_MODAL,
    data: {
      custom_id: `paypay-receive-link:${productId}`,
      title: "PayPay受取リンクを入力",
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

function createPurchasePanelPayload() {
  return {
    type: RESPONSE_CHANNEL_MESSAGE,
    data: {
      content: "購入する場合は、下の「商品を選ぶ」ボタンを押してください。",
      components: [actionRow({ type: 2, style: 1, label: "商品を選ぶ", custom_id: "purchase-panel" })],
    },
  };
}

function createPurchasePanel() {
  return json(createPurchasePanelPayload());
}

async function reconcilePurchasePanel(env) {
  const channelId = String(env.SALES_CHANNEL_ID ?? "");
  if (!channelId || !env.DISCORD_BOT_TOKEN) throw new Error("Panel reconciliation is not configured");
  const panelPayload = await createCatalogPanelPayload(env);
  const listResponse = await discordApi(env, "/channels/" + encodeURIComponent(channelId) + "/messages?limit=100");
  if (!listResponse.ok) throw new Error("Could not read sales channel messages: HTTP " + listResponse.status);
  const messages = await listResponse.json();
  const panelMessages = messages.filter((message) =>
    (message.components || []).some((row) =>
      (row.components || []).some((component) => component.custom_id === "purchase-panel" || component.custom_id?.startsWith("product-select:")),
    ),
  );
  const existing = panelMessages[0];
  const duplicate = panelMessages[1];
  if (duplicate) {
    const deleted = await discordApi(env, "/channels/" + encodeURIComponent(channelId) + "/messages/" + encodeURIComponent(duplicate.id), { method: "DELETE" });
    if (!deleted.ok && deleted.status !== 404 && deleted.status !== 429) console.error("Could not remove duplicate purchase panel: HTTP " + deleted.status);
  }
  if (!existing) {
    const created = await discordApi(env, "/channels/" + encodeURIComponent(channelId) + "/messages", {
      method: "POST",
      body: JSON.stringify(panelPayload.data),
    });
    if (!created.ok) throw new Error("Could not create purchase panel: HTTP " + created.status);
    return;
  }
  if (panelSignature(existing) === panelSignature(panelPayload.data)) return;
  const updated = await discordApi(env, "/channels/" + encodeURIComponent(channelId) + "/messages/" + encodeURIComponent(existing.id), {
    method: "PATCH",
    body: JSON.stringify(panelPayload.data),
  });
  if (!updated.ok) throw new Error("Could not update purchase panel: HTTP " + updated.status);
}

async function createCatalogPanelPayload(env) {
  const products = await listR2Products(env);
  const chunks = [];
  for (let index = 0; index < products.length; index += 25) chunks.push(products.slice(index, index + 25));
  const components = chunks.length
    ? chunks.map((chunk, index) => actionRow({
        type: 3,
        custom_id: "product-select:" + index,
        placeholder: chunks.length === 1 ? "商品を選択" : "商品を選択（" + (index + 1) + "/" + chunks.length + "）",
        min_values: 1,
        max_values: 1,
        options: chunk.map((product) => ({
          label: truncateDiscordLabel(product.title),
          value: product.id,
          description: formatYen(product.priceYen) + "・最大" + product.maxDownloads + "回",
        })),
      }))
    : [actionRow({ type: 3, custom_id: "product-select:0", placeholder: "商品がありません", disabled: true, options: [{ label: "準備中", value: "unavailable" }] })];
  return {
    type: RESPONSE_CHANNEL_MESSAGE,
    data: {
      content: "購入する動画を下の一覧から選択してください。",
      components,
    },
  };
}

function panelSignature(panel) {
  return JSON.stringify({
    content: panel.content ?? "",
    components: (panel.components ?? []).map((row) => ({
      type: row.type,
      components: (row.components ?? []).map((component) => ({
        type: component.type,
        custom_id: component.custom_id,
        placeholder: component.placeholder,
        disabled: Boolean(component.disabled),
        min_values: component.min_values,
        max_values: component.max_values,
        options: (component.options ?? []).map((option) => ({
          label: option.label,
          value: option.value,
          description: option.description,
        })),
      })),
    })),
  });
}

async function discordApi(env, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bot ${env.DISCORD_BOT_TOKEN}`);
  headers.set("Content-Type", "application/json");
  return fetch("https://discord.com/api/v10" + path, { ...init, headers });
}

function handleComponentInteraction(interaction, env) {
  const customId = String(interaction.data?.custom_id ?? "");
  if (!customId.startsWith("product-select:")) {
    return ephemeral("この操作は期限切れです。最新の商品一覧から選び直してください。");
  }
  const productId = interaction.data?.values?.[0] ?? "";
  return openPaymentModal(interaction, env, productId);
}

function deferPaymentLinkSubmission(interaction, env, ctx) {
  if (!ctx?.waitUntil) return handlePaymentLinkSubmission(interaction, env);
  ctx.waitUntil(
    (async () => {
      const buyerId = interaction.member?.user?.id ?? interaction.user?.id;
      if (!await markInteractionAsNew(interaction, env)) {
        await sendDiscordDm(env, buyerId, "この操作はすでに受け付け済みです。重複して注文・配布されることはありません。");
        return;
      }
      const response = await handlePaymentLinkSubmission(interaction, env);
      const payload = await response.json();
      await sendDiscordDm(env, buyerId, payload.data?.content ?? "注文を受け付けました。");
    })().catch(async (error) => {
      console.error("Payment submission failed", error instanceof Error ? error.message : "unknown error");
      const buyerId = interaction.member?.user?.id ?? interaction.user?.id;
      try { await sendDiscordDm(env, buyerId, "決済リンクの処理に失敗しました。購入パネルからもう一度お試しください。"); } catch (dmError) {
        console.error("Payment error DM failed", dmError instanceof Error ? dmError.message : "unknown error");
      }
    }),
  );
  return ephemeral("受取リンクを受信しました。処理完了後、BotからDMで結果をお送りします。");
}

async function sendDiscordDm(env, userId, content, components = []) {
  if (!userId) throw new Error("Missing buyer Discord ID");
  const dm = await discordApi(env, "/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!dm.ok) throw new Error("Could not open buyer DM: HTTP " + dm.status);
  const channel = await dm.json();
  const payload = { content: String(content).slice(0, 1900) };
  if (components.length) payload.components = components;
  const message = await discordApi(env, "/channels/" + encodeURIComponent(channel.id) + "/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!message.ok) throw new Error("Could not send buyer DM: HTTP " + message.status);
}
async function handlePaymentLinkSubmission(interaction, env) {
  const customId = interaction.data?.custom_id ?? "";
  const productId = customId.startsWith("paypay-receive-link:")
    ? customId.slice("paypay-receive-link:".length)
    : "";
  const product = await runtimeProductById(env, productId);
  if (!product) return ephemeral("商品情報を確認できませんでした。販売パネルからもう一度お試しください。");

  const submitted = modalValue(interaction, "paypay_receive_link");
  const receiveLink = extractPayPayReceiveLink(submitted);
  if (!receiveLink) {
    return ephemeral("PayPayの受取リンクを確認できませんでした。pay.paypay.ne.jp のリンクをそのまま貼り付けてください。");
  }

  const buyerId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!buyerId) return ephemeral("購入者情報を確認できませんでした。");

  const now = new Date();
  await expireStaleOrders(env, now);
  const recentOrder = await env.DB.prepare(
    `SELECT code FROM orders
       WHERE buyer_discord_id = ?
         AND product_id = ?
         AND status = 'awaiting_manual_acceptance'
       ORDER BY created_at DESC LIMIT 1`,
  ).bind(buyerId, product.id).first();

  if (recentOrder?.code) {
    return ephemeral(`同じ商品の未処理注文があります（注文番号：${recentOrder.code}）。受取リンクの期限が切れた場合は、管理者へ取り消しを依頼してから再注文してください。`);
  }

  const ciphertext = await encryptReceiveLink(receiveLink, env.PAYPAY_LINK_ENCRYPTION_KEY);
  const order = await createPendingOrder({
    env,
    buyerId,
    guildId: interaction.guild_id ?? null,
    product,
    ciphertext,
    now,
  });

  if (order.kind === "duplicate") {
    return ephemeral(`同じ商品の未処理注文があります（注文番号：${order.code}）。受取リンクの期限が切れた場合は、管理者へ取り消しを依頼してから再注文してください。`);
  }
  if (order.kind !== "created") {
    throw new Error("Could not create a unique order");
  }
  await notifyOwnerOfPendingOrder(env, order, product, receiveLink);


  return ephemeral(
    `注文を受け付けました。\n注文番号：**${order.code}**\n商品：${product.title}（${formatYen(product.priceYen)}）\n` +
      `確認期限：30分\n管理者がPayPayで受取確認後、/download order:${order.code} で受け取れます。\n` +
      "重要：リンクのパスワード・PayPayの暗証番号・ログイン情報は送らないでください。",
  );
}

async function notifyOwnerOfPendingOrder(env, order, product, receiveLink) {
  const ownerId = String(env.OWNER_DISCORD_ID ?? "").trim();
  if (!ownerId) return;
  try {
    await sendDiscordDm(
      env,
      ownerId,
      "新しい注文が届きました。\\n注文番号：**" + order.code + "\\n商品：" + product.title + "\\n金額：" + formatYen(product.priceYen) + "\\n\\nPayPayでこの金額の受取を確認してください。\\n受取リンク：<" + receiveLink + ">\\n\\n確認できたら、販売チャンネルで /approve order:" + order.code + " を実行してください。",
    );
    const claimedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE orders SET claimed_at = COALESCE(claimed_at, ?), claimed_by_discord_id = COALESCE(claimed_by_discord_id, ?) WHERE id = ? AND status = 'awaiting_manual_acceptance'",
      ).bind(claimedAt, ownerId, order.id),
      auditStatement(env, order.id, ownerId, "payment_link_sent_to_owner", {}),
    ]);
  } catch (error) {
    // The encrypted link remains available for the owner-only /claim fallback.
    console.error("Pending order owner DM failed", error instanceof Error ? error.message : "unknown error");
  }
}
async function webProductsJson(env) {
  try {
    const products = await listR2Products(env);
    return new Response(JSON.stringify(products.map((product) => ({
      id: product.id, title: product.title, priceYen: product.priceYen, maxDownloads: product.maxDownloads,
    }))), {headers: {"Content-Type":"application/json","Cache-Control":"no-store"}});
  } catch (error) {
    return new Response(JSON.stringify({error:"unavailable"}), {status:503,headers: {"Content-Type":"application/json"}});
  }
}

let r2ProductCache;
let r2ProductCacheExpiresAt = 0;

async function listR2Products(env) {
  const now = Date.now();
  if (r2ProductCache && now < r2ProductCacheExpiresAt) return r2ProductCache;
  const request = listR2ProductsUncached(env);
  r2ProductCache = request;
  r2ProductCacheExpiresAt = now + 60_000;
  try {
    return await request;
  } catch (error) {
    if (r2ProductCache === request) {
      r2ProductCache = undefined;
      r2ProductCacheExpiresAt = 0;
    }
    throw error;
  }
}

async function listR2ProductsUncached(env) {
  const prefix = typeof env.PRODUCTS_PREFIX === "string" && env.PRODUCTS_PREFIX
    ? env.PRODUCTS_PREFIX
    : "products/";
  const products = [];
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const listed = await env.PRODUCT_ASSETS.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of listed.objects ?? []) {
      if (!isVideoObjectKey(object.key)) continue;
      const product = productFromObject(object, 2000, 3);
      if (product) products.push(product);
    }
    if (!listed.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }
  const unique = new Map(products.map((product) => [product.id, product]));
  return [...unique.values()].sort((left, right) => left.objectKey.localeCompare(right.objectKey, "ja"));
}
async function runtimeProductById(env, productId) {
  let dynamic = [];
  try {
    dynamic = await listR2Products(env);
  } catch (error) {
    console.error("Product lookup failed", error instanceof Error ? error.message : "unknown error");
  }
  const product = dynamic.find((candidate) => candidate.id === productId);
  if (product) return product;
  const legacy = findProduct(productId);
  if (!legacy) return null;
  const object = await env.PRODUCT_ASSETS.head(legacy.objectKey);
  return object ? legacy : null;
}

function truncateDiscordLabel(value) {
  const text = String(value ?? "動画").replace(/[\r\n]/g, " ").trim() || "動画";
  return text.length <= 100 ? text : text.slice(0, 97) + "...";
}

function ephemeralComponentMessage(content, components) {
  return json({
    type: RESPONSE_CHANNEL_MESSAGE,
    data: { flags: EPHEMERAL, content, components },
  });
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
  if (order.claimed_at && order.claimed_by_discord_id !== ownerId) {
    return ephemeral("この注文の受取リンクはすでに管理者へ表示されています。");
  }
  const link = await decryptReceiveLink(order.paypay_receive_link_ciphertext, env.PAYPAY_LINK_ENCRYPTION_KEY);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders
         SET claimed_at = COALESCE(claimed_at, ?), claimed_by_discord_id = COALESCE(claimed_by_discord_id, ?)
       WHERE id = ?`,
    ).bind(new Date().toISOString(), ownerId, order.id),
    auditStatement(env, order.id, ownerId, "payment_link_revealed_to_owner", {}),
  ]);

  const terms = await deliveryTermsForOrder(env, order);
  return ephemeral(
    `注文：${order.code}\n商品：${terms?.productTitle ?? order.product_id}\n確認額：${formatYen(terms?.priceYen ?? 0)}\n\n` +
      `受取リンク（管理者だけに表示）：\n<${link}>\n\n` +
      "PayPayアプリで受取完了を確認してから、/approve order:注文番号 を実行してください。",
  );
}

async function approveOrder(interaction, env, ctx) {
  const denied = requireOwner(interaction, env);
  if (denied) return denied;
  const order = await orderByCode(env, optionValue(interaction, "order"));
  if (!order) return ephemeral("注文が見つかりません。");
  if (order.status !== "awaiting_manual_acceptance") return ephemeral(`この注文は ${order.status} 状態です。`);
  if (!order.claimed_at) return ephemeral("注文通知DMまたは /claim で受取リンクを確認してから実行してください。");
  const terms = await deliveryTermsForOrder(env, order);
  if (!terms) return ephemeral("商品情報を確認できないため、承認を停止しました。");
  if (Date.parse(order.expires_at) <= Date.now()) {
    await expireOrder(env, order.id);
    return ephemeral("確認期限が切れています。承認できません。");
  }

  const ownerId = interaction.member?.user?.id ?? interaction.user?.id;
  const confirmedAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE orders
       SET status = 'approved', approved_at = ?, approved_by_discord_id = ?, paypay_receive_link_ciphertext = ''
     WHERE id = ? AND status = 'awaiting_manual_acceptance' AND claimed_at IS NOT NULL`,
  ).bind(confirmedAt, ownerId, order.id).run();

  if (result.meta.changes !== 1) return ephemeral("この注文は別の操作で更新されました。/claim で状態を確認してください。");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO order_payment_confirmations (
        order_id, confirmed_amount_yen, confirmed_at, confirmed_by_discord_id
      ) VALUES (?, ?, ?, ?)`,
    ).bind(order.id, terms.priceYen, confirmedAt, ownerId),
    env.DB.prepare("DELETE FROM pending_order_locks WHERE buyer_discord_id = ? AND product_id = ? AND order_id = ?")
      .bind(order.buyer_discord_id, order.product_id, order.id),
    auditStatement(env, order.id, ownerId, "delivery_approved", { confirmedAmountYen: terms.priceYen }),
  ]);

  const delivery = deliverApprovedOrder(env, order, terms);
  if (ctx?.waitUntil) {
    ctx.waitUntil(delivery);
  } else {
    await delivery;
  }
  return ephemeral("承認しました。購入者へ動画の受取ボタンをDMで送信します。");
}

async function deliverApprovedOrder(env, order, terms) {
  try {
    const link = await signedDownloadUrl(env, order, terms);
    await sendDiscordDm(
      env,
      order.buyer_discord_id,
      `お支払いを確認しました。\\n商品：${terms.productTitle}\\n下の「動画を受け取る」ボタンから受け取れます。\\n受取リンクは10分間有効です。残り回数：${Math.max(0, terms.maxDownloads - order.download_uses)}回`,
      [actionRow({ type: 2, style: 5, label: "動画を受け取る", url: link })],
    );
  } catch (error) {
    console.error("Approved delivery DM failed", error instanceof Error ? error.message : "unknown error");
  }
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
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pending_order_locks WHERE buyer_discord_id = ? AND product_id = ? AND order_id = ?")
      .bind(order.buyer_discord_id, order.product_id, order.id),
    auditStatement(env, order.id, ownerId, "order_cancelled", {}),
  ]);
  return ephemeral(`注文 ${order.code} を取り消しました。`);
}

async function listPendingOrders(interaction, env) {
  const denied = requireOwner(interaction, env);
  if (denied) return denied;
  await expireStaleOrders(env, new Date());
  const rows = await env.DB.prepare(
    `SELECT o.code, o.product_id, o.created_at, o.expires_at, t.product_title, t.price_yen
       FROM orders o
       LEFT JOIN order_delivery_terms t ON t.order_id = o.id
      WHERE o.status = 'awaiting_manual_acceptance'
      ORDER BY o.created_at ASC
      LIMIT 20`,
  ).all();
  if (!rows.results?.length) return ephemeral("未処理の注文はありません。");
  const lines = rows.results.map((row) => {
    const title = row.product_title ?? row.product_id ?? "商品情報なし";
    const amount = Number.isSafeInteger(row.price_yen) ? formatYen(row.price_yen) : "金額不明";
    return `・${row.code}｜${title}（${amount}）｜期限 ${formatDateTime(row.expires_at)}`;
  });
  return ephemeral(`未処理注文（最大20件）\n${lines.join("\n")}\n\n確認する場合は /claim order:注文番号 を実行してください。`);
}

async function showOrderStatus(interaction, env) {
  const order = await orderByCode(env, optionValue(interaction, "order"));
  if (!order) return ephemeral("注文が見つかりません。");
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  if (order.buyer_discord_id !== userId && userId !== env.OWNER_DISCORD_ID) {
    return ephemeral("この注文の状態は購入者本人だけが確認できます。");
  }
  if (order.status === "awaiting_manual_acceptance" && Date.parse(order.expires_at) <= Date.now()) {
    await expireOrder(env, order.id);
    return ephemeral("この注文は期限切れです。新しいPayPay受取リンクで再注文してください。");
  }
  const terms = await deliveryTermsForOrder(env, order);
  const statusText = orderStatusLabel(order.status);
  const downloadText = order.status === "approved"
    ? `残りダウンロード回数：${Math.max(0, (terms?.maxDownloads ?? 0) - order.download_uses)}回`
    : `確認期限：${formatDateTime(order.expires_at)}`;
  return ephemeral(`注文番号：${order.code}\n商品：${terms?.productTitle ?? order.product_id}\n金額：${formatYen(terms?.priceYen ?? 0)}\n状態：${statusText}\n${downloadText}`);
}

async function signedDownloadUrl(env, order, terms) {
  const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
  const signature = await signDownload(order.id, expires, env.PRODUCT_DOWNLOAD_SIGNING_KEY);
  const link = new URL("/download", env.PUBLIC_BASE_URL);
  link.searchParams.set("order", order.id);
  link.searchParams.set("expires", String(expires));
  link.searchParams.set("sig", signature);
  return link.toString();
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
  const terms = order ? await deliveryTermsForOrder(env, order) : null;
  if (!order || !terms || order.status !== "approved") return new Response("This product is unavailable.", { status: 404 });
  if (order.download_uses >= terms.maxDownloads) return new Response("Download limit reached.", { status: 429 });

  const object = await env.PRODUCT_ASSETS.get(terms.objectKey);
  if (!object) return new Response("Product file is unavailable. Please contact support.", { status: 503 });

  const update = await env.DB.prepare(
    `UPDATE orders
       SET download_uses = download_uses + 1, last_downloaded_at = ?
     WHERE id = ? AND status = 'approved' AND download_uses < ?`,
  ).bind(new Date().toISOString(), order.id, terms.maxDownloads).run();
  if (update.meta.changes !== 1) return new Response("Download limit reached.", { status: 429 });

  await auditStatement(env, order.id, null, "download_served", { requestMethod: request.method }).run();
  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Content-Disposition", contentDispositionAttachment(terms.downloadName));
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (object.size != null) headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

async function createPendingOrder({ env, buyerId, guildId, product, ciphertext, now }) {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ORDER_TTL_MS).toISOString();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const orderId = crypto.randomUUID();
    const code = createOrderCode();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO orders (
            id, code, buyer_discord_id, guild_id, product_id, status,
            paypay_receive_link_ciphertext, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, 'awaiting_manual_acceptance', ?, ?, ?)`,
        ).bind(orderId, code, buyerId, guildId, product.id, ciphertext, nowIso, expiresAt),
        env.DB.prepare(
          `INSERT INTO order_delivery_terms (
            order_id, product_title, price_yen, object_key, download_name, max_downloads, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(orderId, product.title, product.priceYen, product.objectKey, product.downloadName, product.maxDownloads, nowIso),
        env.DB.prepare(
          `INSERT INTO pending_order_locks (
            buyer_discord_id, product_id, order_id, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
        ).bind(buyerId, product.id, orderId, expiresAt, nowIso),
        auditStatement(env, orderId, buyerId, "payment_link_submitted", {
          productId: product.id,
          priceYen: product.priceYen,
        }),
      ]);
      return { kind: "created", id: orderId, code, expiresAt };
    } catch (error) {
      if (isUniqueConstraint(error)) {
        const existing = await env.DB.prepare(
          `SELECT o.code
             FROM pending_order_locks lock
             JOIN orders o ON o.id = lock.order_id
            WHERE lock.buyer_discord_id = ? AND lock.product_id = ?
            LIMIT 1`,
        ).bind(buyerId, product.id).first();
        if (existing?.code) return { kind: "duplicate", code: existing.code };
        continue;
      }
      throw error;
    }
  }
  return { kind: "failed" };
}

async function deliveryTermsForOrder(env, order) {
  const snapshot = await env.DB.prepare(
    `SELECT product_title, price_yen, object_key, download_name, max_downloads
       FROM order_delivery_terms
      WHERE order_id = ?`,
  ).bind(order.id).first();
  if (snapshot) return normalizeDeliveryTerms(snapshot);

  // 古いテスト注文への後方互換です。新しい注文は必ず作成時の条件を保存します。
  const fallback = findProduct(order.product_id);
  return fallback ? normalizeDeliveryTerms({
    product_title: fallback.title,
    price_yen: fallback.priceYen,
    object_key: fallback.objectKey,
    download_name: fallback.downloadName,
    max_downloads: fallback.maxDownloads,
  }) : null;
}

function normalizeDeliveryTerms(value) {
  const priceYen = Number(value.price_yen);
  const maxDownloads = Number(value.max_downloads);
  if (
    !Number.isSafeInteger(priceYen) || priceYen < 1 ||
    !Number.isSafeInteger(maxDownloads) || maxDownloads < 1 ||
    typeof value.product_title !== "string" || !value.product_title ||
    typeof value.object_key !== "string" || !value.object_key ||
    typeof value.download_name !== "string" || !value.download_name
  ) return null;
  return {
    productTitle: value.product_title,
    priceYen,
    objectKey: value.object_key,
    downloadName: value.download_name,
    maxDownloads,
  };
}

async function expireStaleOrders(env, now) {
  const nowIso = now.toISOString();
  const stale = await env.DB.prepare(
    `SELECT id, buyer_discord_id, product_id
       FROM orders
      WHERE status = 'awaiting_manual_acceptance' AND expires_at <= ?
      ORDER BY expires_at ASC
      LIMIT ?`,
  ).bind(nowIso, MAX_PENDING_ORDERS_TO_CLEAN).all();
  if (!stale.results?.length) return;

  const statements = [];
  for (const order of stale.results) {
    statements.push(
      env.DB.prepare(
        `UPDATE orders
            SET status = 'expired', paypay_receive_link_ciphertext = ''
          WHERE id = ? AND status = 'awaiting_manual_acceptance'`,
      ).bind(order.id),
      env.DB.prepare("DELETE FROM pending_order_locks WHERE buyer_discord_id = ? AND product_id = ? AND order_id = ?")
        .bind(order.buyer_discord_id, order.product_id, order.id),
      auditStatement(env, order.id, null, "order_expired", {}),
    );
  }
  await env.DB.batch(statements);
}

async function markInteractionAsNew(interaction, env) {
  const interactionId = String(interaction.id ?? "");
  if (!/^\d{15,25}$/.test(interactionId)) return false;
  const now = new Date();
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO processed_discord_interactions (interaction_id, processed_at) VALUES (?, ?)",
  ).bind(interactionId, now.toISOString()).run();
  if (result.meta.changes !== 1) return false;

  // Best effort cleanup only. Failure here must not make a legitimate purchase fail.
  env.DB.prepare("DELETE FROM processed_discord_interactions WHERE processed_at < ?")
    .bind(new Date(now.getTime() - PROCESSED_INTERACTION_RETENTION_MS).toISOString())
    .run()
    .catch(() => {});
  return true;
}

async function verifyDiscordInteraction(request, env) {
  const signatureHex = request.headers.get("X-Signature-Ed25519") ?? "";
  const timestamp = request.headers.get("X-Signature-Timestamp") ?? "";
  if (!/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d{10,13}$/.test(timestamp)) throw new Error("Missing Discord signature");
  if (!isFreshDiscordTimestamp(timestamp)) throw new Error("Stale Discord signature");
  const body = await request.text();
  const key = await getDiscordPublicKey(env);
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key,
    hexToBytes(signatureHex),
    new TextEncoder().encode(timestamp + body),
  );
  if (!valid) throw new Error("Invalid Discord signature");
  return JSON.parse(body);
}

let discordPublicKeyPromise;

function getDiscordPublicKey(env) {
  if (!discordPublicKeyPromise) {
    discordPublicKeyPromise = crypto.subtle.importKey(
      "raw",
      hexToBytes(env.DISCORD_APPLICATION_PUBLIC_KEY),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  }
  return discordPublicKeyPromise;
}

function extractPayPayReceiveLink(input) {
  if (typeof input !== "string" || input.length > 512) return null;
  const candidates = input.match(/https:\/\/pay\.paypay\.ne\.jp\/[^\s<>"']+/g) ?? [];
  for (const candidate of candidates) {
    // Japanese full stops and closing punctuation are commonly pasted directly
    // after a URL. Remove only punctuation that cannot be part of the token.
    const normalized = candidate.replace(/[.,、。!！?？)\]}>）］｝＞]+$/u, "");
    try {
      const url = new URL(normalized);
      if (
        url.protocol === "https:" &&
        url.hostname === "pay.paypay.ne.jp" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /^\/[A-Za-z0-9_-]{6,128}\/?$/.test(url.pathname)
      ) return url.toString();
    } catch {
      // Continue to the next candidate rather than rejecting a whole message.
    }
  }
  return null;
}

function requireOwner(interaction, env) {
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  return userId === env.OWNER_DISCORD_ID ? null : ephemeral("このコマンドは管理者専用です。");
}

function isAllowedGuildContext(interaction, env) {
  return Boolean(env.SALES_GUILD_ID) && interaction.guild_id === env.SALES_GUILD_ID;
}

function isAllowedSalesChannel(interaction, env) {
  return !env.SALES_CHANNEL_ID || interaction.channel_id === env.SALES_CHANNEL_ID;
}

async function orderByCode(env, value) {
  const code = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(code)) return null;
  return env.DB.prepare("SELECT * FROM orders WHERE code = ?").bind(code).first();
}

async function expireOrder(env, orderId) {
  const order = await env.DB.prepare("SELECT buyer_discord_id, product_id FROM orders WHERE id = ?").bind(orderId).first();
  if (!order) return;
  const result = await env.DB.prepare(
    "UPDATE orders SET status = 'expired', paypay_receive_link_ciphertext = '' WHERE id = ? AND status = 'awaiting_manual_acceptance'",
  ).bind(orderId).run();
  if (result.meta.changes !== 1) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pending_order_locks WHERE buyer_discord_id = ? AND product_id = ? AND order_id = ?")
      .bind(order.buyer_discord_id, order.product_id, orderId),
    auditStatement(env, orderId, null, "order_expired", {}),
  ]);
}

function auditStatement(env, orderId, actorId, eventType, details) {
  return env.DB.prepare(
    "INSERT INTO order_audit_events (id, order_id, actor_discord_id, event_type, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), orderId, actorId, eventType, new Date().toISOString(), JSON.stringify(details));
}

function isFreshDiscordTimestamp(value, nowMs = Date.now()) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return false;
  const timestampMs = String(value).length === 13 ? numeric : numeric * 1000;
  const age = nowMs - timestampMs;
  return age <= DISCORD_SIGNATURE_MAX_AGE_MS && age >= -DISCORD_SIGNATURE_MAX_FUTURE_SKEW_MS;
}

function isUniqueConstraint(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|constraint failed/i.test(message);
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

// Keep the seller's original display name while removing characters that could
// inject headers or turn the name into a path. The ASCII fallback is for older
// clients; filename* carries the correct UTF-8 name for modern clients.
function contentDispositionAttachment(value) {
  const original = String(value ?? "download")
    .normalize("NFC")
    .replace(/[\\/\u0000-\u001F\u007F]/g, "_")
    .trim()
    .slice(0, 180) || "download";
  const asciiFallback = original
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 180) || "download";
  const encoded = encodeURIComponent(original).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function formatYen(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? `${amount.toLocaleString("ja-JP")}円` : "金額不明";
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日時不明";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function orderStatusLabel(status) {
  return ({
    awaiting_manual_acceptance: "管理者の受取確認待ち",
    approved: "承認済み・受取可能",
    cancelled: "取り消し済み",
    expired: "確認期限切れ",
  })[status] ?? "状態不明";
}

function landingPage() {
  const products = PRODUCTS.map((product) => `
    <article class="product">
      <h2>${escapeHtml(product.title)}</h2>
      <p class="price">${formatYen(product.priceYen)}</p>
      <p>Discordの販売パネルから注文します。ダウンロード上限：${product.maxDownloads}回</p>
    </article>`).join("");
  const html = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="referrer" content="no-referrer">
    <title>Discordデジタル配布</title>
    <style>
      :root { color-scheme: dark; font-family: system-ui, sans-serif; }
      body { margin: 0; background: #091728; color: #f4f8ff; }
      main { max-width: 680px; margin: 0 auto; padding: 40px 20px 56px; }
      .tag { color: #36d18b; font-weight: 700; }
      h1 { font-size: clamp(2rem, 8vw, 3rem); margin: 8px 0; }
      .lead { color: #b5c4da; line-height: 1.8; }
      .product, .steps { border: 1px solid #29476d; border-radius: 16px; padding: 20px; margin: 16px 0; background: #0d2139; }
      h2 { margin-top: 0; }
      .price { color: #42d893; font-size: 1.8rem; font-weight: 800; margin: 8px 0; }
      ol { padding-left: 1.4rem; line-height: 1.9; }
      code { color: #a8d3ff; }
      .notice { font-size: .9rem; color: #bdc9da; line-height: 1.7; }
    </style>
  </head>
  <body><main>
    <p class="tag">DISCORD DIGITAL DELIVERY</p>
    <h1>デジタル商品 配布所</h1>
    <p class="lead">購入と受取はDiscord内で完結します。PayPay受取リンクは、注文確認のためだけに暗号化して短時間保存され、管理者が手動で受取確認すると、Botが購入者へ受取ボタンをDM送信します。</p>
    <section aria-label="商品一覧">${products}</section>
    <section class="steps"><h2>購入方法</h2><ol><li>販売用Discordチャンネルで商品を選ぶ</li><li>PayPay受取リンクをフォームへ貼り付け</li><li>管理者の確認後、BotのDMから動画を受け取る</li></ol></section>
    <p class="notice">PayPayのログイン情報、暗証番号、受取リンクのパスワードは送らないでください。受取リンクの自動受取・自動承認は行いません。</p>
  </main></body>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    },
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

// Exported only for deterministic local tests. The Worker runtime uses the
// default export above; no secret or database operation is exposed here.
export const __testables = Object.freeze({
  extractPayPayReceiveLink,
  isFreshDiscordTimestamp,
  isUuid,
  normalizeDeliveryTerms,
  safeFilename,
  contentDispositionAttachment,
  timingSafeEqual,
});

