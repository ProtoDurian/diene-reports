# Deploy

Needs a Cloudflare login that can edit Workers, D1 and R2 on the account that owns `atomi.cloud`.
Nothing here runs in CI.

## 1. Install

```sh
bun install --frozen-lockfile
bun run typecheck && bun run test
```

## 2. Database

The D1 database `diene_reports` already exists (id in `wrangler.jsonc`).

```sh
wrangler d1 migrations apply diene_reports --remote
```

Run it again after every release that adds a file to `migrations/`. Apply it **before** deploying the Worker.

## 3. Worker

```sh
wrangler deploy
```

This sets the custom domain `reports.atomi.cloud`, both crons and the vars. `workers_dev` is off on purpose:
the `*.workers.dev` host is not behind Cloudflare Access.

## 4. R2 lifecycle rules (once)

Bucket `diene-reports`. Source blobs (`src/`) are deleted by the daily cron, not by R2.

```sh
wrangler r2 bucket lifecycle add diene-reports raw-30d raw/ --expire-days 30
wrangler r2 bucket lifecycle add diene-reports rep-90d rep/ --expire-days 90
wrangler r2 bucket lifecycle add diene-reports cov-90d cov/ --expire-days 90
wrangler r2 bucket lifecycle add diene-reports sum-90d sum/ --expire-days 90
wrangler r2 bucket lifecycle list diene-reports
```

## 5. Cloudflare Access

- Access app on `reports.atomi.cloud` for people (the viewer).
- Bypass policy for `/api/v1/*` (GitHub OIDC is the auth there) and `/badge/*`.
- Leave `/healthz` behind Access or add it to the bypass; it only returns `{"ok":true}`.

## 6. Check

```sh
curl -s https://reports.atomi.cloud/healthz            # {"ok":true} (through Access)
curl -si https://reports.atomi.cloud/api/v1/runs/known-failing?flag=x   # 401 without a token
```

## Local

```sh
wrangler d1 migrations apply diene_reports --local
wrangler dev
```
