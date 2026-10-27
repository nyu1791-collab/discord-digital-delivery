# Mock checkout (development only)

This is a **local-only** test of the ordering and delivery decision flow. It does not charge money, send Discord messages, or expose files from R2/Google Drive.

Run `node scripts/mock-checkout.mjs` to exercise the sample purchase and delivery receipt. Do not connect this test to the production Discord purchase panel or enable a public payment bypass.

The production deployment currently fails Discord command registration with HTTP 401. Rotate `DISCORD_BOT_TOKEN` in GitHub Actions secrets (never commit it) before attempting real Discord interactions.
