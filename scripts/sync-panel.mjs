const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_SALES_CHANNEL_ID;

if (!applicationId || !botToken || !channelId) {
  throw new Error("DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and DISCORD_SALES_CHANNEL_ID are required.");
}

const api = (path, init = {}) => fetch("https://discord.com/api/v10" + path, {
  ...init,
  headers: {
    Authorization: "Bot " + botToken,
    "Content-Type": "application/json",
    ...(init.headers || {}),
  },
});

const workerUrl = process.env.WORKER_URL;
if (!workerUrl) throw new Error("WORKER_URL is required");

const productsResponse = await fetch(workerUrl + "/products");
if (!productsResponse.ok) throw new Error("Could not load products: " + productsResponse.status);
const products = await productsResponse.json();
if (!Array.isArray(products)) throw new Error("Product list is invalid");
const chunks = [];
for (let index = 0; index < products.length; index += 25) chunks.push(products.slice(index, index + 25));
const components = chunks.length
  ? chunks.map((chunk, index) => ({
      type: 1,
      components: [{
        type: 3,
        custom_id: "product-select:" + index,
        placeholder: chunks.length === 1 ? "商品を選択" : "商品を選択（" + (index + 1) + "/" + chunks.length + "）",
        min_values: 1,
        max_values: 1,
        options: chunk.map((product) => ({
          label: String(product.title).slice(0, 100),
          value: product.id,
          description: Number(product.priceYen).toLocaleString("ja-JP") + "円・最大" + product.maxDownloads + "回",
        })),
      }],
    }))
  : [{
      type: 1,
      components: [{ type: 3, custom_id: "product-select:0", placeholder: "商品がありません", disabled: true, options: [{ label: "準備中", value: "unavailable" }] }],
    }];

const panel = {
  content: "購入する動画を下の一覧から選択してください。",
  components,
};

const listResponse = await api("/channels/" + channelId + "/messages?limit=100");
if (!listResponse.ok) throw new Error("Could not read sales channel messages: " + listResponse.status);
const messages = await listResponse.json();
const panelMessages = messages.filter((message) =>
  (message.components || []).some((row) =>
    (row.components || []).some((component) => component.custom_id === "purchase-panel" || component.custom_id?.startsWith("product-select:")),
  ),
);
const existing = panelMessages[0];
for (const duplicate of panelMessages.slice(1)) {
  const deleted = await api("/channels/" + channelId + "/messages/" + duplicate.id, { method: "DELETE" });
  if (!deleted.ok && deleted.status !== 404 && deleted.status !== 429) throw new Error("Could not remove duplicate purchase panel: " + deleted.status);
  if (deleted.status === 429) console.warn("Discord rate limit while removing a duplicate panel; scheduled reconciliation will retry.");
}

const response = existing
  ? await api("/channels/" + channelId + "/messages/" + existing.id, { method: "PATCH", body: JSON.stringify(panel) })
  : await api("/channels/" + channelId + "/messages", { method: "POST", body: JSON.stringify(panel) });

if (!response.ok) {
  throw new Error("Could not synchronize purchase panel: " + response.status + " " + await response.text());
}
console.log(existing ? "Updated the existing purchase panel." : "Created the purchase panel.");
