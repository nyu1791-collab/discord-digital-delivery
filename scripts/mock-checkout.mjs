import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Local-only simulation: no network, real payment, or production entitlement.
const product = Object.freeze({ id: "sample-video", title: "サンプル動画", priceYen: 500 });
const order = { id: randomUUID(), productId: product.id, status: "pending", paidYen: 0, delivered: false };
assert.equal(order.status, "pending");
order.status = "mock_paid";
order.paidYen = product.priceYen;
assert.equal(order.paidYen, product.priceYen);
if (order.status === "mock_paid" && order.paidYen === product.priceYen) {
  order.delivered = true;
  order.status = "mock_delivered";
}
assert.equal(order.delivered, true);
console.log(JSON.stringify({ mode: "local_mock_only", orderId: order.id, product: product.title, status: order.status, delivered: order.delivered }, null, 2));
