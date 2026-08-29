const CHECKOUT_TTL_SECONDS = 30 * 60;
const DELIVERY_TTL_SECONDS = 15 * 60;
const MAX_DELIVERY_USES_DEFAULT = 3;
const STRIPE_API_BASE = "https://api.stripe.com/v1";
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export async function createStripeCheckoutSession(env, product) {
  await ensureStripeSchema(env);
  assertStripeConfig(env);
  const baseUrl = publicBaseUrl(env);
  const body = new URLSearchParams();
  body.set("mode", "payment");
  body.set("success_url", `${baseUrl}/thanks?session_id={CHECKOUT_SESSION_ID}`);
  body.set("cancel_url", `${baseUrl}/buy?product=${encodeURIComponent(product.id)}&cancelled=1`);
  body.set("line_items[0][quantity]", "1");
  body.set("line_items[0][price_data][currency]", "jpy");
  body.set("line_items[0][price_data][unit_amount]", String(product.priceYen));
  body.set("line_items[0][price_data][product_data][name]", product.title);
  body.set("metadata[product_id]", product.id);
  body.set("metadata[delivery]", "r2-signed-download");
  const stripe = await stripeApi(env, "/checkout/sessions", { method: "POST", body });
  if (!stripe.ok) throw new Error("Stripe Checkout session creation failed: HTTP " + stripe.status);
  const session = await stripe.json();
  if (!validSessionId(session?.id) || typeof session.url !== "string") throw new Error("Stripe returned an invalid Checkout session");

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHECKOUT_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO stripe_checkout_sessions (
      session_id, product_id, product_title, price_yen, object_key, download_name,
      max_downloads, status, created_at, checkout_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).bind(
    session.id,
    product.id,
    product.title,
    product.priceYen,
    product.objectKey,
    product.downloadName,
    product.maxDownloads ?? MAX_DELIVERY_USES_DEFAULT,
    now.toISOString(),
    expiresAt,
  ).run();
  return json({ checkoutUrl: session.url });
}

export async function getStripeCheckoutStatus(env, sessionId) {
  await ensureStripeSchema(env);
  if (!validSessionId(sessionId)) return json({ error: "invalid_session" }, 400);
  const order = await env.DB.prepare("SELECT * FROM stripe_checkout_sessions WHERE session_id = ?").bind(sessionId).first();
  if (!order) return json({ error: "not_found" }, 404);
  if (order.status === "open") {
    const result = await syncCheckoutPayment(env, order);
    if (result === "expired") return json({ status: "expired" });
  }
  const current = await env.DB.prepare("SELECT * FROM stripe_checkout_sessions WHERE session_id = ?").bind(sessionId).first();
  if (!current || current.status !== "paid") return json({ status: current?.status ?? "not_found" });
  const expires = Math.floor(Date.now() / 1000) + DELIVERY_TTL_SECONDS;
  const signature = await signDelivery(current.session_id, expires, env.PRODUCT_DOWNLOAD_SIGNING_KEY);
  return json({
    status: "paid",
    downloadUrl: `${publicBaseUrl(env)}/stripe/download?session_id=${encodeURIComponent(current.session_id)}&expires=${expires}&signature=${encodeURIComponent(signature)}`,
    remainingDownloads: Math.max(0, Number(current.max_downloads) - Number(current.download_uses)),
  });
}

export async function handleStripeWebhook(request, env) {
  await ensureStripeSchema(env);
  assertStripeConfig(env);
  const payload = await request.text();
  if (!await verifyStripeSignature(payload, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET)) {
    return new Response("Invalid Stripe signature", { status: 400 });
  }
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response("Invalid event payload", { status: 400 });
  }
  const type = String(event?.type ?? "");
  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    const session = event?.data?.object;
    await markPaidFromStripeSession(env, session);
  }
  return new Response("ok", { status: 200 });
}

export async function handleStripeDownload(env, url) {
  await ensureStripeSchema(env);
  const sessionId = url.searchParams.get("session_id") ?? "";
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  if (!validSessionId(sessionId) || !Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) {
    return new Response("Link expired", { status: 403 });
  }
  const expected = await signDelivery(sessionId, expires, env.PRODUCT_DOWNLOAD_SIGNING_KEY);
  if (!timingSafeEqual(expected, signature)) return new Response("Invalid link", { status: 403 });
  const order = await env.DB.prepare("SELECT * FROM stripe_checkout_sessions WHERE session_id = ?").bind(sessionId).first();
  if (!order || order.status !== "paid") return new Response("Payment not completed", { status: 403 });
  const used = await env.DB.prepare(
    `UPDATE stripe_checkout_sessions
       SET download_uses = download_uses + 1, last_downloaded_at = ?
       WHERE session_id = ? AND status = 'paid' AND download_uses < max_downloads`,
  ).bind(new Date().toISOString(), sessionId).run();
  if (used.meta.changes !== 1) return new Response("Download limit reached", { status: 429 });
  const object = await env.PRODUCT_ASSETS.get(order.object_key);
  if (!object) return new Response("File unavailable", { status: 404 });
  const headers = new Headers();
  headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("Content-Disposition", contentDispositionAttachment(order.download_name));
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

export async function cleanupStripeSessions(env) {
  await ensureStripeSchema(env);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE stripe_checkout_sessions SET status = 'expired' WHERE status = 'open' AND checkout_expires_at < ?",
  ).bind(now).run();
}

export function stripeStorePage(products) {
  const cards = products.length
    ? products.map((product) => `<article><h2>${escapeHtml(product.title)}</h2><p class="price">${formatYen(product.priceYen)}</p><a href="/buy?product=${encodeURIComponent(product.id)}">この動画を購入</a></article>`).join("")
    : "<p>現在、販売中の商品はありません。</p>";
  return page("動画を購入", `<h1>動画を購入</h1><p class="lead">支払い後、すぐに動画を受け取れます。</p><section class="grid">${cards}</section>`);
}

export function stripeBuyPage(product, cancelled = false) {
  if (!product) return page("商品が見つかりません", "<h1>商品が見つかりません</h1><p>販売者から届いたリンクを確認してください。</p>", 404);
  const notice = cancelled ? "<p class=\"notice\">決済はキャンセルされました。購入する場合は、もう一度ボタンを押してください。</p>" : "";
  const productJson = JSON.stringify(product.id).replace(/</g, "\\u003c");
  return page("購入手続き", `<h1>${escapeHtml(product.title)}</h1><p class="price">${formatYen(product.priceYen)}</p><p class="lead">カード等で安全に決済できます。支払い完了後、この画面からすぐに動画を受け取れます。</p>${notice}<button id="checkout">${formatYen(product.priceYen)}を支払う</button><p id="message" class="notice"></p><script>const id=${productJson};document.getElementById("checkout").addEventListener("click",async()=>{const b=document.getElementById("checkout"),m=document.getElementById("message");b.disabled=true;m.textContent="決済画面を開いています…";try{const r=await fetch("/stripe/create-checkout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({productId:id})});const d=await r.json();if(!r.ok||!d.checkoutUrl)throw new Error();location.assign(d.checkoutUrl)}catch{b.disabled=false;m.textContent="決済画面を開けませんでした。時間をおいてもう一度お試しください。"}});</script>`);
}

export function stripeThanksPage(sessionId) {
  const id = JSON.stringify(String(sessionId ?? "")).replace(/</g, "\\u003c");
  return page("支払いを確認中", `<h1>支払いを確認しています</h1><p id="message" class="lead">通常は数秒で完了します。この画面は閉じないでください。</p><a id="download" hidden>動画を受け取る</a><script>const id=${id},m=document.getElementById("message"),a=document.getElementById("download");let n=0;async function check(){try{const r=await fetch("/stripe/session?session_id="+encodeURIComponent(id),{cache:"no-store"}),d=await r.json();if(d.status==="paid"){m.textContent="支払いを確認しました。下のボタンから動画を受け取れます。";a.href=d.downloadUrl;a.hidden=false;return}if(d.status==="expired"){m.textContent="決済の有効期限が切れました。販売者から届いたリンクを開き直してください。";return}if(++n>30){m.textContent="確認に時間がかかっています。30秒後にこのページを再読み込みしてください。";return}setTimeout(check,2000)}catch{if(++n<30)setTimeout(check,2000);else m.textContent="確認に失敗しました。ページを再読み込みしてください。"}}check();</script>`);
}

async function syncCheckoutPayment(env, order) {
  assertStripeConfig(env);
  const response = await stripeApi(env, "/checkout/sessions/" + encodeURIComponent(order.session_id));
  if (!response.ok) throw new Error("Stripe Checkout lookup failed: HTTP " + response.status);
  const session = await response.json();
  if (session.status === "expired") {
    await env.DB.prepare("UPDATE stripe_checkout_sessions SET status = 'expired' WHERE session_id = ? AND status = 'open'").bind(order.session_id).run();
    return "expired";
  }
  await markPaidFromStripeSession(env, session);
  return "open";
}

async function markPaidFromStripeSession(env, session) {
  if (!validSessionId(session?.id) || session.payment_status !== "paid" || String(session.currency ?? "").toLowerCase() !== "jpy") return;
  const order = await env.DB.prepare("SELECT * FROM stripe_checkout_sessions WHERE session_id = ?").bind(session.id).first();
  if (!order || order.status !== "open") return;
  if (Number(session.amount_total) !== Number(order.price_yen) || String(session.metadata?.product_id ?? "") !== String(order.product_id)) {
    console.error("Stripe payment terms mismatch", session.id);
    return;
  }
  await env.DB.prepare(
    "UPDATE stripe_checkout_sessions SET status = 'paid', paid_at = ?, stripe_payment_intent = ? WHERE session_id = ? AND status = 'open'",
  ).bind(new Date().toISOString(), session.payment_intent ?? null, session.id).run();
}

async function stripeApi(env, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Basic " + btoa(String(env.STRIPE_SECRET_KEY) + ":"));
  return fetch(STRIPE_API_BASE + path, { ...init, headers });
}

async function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = header.split(",").map((item) => item.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !signatures.length || !/^[0-9]+$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > STRIPE_SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  return signatures.some((signature) => timingSafeEqual(expected, signature));
}

async function signDelivery(sessionId, expires, secret) {
  if (!secret || String(secret).length < 32) throw new Error("PRODUCT_DOWNLOAD_SIGNING_KEY must be at least 32 characters");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`stripe.${sessionId}.${expires}`));
  return base64url(new Uint8Array(signature));
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertStripeConfig(env) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) throw new Error("Stripe is not configured");
}

function publicBaseUrl(env) {
  const value = String(env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  if (!/^https:\/\//.test(value)) throw new Error("PUBLIC_BASE_URL must be an HTTPS URL");
  return value;
}

let stripeSchemaPromise;

async function ensureStripeSchema(env) {
  if (!stripeSchemaPromise) {
    stripeSchemaPromise = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS stripe_checkout_sessions (
        session_id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        product_title TEXT NOT NULL,
        price_yen INTEGER NOT NULL CHECK (price_yen >= 1),
        object_key TEXT NOT NULL,
        download_name TEXT NOT NULL,
        max_downloads INTEGER NOT NULL CHECK (max_downloads >= 1),
        status TEXT NOT NULL CHECK (status IN ('open', 'paid', 'expired', 'cancelled')),
        created_at TEXT NOT NULL,
        checkout_expires_at TEXT NOT NULL,
        paid_at TEXT,
        stripe_payment_intent TEXT,
        download_uses INTEGER NOT NULL DEFAULT 0 CHECK (download_uses >= 0),
        last_downloaded_at TEXT
      )`),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS stripe_checkout_sessions_status_expiry_idx ON stripe_checkout_sessions (status, checkout_expires_at)"),
    ]).catch((error) => {
      stripeSchemaPromise = undefined;
      throw error;
    });
  }
  await stripeSchemaPromise;
}

function validSessionId(value) {
  return /^cs_(?:test_|live_)?[A-Za-z0-9_]+$/.test(String(value ?? ""));
}

function timingSafeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function contentDispositionAttachment(value) {
  const original = String(value ?? "download").normalize("NFC").replace(/[\\/\u0000-\u001F\u007F]/g, "_").trim().slice(0, 180) || "download";
  const fallback = original.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_").replace(/\s+/g, " ").slice(0, 180) || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(original)}`;
}

function formatYen(value) {
  return `${Number(value).toLocaleString("ja-JP")}円`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function page(title, content, status = 200) {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>:root{color-scheme:dark;font-family:system-ui,sans-serif}body{margin:0;background:#091728;color:#f4f8ff}main{max-width:680px;margin:0 auto;padding:48px 20px}.lead,.notice{color:#c5d3e4;line-height:1.8}.grid{display:grid;gap:14px}article{border:1px solid #29476d;border-radius:14px;padding:18px;background:#0d2139}h1,h2{margin-top:0}.price{font-size:1.7rem;font-weight:800;color:#42d893}a,button{display:inline-block;border:0;border-radius:10px;padding:14px 18px;background:#635bff;color:#fff;font-weight:800;font-size:1rem;text-decoration:none;cursor:pointer}button:disabled{opacity:.6;cursor:wait}.notice{min-height:1.5em}</style></head><body><main>${content}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" } });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
