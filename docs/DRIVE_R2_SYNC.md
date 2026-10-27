# Drive → private R2 synchronization (preflight)

The connected ChatGPT Drive account is not a credential for GitHub Actions. Do not copy tokens from chats into source control. The selected Drive folder ID is `1N89122U-CkODfdpaza4sD2bPDxiXd_Br`. A connected account can list the folder, but that does **not** mean Actions can download it.

The synchronizer is intentionally fail-closed: it only transfers explicitly approved video file IDs, never every file in the folder. This matters because the folder contains mixed images and videos and file names alone do not establish resale rights.

Install `@aws-sdk/client-s3` before running. Supply `DRIVE_FOLDER_ID`, `DRIVE_VIDEO_FILE_IDS` (comma-separated, only licensed/approved files), `GOOGLE_DRIVE_ACCESS_TOKEN`, and for apply `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` as environment variables. Run `node scripts/drive-r2-sync.mjs` for preflight; run with `--apply` only after rights and credentials are verified.

**Important:** The Worker currently lists only `products/ロリ/` while this uploader writes to `products/approved/`. This deliberate separation prevents unreviewed files from being sold. Do not change `PRODUCTS_PREFIX` until an explicit content-rights review and an end-to-end mock checkout are complete.

The implementation is a preparatory script, not an operational scheduled sync. Large uploads may need multipart upload and retries; the current simple PutObject path should not be used for multi-gigabyte files.
