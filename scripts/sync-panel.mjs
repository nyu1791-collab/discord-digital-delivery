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

const panel = {
  content: "購入する場合は、下の「商品を選ぶ」ボタンを押してください。",
  components: [{
    type: 1,
    components: [{ type: 2, style: 1, label: "商品を選ぶ", custom_id: "purchase-panel" }],
  }],
};

const listResponse = await api("/channels/" + channelId + "/messages?limit=100");
if (!listResponse.ok) throw new Error("Could not read sales channel messages: " + listResponse.status);
const messages = await listResponse.json();
const existing = messages.find((message) =>
  (message.components || []).some((row) =>
    (row.components || []).some((component) => component.custom_id === "purchase-panel"),
  ),
);

const response = existing
  ? await api("/channels/" + channelId + "/messages/" + existing.id, { method: "PATCH", body: JSON.stringify(panel) })
  : await api("/channels/" + channelId + "/messages", { method: "POST", body: JSON.stringify(panel) });

if (!response.ok) {
  throw new Error("Could not synchronize purchase panel: " + response.status + " " + await response.text());
}
console.log(existing ? "Updated the existing purchase panel." : "Created the purchase panel.");
