CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  buyer_discord_id TEXT NOT NULL,
  guild_id TEXT,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'awaiting_manual_acceptance',
    'approved',
    'cancelled',
    'expired'
  )),
  paypay_receive_link_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_by_discord_id TEXT,
  approved_at TEXT,
  approved_by_discord_id TEXT,
  cancelled_at TEXT,
  cancelled_by_discord_id TEXT,
  download_uses INTEGER NOT NULL DEFAULT 0 CHECK (download_uses >= 0),
  last_downloaded_at TEXT
);

CREATE INDEX IF NOT EXISTS orders_buyer_created_idx
  ON orders (buyer_discord_id, created_at DESC);

CREATE INDEX IF NOT EXISTS orders_status_expiry_idx
  ON orders (status, expires_at);

CREATE TABLE IF NOT EXISTS order_audit_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  actor_discord_id TEXT,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS order_audit_order_idx
  ON order_audit_events (order_id, created_at ASC);
