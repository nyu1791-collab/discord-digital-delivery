-- Immutable order terms: a future catalog change must never rewrite the
-- amount, file, filename, or download limit promised to an existing order.
CREATE TABLE IF NOT EXISTS order_delivery_terms (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  product_title TEXT NOT NULL,
  price_yen INTEGER NOT NULL CHECK (price_yen >= 1),
  object_key TEXT NOT NULL,
  download_name TEXT NOT NULL,
  max_downloads INTEGER NOT NULL CHECK (max_downloads >= 1),
  created_at TEXT NOT NULL
);

-- A buyer may have only one active receipt-link order for the same product.
-- The row is deleted on approval, cancellation, or expiration.
CREATE TABLE IF NOT EXISTS pending_order_locks (
  buyer_discord_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (buyer_discord_id, product_id)
);

CREATE INDEX IF NOT EXISTS pending_order_locks_expiry_idx
  ON pending_order_locks (expires_at);

-- Discord retries can replay a legitimately signed interaction. Storing its
-- immutable interaction ID makes a purchase or approval idempotent.
CREATE TABLE IF NOT EXISTS processed_discord_interactions (
  interaction_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS processed_discord_interactions_retention_idx
  ON processed_discord_interactions (processed_at);

-- This records the value that the owner manually verified in PayPay. It is an
-- audit record, not an assertion that the Worker read the PayPay account.
CREATE TABLE IF NOT EXISTS order_payment_confirmations (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  confirmed_amount_yen INTEGER NOT NULL CHECK (confirmed_amount_yen >= 1),
  confirmed_at TEXT NOT NULL,
  confirmed_by_discord_id TEXT NOT NULL
);
