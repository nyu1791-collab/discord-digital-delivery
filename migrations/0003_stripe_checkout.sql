-- Checkout sessions are created by the Worker before the buyer is redirected
-- to Stripe. The immutable terms prevent a later R2/catalog update from
-- changing what an already-paid buyer receives.
CREATE TABLE IF NOT EXISTS stripe_checkout_sessions (
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
);

CREATE INDEX IF NOT EXISTS stripe_checkout_sessions_status_expiry_idx
  ON stripe_checkout_sessions (status, checkout_expires_at);
