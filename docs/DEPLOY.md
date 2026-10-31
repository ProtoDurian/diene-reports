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
- Where it can be installed: any account. The App is **only for sign-in** now: a user's own token decides whether they may see a private repo, so the App
  does not have to be installed anywhere for that. (Install it on an owner only if you also want the optional installation-token fallback of step e.)
- Generate a client secret.

**b. The client id** is already set in `wrangler.jsonc` (`vars.GITHUB_CLIENT_ID = "Iv23liYO0YI12YeI2S5S"`). It is not secret. Login stays off
(`/login` answers 503) while it is `TBD` or empty. The client id + secret are also used (HTTP Basic) to revoke tokens on sign-out. Public/private is decided by the visibility relay instead (step e).

**c. Set the two secrets** (never commit them):

```sh
wrangler secret put GITHUB_CLIENT_SECRET     # paste the App's client secret
openssl rand -base64 32 | wrangler secret put SESSION_KEY   # 32 random bytes, base64
```

`SESSION_KEY` encrypts the stored GitHub tokens and signs the login state. Changing it signs everybody out (existing sessions cannot
be decrypted, they are treated as signed out and cleaned up by the cron). Keep a copy only in your secret store.

**d. Apply migrations `0004_sessions.sql`, `0005_repo_visibility_checked.sql` and `0006_app_installations.sql`** (step 2, `--remote`) before deploying.
Without `0005` the viewer cannot read `repos.vis_checked_at` and every viewer page errors; `0006` caches the installation id per owner.

**e. Repo visibility: the GitHub Actions relay** (main path, no key, no secret). Whether a repo is public decides who may view it, so the
Worker has to know. GitHub rate-limits unauthenticated calls per shared Cloudflare IP (60/h; seen failing after 2), and the App is not
installed, so the Worker does not ask GitHub itself. Instead `.github/workflows/visibility.yaml` in this repo runs every 30 min
(and on `workflow_dispatch`), lists the org's public repos with its own `GITHUB_TOKEN` and posts them to `POST /api/v1/visibility`,
authenticated with its OIDC token (audience `diene-reports`, same as uploads).

- `vars.VISIBILITY_REPORTERS` (in `wrangler.jsonc`): comma list of `owner/repo` allowed to post. Default `ProtoDurian/diene-reports`.
  A post is accepted only from such a repository, on `refs/heads/main`, for `event_name` `schedule` or `workflow_dispatch`; else 403.
  The body's `owner` must be the token's `repository_owner`.
- Listed repos become `public` (and a renamed `full_name` is stored). With `complete: true` (every page of the listing read) every other repo of that
  owner becomes `private`. A failed or partial listing never posts, and `complete: false` never makes anything private.
- Nothing to install or store. Run it once after deploying: Actions, "Visibility relay", Run workflow (or `gh workflow run visibility.yaml`),
  then check the log shows `HTTP 200` and the counts.
- The Worker's own checks stay as a **fallback**: the 30-min cron and the inline re-check (public repos not confirmed for 6 h) still call
  `GET /repositories/{id}`, as the App installation if `GITHUB_APP_PRIVATE_KEY_B64` is set and the App is installed on the owner, else unauthenticated
  (60/h/IP; a rate-limited check is skipped and the viewer says "try again" for an unconfirmable public repo). Because the relay refreshes
  `vis_checked_at` every 30 min, the inline re-check normally never fires. If the relay stops for more than 6 h, public repos go to "try again"
  (fail closed) until it runs again.
- Optional fallback key: generate a private key on the App's settings page and `base64 -w0 < key.pem | wrangler secret put GITHUB_APP_PRIVATE_KEY_B64`;
  install the App with Repository permission Metadata: read on each owner. Not needed for the relay.

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
Screenshots of every page, light and dark, 1280 px and 390 px: `docs/screenshots/`.
