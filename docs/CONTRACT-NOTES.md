# Contract notes (readings of CONTRACT.md the Worker had to pick)

`CONTRACT.md` is unchanged. Where it was open, the Worker does this:

1. **Rate limit.** The 2000-writes limit (contract change of 2026-10-30) is a D1 counter (table `rate`, migration `0002`, no CF binding)
   keyed by (`repository_id`, `run_id`, `run_attempt`, `flag`, `job`): one budget per test job. `start`, `finish`, `report`,
   `cov`, `raw` and `/sources` all count against it. Run writes take flag/job from the body or the run row; `/sources/check` and
   `PUT /sources/:blob` take `?flag=&job=` (missing → counted under `''`/`''`; invalid values → 400). `known-failing` is a read and is
   not counted. Counters older than 2 days are deleted by the GC cron.
2. **`missingReport`** in the `finish` response is `true` when no `report` PUT reached the run and `overCap` is false.
   (With `overCap` the action deliberately skips the report.)
3. **`keep/` for branch lanes.** The newest finished branch-lane run **with coverage** per (project, flag) is the "coverage head"
   (`branch_head.cov_run_id`). On its `finish` the Worker copies `sum/`, `rep/` and the `cov/` chunks it lists into
   `keep/<repo_id>/<project_id>/<flag>/<run_id>-<attempt>/{sum.json.gz,rep.json.gz,cov/<n>.json.gz}` and deletes the previous
   head's copies. **`keep/` must have no lifecycle expiry.** `keep_blobs` (D1) hold the source blobs of the coverage head, replaced only
   when the finishing coverage head has sources. GC spares them. Every branch lane counts, not only the default branch.
   An older run id retried later cannot replace them. The viewer falls back to `keep/` when `sum/`, `cov/` or `rep/` expired.
4. **Summary kept in R2.** `finish` stores the raw summary as `sum/<repo_id>/<sha>/<flag>/<run>-<attempt>.json.gz`
   (file tree, patch files, source list for the viewer). Lifecycle: 90 d, like `rep/`.
5. **`failures` > 200** are cut to 200 and `failuresTruncated=true`; the Worker does not return `400`.
   `message` is cut to 4 KB and `stack` to 16 KB, instead of rejecting.
   `tests.recovered` above 5000 ids is rejected with `400`. Duplicate failure ids in one finish keep the first.
6. **Invalid ids.** Test ids must match `[A-Za-z0-9_-]{1,64}`; flag names are limited to `[A-Za-z0-9._-]{1,50}` and job names to `[A-Za-z0-9._-]{1,100}`.
   Anything else is `400`.
7. **Bodies without `Content-Length`** are buffered (capped) and then written to R2, because R2 needs a known length.
   With `Content-Length` the body is streamed. A declared length over the cap is `413` before reading; a lying length is
   caught while reading.
8. **Coverage chunk cap.** 4 MB gzipped per chunk. Chunk index 0..99999. Raw names: `[A-Za-z0-9._-]{1,100}`.
9. **Report / raw key collision.** `rep/` and `cov/` keys include the flag; `raw/` includes flag and file name but not the
   job. Two jobs with the same flag in one run overwrite each other's report. Use distinct flags.
10. **PR lane needs `baseRef`.** `start` and `finish` return `400` without it (the project branch is the PR's base branch).
    The body `pr` must equal the number in the token's ref (`400` otherwise).
11. **Outcome classes accepted from the action:** `passed | tests_failed | errored | cancelled | timed_out | no_report | inactive`.
    `lost` and `started` are Worker-only states (`400` if sent). `subReason` is stored for `errored` only.
12. **NEW marks.** Base = newest finished branch-lane run of the same project+flag on another sha (for a branch run:
    an older `run_id`) whose state is `passed|tests_failed`, has tests, no partial coverage, not truncated, not `overCap`.
    Looks at the last 10 candidates. No usable base → `is_new = NULL` (unknown, the viewer shows no NEW mark).
    Tag and other lanes get no base.
13. **FLAKY marks.** Flaky when another complete run of the same `head_sha` + flag ran the test without failure (checked both
    ways, so the earlier failure is marked retroactively), or when the test flipped ≥ 2 times in the last 30 days on that
    branch. `flaky_since` is set on first detection.
14. **Stats window.** `test_stats` keeps `fails_30d` / `flips_30d` as a counter that restarts when `window_start` is older
    than 30 days (a rolling approximation, not exact per-day counts). A finish retry (same run key already finished) does not
    count again.
15. **`started_at`.** From the `start` record. An orphan `finish` uses `outcome.startedAt`, otherwise it stays NULL.
    `deadline_at` = `start` time + `timeoutMinutes` + 15 min. A run past its deadline is `lost`; a later `finish` replaces it.
16. **`branch_head`** is set on `finish` only (never on `start`), ordered by (`gh_run_id`, `gh_run_attempt`), so a late retry of an
    older run never takes the head. `run_id` = newest finished branch run with tests or coverage; `cov_run_id` = newest with coverage
    (badge, `keep/`). A cancelled, lost or crashed run with neither never becomes the head. Migration `0003`.
17. **JWKS.** Cached 1 h. An unknown `kid` forces a refetch, at most once per 30 s. If GitHub is down and nothing is cached → `503`.
    Clock skew allowed: 60 s.
18. **GC** removes up to 10 000 stale blobs per night; the rest wait for the next run. Run rows, failures and commits older
    than 180 d go, except rows that are a `branch_head`.
19. **Public paths.** `/healthz` returns `{"ok":true}`. Everything under `/api/v1` needs a token. The viewer comes in PR 2.
20. **`headSha`.** Taken from the body only on the `pr` lane; on branch, tag and other lanes it is forced to the token's `sha`.
    `headSha` and `baseSha` must be 40 lowercase hex chars (`400` otherwise). The same-commit FLAKY rule only compares runs of the
    same lane. A PR cannot mark a branch failure flaky.
21. **Shape checks.** `coverage.files[]` (`path`, `lines`, `hit ≤ lines`, `chunk`), `patch.files[]` (`path`, `lines`, `hit`, `uncovered`: ints,
    max 5000) and `raw[]` (`name` regex, `kind`, `bytes`) are validated; a wrong shape is `400`. Inconsistent totals are clamped
    (`linesHit`/`branchesHit`/patch `hit` to their totals, tests `total` raised to the sum of its parts) with an entry in `warnings`.
22. **Failure JSON size.** If the failures of one finish exceed ~1.9 MB as JSON (D1 binds at most ~2 MB per value), messages and stacks
    are shortened step by step and a warning is stored. The raw summary in `sum/` is unchanged.
23. **`workers.dev` deviation from CONTRACT §0.** `workers_dev` is `false`, so the Worker is **not** reachable at
    `diene-reports.kirinnee.workers.dev` (that host sits outside Cloudflare Access). Only `reports.atomi.cloud` serves it.
    The viewer additionally verifies the `Cf-Access-Jwt-Assertion` JWT itself (vars `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) and answers `403` without it.

## Viewer (PR 2)

24. **Flag chooser, no cross-flag merge.** `/commit/<sha>/coverage` without `?flag=` and with several flags shows a chooser
    instead of merging flags (each flag measures a different test run).
25. **`tests` badge name is reserved.** `/badge/<o>/<r>/tests.svg` is the pass/fail badge; a coverage flag called `tests`
    has no badge. Other flags give coverage badges. Unknown repo/branch/flag → grey "unknown"; private repo → grey "private".
26. **Raw downloads** are served by run id: `/<owner>/<repo>/run/<id>/raw/<name>`, gunzipped, `Content-Disposition: attachment`,
    `application/octet-stream`, CSP `default-src 'none'; sandbox`.
27. **Changed lines on the file page** come from the report's `diff.files` when the stored report is ≤ 6 MB; above that, only
    the patch's uncovered changed lines are marked. Source and report expire from R2 (90 d); the page then links to GitHub.
28. **Commit/PR pages** list the worst state first (tests failed, errored, timed out, lost, cancelled, no report, running,
    inactive, passed), then by flag name. For a commit the pages use the latest attempt per job.
29. **Times** are shown in UTC. Coverage colours: ≥ 80 % green, ≥ 60 % amber, else red.
30. **The viewer checks Cloudflare Access itself** (review #4). Every route except `/healthz`, `/api/v1/*` and
    `/badge/<owner>/<repo>/<flag>` needs a valid `Cf-Access-Jwt-Assertion` (RS256, `iss` = ACCESS_TEAM_DOMAIN, `aud` contains
    ACCESS_AUD, exp/nbf with 60 s skew; keys from `<team>/cdn-cgi/access/certs`). Anything else is 403 (fail closed, also when
    the vars are empty). `/assets/*` is guarded. An owner named `api` or `badge` cannot bypass it. **Deviation from §0:**
    `workers_dev` stays `false`; the Worker is only reachable at `reports.atomi.cloud`.
31. **Badges and heads** (review #1). `branch_head` is set on finish only. The tests badge uses the newest finished branch run
    with tests or coverage; the coverage badge uses the newest finished branch run with coverage (`cov_run_id`). A started,
    cancelled or crashed newer run no longer blanks them. Home and repo pages show coverage from that run and say which commit it is from.
32. **keep/ fallback** (review #2). The viewer reads `sum/`, `cov/` and `rep/` first and falls back to the `keep/` copy of the
    branch-head run, which never expires. Non-head runs expire after 90 days and the page says so.
33. **All-tests page** (review #3): `/:owner/:repo/run/:id/tests` lists every test of a run from `rep/` (failed and errored open;
    skipped and passed folded, 2000 per group). If the gzipped report is over 5 MiB, or has expired, the page says so.
    The 200-failure cap note on the run card links to it.
34. **Stored documents are sanitized when read** (review #5): malformed coverage/patch/sources/raw entries are dropped and
    `uncovered` defaults to `[]`, so one bad upload cannot break a page.
35. **`job failed`** (review #6): a run whose tests passed but whose job failed afterwards shows a warn-tone "job failed" chip
    and ranks above passed. `inactive` runs are neutral and are left out of the "Not everything went well" banner.
36. **Patch coverage is per flag** (review #7); flags are never added together.
37. **Commit URLs need the full 40-character sha** (review #11); a shorter one is a 404 with a hint.
38. **Test history** lists the runs from the newest to the oldest recorded failure and says "no failure reported" for the
    others, because only failures are stored in D1; an absent or skipped test is not "passed".
39. **Raw files** are streamed through gzip only when the stored object starts with the gzip magic bytes; otherwise 404.
