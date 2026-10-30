-- diene-reports D1 schema. All timestamps are epoch milliseconds (INTEGER).

CREATE TABLE repos (
  repo_id        INTEGER PRIMARY KEY,
  owner          TEXT NOT NULL,
  name           TEXT NOT NULL,
  visibility     TEXT NOT NULL DEFAULT 'private',
  default_branch TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX repos_slug ON repos (owner, name);

-- project = repo + branch (PR runs land in the project of their base branch)
CREATE TABLE projects (
  project_id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL,
  branch     TEXT NOT NULL,
  alias_of   INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (repo_id, branch)
);

CREATE TABLE blobs (
  repo_id     INTEGER NOT NULL,
  blob_sha    TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  last_ref_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, blob_sha)
);
CREATE INDEX blobs_last_ref ON blobs (last_ref_at);

CREATE TABLE commits (
  repo_id    INTEGER NOT NULL,
  sha        TEXT NOT NULL,
  head_sha   TEXT NOT NULL,
  branch     TEXT NOT NULL,
  pr         INTEGER,
  base_sha   TEXT,
  base_ref   TEXT,
  message    TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, sha)
);
CREATE INDEX commits_pr ON commits (repo_id, pr);

CREATE TABLE runs (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id                INTEGER NOT NULL,
  project_id             INTEGER NOT NULL,
  lane                   TEXT NOT NULL,            -- branch | pr | tag | other
  sha                    TEXT NOT NULL,            -- token sha (merge commit on PRs)
  head_sha               TEXT NOT NULL,
  branch                 TEXT NOT NULL,            -- project branch
  pr                     INTEGER,
  event                  TEXT,
  actor                  TEXT,
  flag                   TEXT NOT NULL,
  job                    TEXT NOT NULL,
  language               TEXT,
  tool                   TEXT,
  workflow               TEXT,
  gh_run_id              INTEGER NOT NULL,
  gh_run_attempt         INTEGER NOT NULL,
  state                  TEXT NOT NULL,            -- started | passed | tests_failed | errored | cancelled | timed_out | lost | no_report | inactive
  sub_reason             TEXT,                     -- gate | setup | crash (errored only)
  job_failed_after_tests INTEGER NOT NULL DEFAULT 0,
  test_step              TEXT,
  job_status             TEXT,
  created_at             INTEGER NOT NULL,
  started_at             INTEGER,
  finished_at            INTEGER,
  deadline_at            INTEGER,
  timeout_minutes        INTEGER,
  t_total                INTEGER,                  -- NULL = no test report
  t_passed               INTEGER,
  t_failed               INTEGER,
  t_errored              INTEGER,
  t_skipped              INTEGER,
  duration_ms            INTEGER,
  failures_truncated     INTEGER NOT NULL DEFAULT 0,
  cov_format             TEXT,
  cov_lines              INTEGER,                  -- NULL = no coverage
  cov_lines_hit          INTEGER,
  cov_branches           INTEGER,
  cov_branches_hit       INTEGER,
  cov_partial            INTEGER NOT NULL DEFAULT 0,
  patch_lines            INTEGER,
  patch_lines_hit        INTEGER,
  over_cap               INTEGER NOT NULL DEFAULT 0,
  base_run_id            INTEGER,                  -- complete base run used for NEW marks; NULL = unknown
  report_key             TEXT,
  summary_key            TEXT,
  notes                  TEXT,                     -- JSON array
  warnings               TEXT,                     -- JSON array
  UNIQUE (repo_id, gh_run_id, gh_run_attempt, flag, job)
);
CREATE INDEX runs_project_flag ON runs (project_id, flag, gh_run_id);
CREATE INDEX runs_pr ON runs (repo_id, pr, flag);
CREATE INDEX runs_sha ON runs (repo_id, sha);
CREATE INDEX runs_head_sha ON runs (repo_id, head_sha, flag);
CREATE INDEX runs_sweep ON runs (state, deadline_at);
CREATE INDEX runs_created ON runs (created_at);

CREATE TABLE failures (
  run_id      INTEGER NOT NULL,
  test_id     TEXT NOT NULL,
  suite       TEXT,
  name        TEXT NOT NULL,
  file        TEXT,
  line        INTEGER,
  status      TEXT NOT NULL,                       -- failed | errored
  duration_ms INTEGER,
  message     TEXT,
  stack       TEXT,
  is_new      INTEGER,                             -- 1 new vs base, 0 not new, NULL unknown (base missing/incomplete)
  is_flaky    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, test_id)
);
CREATE INDEX failures_test ON failures (test_id);

CREATE TABLE test_stats (
  project_id     INTEGER NOT NULL,
  flag           TEXT NOT NULL,
  test_id        TEXT NOT NULL,
  name           TEXT,
  file           TEXT,
  fails_30d      INTEGER NOT NULL DEFAULT 0,
  flips_30d      INTEGER NOT NULL DEFAULT 0,
  window_start   INTEGER NOT NULL,                 -- start of the rolling 30-day counter window
  last_status    TEXT NOT NULL,                    -- failed | passed
  last_fail_sha  TEXT,
  last_fail_at   INTEGER,
  flaky_since    INTEGER,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (project_id, flag, test_id)
);
CREATE INDEX test_stats_failed ON test_stats (project_id, flag, last_status);

CREATE TABLE branch_head (
  project_id INTEGER NOT NULL,
  flag       TEXT NOT NULL,
  run_id     INTEGER NOT NULL,
  PRIMARY KEY (project_id, flag)
);

CREATE TABLE keep_blobs (
  repo_id    INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  flag       TEXT NOT NULL,
  blob_sha   TEXT NOT NULL,
  PRIMARY KEY (project_id, flag, blob_sha)
);
CREATE INDEX keep_blobs_blob ON keep_blobs (repo_id, blob_sha);

-- per (repo, gh run, attempt) write counters for the 429 limit
CREATE TABLE rate (
  repo_id    INTEGER NOT NULL,
  gh_run_id  INTEGER NOT NULL,
  attempt    INTEGER NOT NULL,
  bucket     TEXT NOT NULL,                        -- w = run writes, s = source uploads
  n          INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, gh_run_id, attempt, bucket)
);
