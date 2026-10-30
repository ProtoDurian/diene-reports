-- rate counters are per test job (repo, gh run, attempt, flag, job), one bucket; the counters are ephemeral
DROP TABLE rate;
CREATE TABLE rate (
  repo_id    INTEGER NOT NULL,
  gh_run_id  INTEGER NOT NULL,
  attempt    INTEGER NOT NULL,
  flag       TEXT NOT NULL,                        -- '' when a /sources call did not say
  job        TEXT NOT NULL,
  n          INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, gh_run_id, attempt, flag, job)
);
