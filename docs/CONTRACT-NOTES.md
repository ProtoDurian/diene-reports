# Contract notes (readings of CONTRACT.md the Worker had to pick)

`CONTRACT.md` is unchanged. Where it was open, the Worker does this:

1. **Rate limit.** The 2000-writes limit (contract change of 2026-10-30) is a D1 counter (table `rate`, migration `0002`, no CF binding)
   keyed by (`repository_id`, `run_id`, `run_attempt`, `flag`, `job`): one budget per test job. `start`, `finish`, `report`,
   `cov`, `raw` and `/sources` all count against it. Run writes take flag/job from the body or the run row; `/sources/check` and
   `PUT /sources/:blob` take `?flag=&job=` (missing → counted under `''`/`''`; invalid values → 400). `known-failing` is a read and is
   not counted. Counters older than 2 days are deleted by the GC cron.
2. **`missingReport`** in the `finish` response is `true` when no `report` PUT reached the run and `overCap` is false.
   (With `overCap` the action deliberately skips the report.)
3. **`keep/` for branch lanes.** There is no `keep/` object in R2. `keep_blobs` rows (D1) hold the source blobs of the newest
   branch-lane run per (project, flag); GC spares them. Every branch lane counts, not only the default branch,
   because the Worker does not know which branch is the default. An older run id retried later cannot replace them.
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
16. **`branch_head`** is ordered by (`gh_run_id`, `gh_run_attempt`), so a late retry of an older run never takes the head.
17. **JWKS.** Cached 1 h. An unknown `kid` forces a refetch, at most once per 30 s. If GitHub is down and nothing is cached → `503`.
    Clock skew allowed: 60 s.
18. **GC** removes up to 10 000 stale blobs per night; the rest wait for the next run. Run rows, failures and commits older
    than 180 d go, except rows that are a `branch_head`.
19. **Public paths.** `/healthz` returns `{"ok":true}`. Everything under `/api/v1` needs a token. The viewer comes in PR 2.
