# Mock checkout (development only)

This is a **local-only** test of the ordering and delivery decision flow. It does not charge money, send Discord messages, or expose files from R2/Google Drive.

Run `node scripts/mock-checkout.mjs` to exercise the sample purchase and delivery receipt. Do not connect this test to the production Discord purchase panel or enable a public payment bypass.

The latest production deployment succeeded. If a future Discord command registration fails, inspect that specific Actions run rather than relying on historical errors.
