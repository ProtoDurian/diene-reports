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

This sets the custom domain `reports.atomi.cloud`, the three crons (every 15 min lost-run sweep, every 30 min repo-visibility re-check, daily 03:17 cleanup) and the vars. `workers_dev` is off on purpose:
only `reports.atomi.cloud` serves the Worker. Set the secrets in section 5 **before** the first deploy that has `GITHUB_CLIENT_ID` filled in.

## 4. R2 lifecycle rules (once)

Bucket `diene-reports`. Source blobs (`src/`) are deleted by the daily cron, not by R2.

```sh
wrangler r2 bucket lifecycle add diene-reports raw-30d raw/ --expire-days 30
wrangler r2 bucket lifecycle add diene-reports rep-90d rep/ --expire-days 90
wrangler r2 bucket lifecycle add diene-reports cov-90d cov/ --expire-days 90
wrangler r2 bucket lifecycle add diene-reports sum-90d sum/ --expire-days 90
wrangler r2 bucket lifecycle list diene-reports
```

**Do not add a rule for `keep/`.** It holds the newest coverage run of each branch and flag (replaced on every finish) and never expires.

## 5. Sign in with GitHub

The viewer has its own login (no Cloudflare Access, no Zero Trust, no VPN). Public repos are open to everyone; private and internal
repos only to signed-in users that GitHub says can see the repo.

**a. Create a GitHub App** (in the `ProtoDurian` org settings, Developer settings, GitHub Apps):

- Callback URL: `https://reports.atomi.cloud/auth/callback`
- Expire user authorization tokens: **on** (default). The Worker refreshes them.
- Request user authorization during installation, Webhook: **off**
- Permissions: **Repository, Metadata: read-only** (this is all that is needed to ask "can this user see this repo").
  No account permissions.
- Where it can be installed: any account. **Install the App on every org/repo whose private projects should be visible.**
  A user only sees a private repo in the viewer when the App can see it **and** they can.
- Generate a client secret.

**b. The client id** is already set in `wrangler.jsonc` (`vars.GITHUB_CLIENT_ID = "Iv23liYO0YI12YeI2S5S"`). It is not secret. Login stays off
(`/login` answers 503) while it is `TBD` or empty. The client id + secret are also used (HTTP Basic) to revoke tokens on sign-out. Visibility checks use the App installation instead (step e).

**c. Set the two secrets** (never commit them):

```sh
wrangler secret put GITHUB_CLIENT_SECRET     # paste the App's client secret
openssl rand -base64 32 | wrangler secret put SESSION_KEY   # 32 random bytes, base64
```

`SESSION_KEY` encrypts the stored GitHub tokens and signs the login state. Changing it signs everybody out (existing sessions cannot
be decrypted, they are treated as signed out and cleaned up by the cron). Keep a copy only in your secret store.

**d. Apply migrations `0004_sessions.sql`, `0005_repo_visibility_checked.sql` and `0006_app_installations.sql`** (step 2, `--remote`) before deploying.
Without `0005` the viewer cannot read `repos.vis_checked_at` and every viewer page errors; `0006` caches the installation id per owner.

**e. Visibility checks as the App installation** (needs the App's private key). GitHub rejects the client id/secret on
`GET /repositories/{id}` and rate-limits unauthenticated calls to 60/hour per shared Cloudflare IP, so the cron and the inline re-check
authenticate as the App **installation**:

1. On the App's settings page, **Generate a private key** (downloads a `.pem`, PKCS#1 `BEGIN RSA PRIVATE KEY`; PKCS#8 also works).
2. Store it as a secret, base64 of the whole file (one line), never committed:

   ```sh
   base64 -w0 < your-app.private-key.pem | wrangler secret put GITHUB_APP_PRIVATE_KEY_B64
   ```

3. `vars.GITHUB_APP_ID = "5545592"` is already in `wrangler.jsonc` (the numeric **App ID**, not the client id).
4. **Install the App on every owner (org or user) whose repos are uploaded**, with Repository permission **Metadata: read**.
   The Worker finds the installation per owner (`GET /orgs/{owner}/installation`, then `/users/{owner}/installation`) and caches
   the id in D1 (a "not installed" answer is retried after 1 h; install the App and it is picked up within the hour).

Without the key or the app id, or for an owner without the installation, checks fall back to **unauthenticated**
`GET /repositories/{id}`: public repos are confirmed, private ones answer 404 (so stay private), but the 60/hour/IP limit applies and
rate-limited checks are skipped (the viewer shows "try again" for an unconfirmable public repo). Public repos are re-confirmed every 6 h.

**f. Remove the old Cloudflare Access apps** for `reports.atomi.cloud` (and their bypass policies), if any exist. The Worker ignores
`Cf-Access-Jwt-Assertion` now, so leaving them in place only blocks people.

## 6. Check

```sh
curl -s https://reports.atomi.cloud/healthz                              # {"ok":true}
curl -si https://reports.atomi.cloud/api/v1/runs/known-failing?flag=x    # 401 without a token
curl -si https://reports.atomi.cloud/login | head -3                     # 302 to github.com/login/oauth/authorize (503 = not configured)
curl -si https://reports.atomi.cloud/SomeOrg/some-private-repo | head -1 # 404 when signed out
```

Then open `https://reports.atomi.cloud/` in a browser, click **Sign in with GitHub**, and open a private project you can see.

## Local

```sh
bun run seed                 # fills local D1 + R2 with every outcome class (demo-app, PR #7, a private repo)
bun run dev                  # wrangler dev; public repos work with no login setup
# open http://localhost:8787/ProtoDurian/demo-app/commit/0000000000000000000000000000000000000003
```

To try sign-in locally you need a GitHub App of your own with callback `http://localhost:8787/auth/callback`. Put its secrets in
`.dev.vars` (git-ignored; `wrangler dev` reads it) and override the vars on the command line:

```sh
printf 'GITHUB_CLIENT_SECRET=...\nSESSION_KEY=%s\n' "$(openssl rand -base64 32)" > .dev.vars
wrangler dev --var GITHUB_CLIENT_ID:Iv1.yourid --var PUBLIC_BASE_URL:http://localhost:8787
```

The seed runs the real API against in-memory shims and copies the result into the local wrangler state.
Screenshots of the commit page: `docs/screenshots/`.
