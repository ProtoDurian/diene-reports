import type { Identity } from "./auth";
import { DAY, LIMITS, MINUTE, type Env } from "./env";
import { HttpError, gzipText } from "./http";
import { guard, ensureProject, selectProject, upsertCommit, upsertRepo, type RunKey } from "./db";
import type { StartBody, Summary } from "./summary";

type Row = Record<string, unknown>;

const RUN_ID = `(SELECT id FROM runs WHERE repo_id = ?1 AND gh_run_id = ?2 AND gh_run_attempt = ?3 AND flag = ?4 AND job = ?5)`;

const keyParams = (k: RunKey) => [k.repoId, k.ghRunId, k.attempt, k.flag, k.job];

const HEAD_SQL = `EXISTS (SELECT 1 FROM branch_head h WHERE h.project_id = ?6 AND h.flag = ?4 AND h.run_id = ${RUN_ID})`;

export function projectBranch(id: Identity, baseRef: string | null): string {
  if (id.lane === "pr") {
    if (!baseRef) throw new HttpError(400, "baseRef is required for pull_request runs");
    return baseRef;
  }
  return id.branch as string;
}

export function checkBodyIdentity(id: Identity, b: { sha?: string | null; runId?: number | null; runAttempt?: number | null; pr?: number | null }): void {
  if (b.sha != null && b.sha !== id.sha) throw new HttpError(400, "sha does not match token");
  if (b.runId != null && b.runId !== id.runId) throw new HttpError(400, "runId does not match token");
  if (b.runAttempt != null && b.runAttempt !== id.runAttempt) throw new HttpError(400, "runAttempt does not match token");
  if (id.lane === "pr" && b.pr != null && b.pr !== id.pr) throw new HttpError(400, "pr does not match token");
}

const BRANCH_HEAD_SQL = `INSERT INTO branch_head (project_id, flag, run_id) VALUES (?6, ?4, ${RUN_ID})
  ON CONFLICT (project_id, flag) DO UPDATE SET run_id = excluded.run_id
  WHERE (SELECT gh_run_id * 1000 + gh_run_attempt FROM runs WHERE id = branch_head.run_id)
     <= (SELECT gh_run_id * 1000 + gh_run_attempt FROM runs WHERE id = excluded.run_id)`;

// ---------------------------------------------------------------- start

export async function startRun(env: Env, id: Identity, b: StartBody, now: number): Promise<{ runId: number; state: string }> {
  checkBodyIdentity(id, b);
  const branch = projectBranch(id, b.baseRef);
  await guard(env.DB, id, "w", now);
  const key: RunKey = { repoId: id.repoId, ghRunId: id.runId, attempt: id.runAttempt, flag: b.flag, job: b.job };
  const headSha = b.headSha ?? id.sha;
  const deadline = now + (b.timeoutMinutes + 15) * MINUTE;
  const db = env.DB;
  const pid = `(SELECT project_id FROM projects WHERE repo_id = ?1 AND branch = ?2)`;
  const stmts = [
    upsertRepo(db, id, now),
    ensureProject(db, id.repoId, branch, now),
    upsertCommit(db, id, { headSha, branch, pr: id.pr, baseSha: b.baseSha, baseRef: id.lane === "pr" ? b.baseRef : null }, now),
    db
      .prepare(
        `INSERT INTO runs (repo_id, project_id, lane, sha, head_sha, branch, pr, event, actor, flag, job, language, workflow,
           gh_run_id, gh_run_attempt, state, created_at, started_at, deadline_at, timeout_minutes)
         VALUES (?1, ${pid}, ?3, ?4, ?5, ?2, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'started', ?15, ?15, ?16, ?17)
         ON CONFLICT (repo_id, gh_run_id, gh_run_attempt, flag, job) DO NOTHING`,
      )
      .bind(
        id.repoId, branch, id.lane, id.sha, headSha, id.pr, id.event, id.actor, b.flag, b.job, b.language, b.workflow ?? id.workflow,
        id.runId, id.runAttempt, now, deadline, b.timeoutMinutes,
      ),
  ];
  if (id.lane === "branch") {
    stmts.push(
      db
        .prepare(BRANCH_HEAD_SQL.replace("?6", "(SELECT project_id FROM projects WHERE repo_id = ?1 AND branch = ?6)"))
        .bind(...keyParams(key), branch),
    );
  }
  stmts.push(db.prepare(`SELECT id, state FROM runs WHERE repo_id = ?1 AND gh_run_id = ?2 AND gh_run_attempt = ?3 AND flag = ?4 AND job = ?5`).bind(...keyParams(key)));
  const res = await db.batch(stmts);
  const row = res[res.length - 1]!.results[0] as { id: number; state: string } | undefined;
  if (!row) throw new HttpError(500, "run not created");
  return { runId: row.id, state: row.state };
}

// ---------------------------------------------------------------- known-failing

export async function knownFailing(env: Env, id: Identity, flag: string): Promise<string[]> {
  if (id.lane !== "branch") return [];
  const res = await env.DB
    .prepare(
      `SELECT ts.test_id FROM test_stats ts JOIN projects p ON p.project_id = ts.project_id
       WHERE p.repo_id = ?1 AND p.branch = ?2 AND ts.flag = ?3 AND ts.last_status = 'failed'
       ORDER BY ts.test_id LIMIT ${LIMITS.recovered}`,
    )
    .bind(id.repoId, id.branch, flag)
    .all<{ test_id: string }>();
  return res.results.map((r) => r.test_id);
}

// ---------------------------------------------------------------- finish

const COMPLETE_STATES = new Set(["passed", "tests_failed"]);

function isComplete(r: Row): boolean {
  return COMPLETE_STATES.has(r.state as string) && r.t_total !== null && !r.cov_partial && !r.failures_truncated && !r.over_cap;
}

export async function finishRun(
  env: Env,
  id: Identity,
  s: Summary,
  rawText: string,
  now: number,
): Promise<{ runId: number; url: string; missingReport: boolean }> {
  const ctx = s.context;
  checkBodyIdentity(id, { sha: ctx.sha, runId: ctx.runId, runAttempt: ctx.runAttempt, pr: ctx.pr });
  const branch = projectBranch(id, ctx.baseRef);
  await guard(env.DB, id, "w", now);
  const db = env.DB;
  const key: RunKey = { repoId: id.repoId, ghRunId: id.runId, attempt: id.runAttempt, flag: ctx.flag, job: ctx.job };
  const kp = keyParams(key);
  const headSha = ctx.headSha ?? id.sha;

  // 1. read: ensure project, existing run, base candidates
  const compareToBase = id.lane === "branch" || id.lane === "pr";
  const pre = await db.batch([
    ensureProject(db, id.repoId, branch, now),
    selectProject(db, id.repoId, branch),
    db.prepare(`SELECT id, state FROM runs WHERE repo_id = ?1 AND gh_run_id = ?2 AND gh_run_attempt = ?3 AND flag = ?4 AND job = ?5`).bind(...kp),
    db
      .prepare(
        `SELECT id, state, t_total, cov_partial, failures_truncated, over_cap FROM runs
         WHERE project_id = (SELECT project_id FROM projects WHERE repo_id = ?1 AND branch = ?2) AND flag = ?3 AND lane = 'branch'
           AND finished_at IS NOT NULL AND sha <> ?4 AND (?5 = 0 OR gh_run_id < ?6)
         ORDER BY gh_run_id DESC, gh_run_attempt DESC LIMIT 10`,
      )
      .bind(id.repoId, branch, ctx.flag, id.sha, id.lane === "branch" ? 1 : 0, id.runId),
  ]);
  const projectId = (pre[1]!.results[0] as { project_id: number }).project_id;
  const existing = pre[2]!.results[0] as { id: number; state: string } | undefined;
  const isRetry = !!existing && existing.state !== "started" && existing.state !== "lost";
  const baseRun = compareToBase ? (pre[3]!.results as Row[]).find(isComplete) : undefined;
  const baseRunId = baseRun ? (baseRun.id as number) : null;

  // 2. R2: keep the summary (file tree, patch files, sources) for the viewer
  const summaryKey = `sum/${id.repoId}/${id.sha}/${ctx.flag}/${id.runId}-${id.runAttempt}.json.gz`;
  await env.BUCKET.put(summaryKey, await gzipText(rawText), { httpMetadata: { contentType: "application/gzip" } });

  // 3. write: one atomic batch
  const t = s.tests;
  const cov = s.coverage;
  const failures = t ? dedupe(t.failures) : [];
  const failureIds = new Set(failures.map((f) => f.id));
  const recovered = t ? t.recovered.filter((r) => !failureIds.has(r)) : [];
  const testsComplete = !!t && COMPLETE_STATES.has(s.outcome.class) && !t.failuresTruncated;
  const cutoff = now - 30 * DAY;
  const finishedAt = s.outcome.finishedAt ?? now;
  const startedAt = s.outcome.startedAt;

  const stmts: D1PreparedStatement[] = [
    upsertRepo(db, id, now),
    upsertCommit(db, id, { headSha, branch, pr: id.pr, baseSha: ctx.baseSha, baseRef: id.lane === "pr" ? ctx.baseRef : null }, now),
    db
      .prepare(
        `INSERT INTO runs (repo_id, project_id, lane, sha, head_sha, branch, pr, event, actor, flag, job, language, tool, workflow,
           gh_run_id, gh_run_attempt, state, sub_reason, job_failed_after_tests, test_step, job_status, created_at, started_at, finished_at,
           timeout_minutes, t_total, t_passed, t_failed, t_errored, t_skipped, duration_ms, failures_truncated,
           cov_format, cov_lines, cov_lines_hit, cov_branches, cov_branches_hit, cov_partial, patch_lines, patch_lines_hit,
           over_cap, base_run_id, summary_key, notes, warnings)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,
                 ?33,?34,?35,?36,?37,?38,?39,?40,?41,?42,?43,?44,?45)
         ON CONFLICT (repo_id, gh_run_id, gh_run_attempt, flag, job) DO UPDATE SET
           project_id = excluded.project_id, lane = excluded.lane, sha = excluded.sha, head_sha = excluded.head_sha,
           branch = excluded.branch, pr = excluded.pr, event = excluded.event, actor = excluded.actor,
           language = excluded.language, tool = excluded.tool, workflow = excluded.workflow,
           state = excluded.state, sub_reason = excluded.sub_reason, job_failed_after_tests = excluded.job_failed_after_tests,
           test_step = excluded.test_step, job_status = excluded.job_status,
           started_at = COALESCE(runs.started_at, excluded.started_at), finished_at = excluded.finished_at,
           timeout_minutes = COALESCE(excluded.timeout_minutes, runs.timeout_minutes),
           t_total = excluded.t_total, t_passed = excluded.t_passed, t_failed = excluded.t_failed, t_errored = excluded.t_errored,
           t_skipped = excluded.t_skipped, duration_ms = excluded.duration_ms, failures_truncated = excluded.failures_truncated,
           cov_format = excluded.cov_format, cov_lines = excluded.cov_lines, cov_lines_hit = excluded.cov_lines_hit,
           cov_branches = excluded.cov_branches, cov_branches_hit = excluded.cov_branches_hit, cov_partial = excluded.cov_partial,
           patch_lines = excluded.patch_lines, patch_lines_hit = excluded.patch_lines_hit, over_cap = excluded.over_cap,
           base_run_id = excluded.base_run_id, summary_key = excluded.summary_key, notes = excluded.notes, warnings = excluded.warnings`,
      )
      .bind(
        id.repoId, projectId, id.lane, id.sha, headSha, branch, id.pr, id.event, id.actor, ctx.flag, ctx.job, ctx.language, ctx.tool,
        ctx.workflow ?? id.workflow, id.runId, id.runAttempt, s.outcome.class, s.outcome.subReason, s.outcome.jobFailedAfterTests ? 1 : 0,
        s.outcome.testStep, s.outcome.jobStatus, now, startedAt, finishedAt, ctx.timeoutMinutes,
        t ? t.totals.total : null, t ? t.totals.passed : null, t ? t.totals.failed : null, t ? t.totals.errored : null,
        t ? t.totals.skipped : null, t ? t.totals.durationMs : null, t?.failuresTruncated ? 1 : 0,
        cov ? cov.format : null, cov ? cov.totals.lines : null, cov ? cov.totals.linesHit : null,
        cov ? cov.totals.branches : null, cov ? cov.totals.branchesHit : null, cov?.partial ? 1 : 0,
        s.patch ? s.patch.lines : null, s.patch ? s.patch.hit : null,
        s.overCap ? 1 : 0, baseRunId, summaryKey, JSON.stringify(s.outcome.notes), JSON.stringify(s.warnings),
      ),
    db.prepare(`DELETE FROM failures WHERE run_id = ${RUN_ID}`).bind(...kp),
  ];

  const branchStats = id.lane === "branch" && !isRetry;
  if (branchStats && failures.length) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO test_stats (project_id, flag, test_id, name, file, fails_30d, flips_30d, window_start, last_status, last_fail_sha, last_fail_at, updated_at)
           SELECT ?1, ?2, json_extract(j.value, '$.id'), json_extract(j.value, '$.name'), json_extract(j.value, '$.file'),
                  1, 0, ?3, 'failed', ?4, ?3, ?3
           FROM json_each(?5) j WHERE true
           ON CONFLICT (project_id, flag, test_id) DO UPDATE SET
             name = excluded.name, file = excluded.file,
             flips_30d = (CASE WHEN test_stats.window_start < ?6 THEN 0 ELSE test_stats.flips_30d END)
                         + (CASE WHEN test_stats.last_status = 'passed' THEN 1 ELSE 0 END),
             fails_30d = (CASE WHEN test_stats.window_start < ?6 THEN 0 ELSE test_stats.fails_30d END) + 1,
             window_start = CASE WHEN test_stats.window_start < ?6 THEN ?3 ELSE test_stats.window_start END,
             last_status = 'failed', last_fail_sha = excluded.last_fail_sha, last_fail_at = excluded.last_fail_at,
             updated_at = excluded.updated_at`,
        )
        .bind(projectId, ctx.flag, now, headSha, JSON.stringify(failures), cutoff),
    );
  }
  if (branchStats && recovered.length) {
    stmts.push(
      db
        .prepare(
          `UPDATE test_stats SET last_status = 'passed',
             flips_30d = (CASE WHEN window_start < ?3 THEN 0 ELSE flips_30d END) + 1,
             fails_30d = CASE WHEN window_start < ?3 THEN 0 ELSE fails_30d END,
             window_start = CASE WHEN window_start < ?3 THEN ?4 ELSE window_start END,
             updated_at = ?4
           WHERE project_id = ?1 AND flag = ?2 AND last_status = 'failed' AND test_id IN (SELECT value FROM json_each(?5))`,
        )
        .bind(projectId, ctx.flag, cutoff, now, JSON.stringify(recovered)),
    );
  }
  if (failures.length) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO failures (run_id, test_id, suite, name, file, line, status, duration_ms, message, stack, is_new, is_flaky)
           SELECT ${RUN_ID}, json_extract(j.value, '$.id'), json_extract(j.value, '$.suite'), json_extract(j.value, '$.name'),
                  json_extract(j.value, '$.file'), json_extract(j.value, '$.line'), json_extract(j.value, '$.status'),
                  json_extract(j.value, '$.durationMs'), json_extract(j.value, '$.message'), json_extract(j.value, '$.stack'),
                  CASE WHEN ?6 IS NULL THEN NULL
                       WHEN EXISTS (SELECT 1 FROM failures bf WHERE bf.run_id = ?6 AND bf.test_id = json_extract(j.value, '$.id')) THEN 0
                       ELSE 1 END,
                  CASE WHEN EXISTS (
                         SELECT 1 FROM runs r2
                         WHERE r2.repo_id = ?1 AND r2.head_sha = ?7 AND r2.flag = ?4 AND r2.id <> ${RUN_ID}
                           AND r2.state IN ('passed', 'tests_failed') AND r2.t_total IS NOT NULL AND r2.failures_truncated = 0
                           AND NOT EXISTS (SELECT 1 FROM failures f2 WHERE f2.run_id = r2.id AND f2.test_id = json_extract(j.value, '$.id')))
                         OR EXISTS (
                         SELECT 1 FROM test_stats ts
                         WHERE ts.project_id = ?8 AND ts.flag = ?4 AND ts.test_id = json_extract(j.value, '$.id')
                           AND ts.flips_30d >= 2 AND ts.window_start >= ?9)
                       THEN 1 ELSE 0 END
           FROM json_each(?10) j WHERE true`,
        )
        .bind(...kp, baseRunId, headSha, projectId, cutoff, JSON.stringify(failures)),
    );
  }
  if (testsComplete) {
    stmts.push(
      db
        .prepare(
          `UPDATE failures SET is_flaky = 1
           WHERE is_flaky = 0
             AND run_id IN (SELECT r2.id FROM runs r2 WHERE r2.repo_id = ?1 AND r2.head_sha = ?6 AND r2.flag = ?4
                              AND r2.id <> ${RUN_ID} AND r2.state = 'tests_failed')
             AND test_id NOT IN (SELECT test_id FROM failures WHERE run_id = ${RUN_ID})`,
        )
        .bind(...kp, headSha),
    );
  }
  if (id.lane === "branch" && t) {
    stmts.push(
      db
        .prepare(
          `UPDATE test_stats SET flaky_since = COALESCE(flaky_since, ?7)
           WHERE project_id = ?6 AND flag = ?4 AND (
             test_id IN (SELECT f.test_id FROM failures f WHERE f.is_flaky = 1
                           AND f.run_id IN (SELECT r2.id FROM runs r2 WHERE r2.repo_id = ?1 AND r2.head_sha = ?8 AND r2.flag = ?4))
             OR (flips_30d >= 2 AND window_start >= ?9 AND test_id IN (SELECT value FROM json_each(?10))))`,
        )
        .bind(...kp, projectId, now, headSha, cutoff, JSON.stringify([...failures.map((f) => f.id), ...recovered])),
    );
  }
  if (id.lane === "branch") {
    stmts.push(db.prepare(BRANCH_HEAD_SQL).bind(...kp, projectId));
    stmts.push(db.prepare(`DELETE FROM keep_blobs WHERE project_id = ?6 AND flag = ?4 AND ${HEAD_SQL}`).bind(...kp, projectId));
    if (s.sources.length) {
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO keep_blobs (repo_id, project_id, flag, blob_sha)
             SELECT ?1, ?6, ?4, value FROM json_each(?7) WHERE ${HEAD_SQL}`,
          )
          .bind(...kp, projectId, JSON.stringify([...new Set(s.sources.map((x) => x.blob))])),
      );
    }
  }
  stmts.push(db.prepare(`SELECT id, report_key FROM runs WHERE repo_id = ?1 AND gh_run_id = ?2 AND gh_run_attempt = ?3 AND flag = ?4 AND job = ?5`).bind(...kp));

  const res = await db.batch(stmts);
  const row = res[res.length - 1]!.results[0] as { id: number; report_key: string | null } | undefined;
  if (!row) throw new HttpError(500, "run not written");
  return {
    runId: row.id,
    url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/${id.owner}/${id.name}/commit/${id.sha}`,
    missingReport: row.report_key === null && !s.overCap,
  };
}

function dedupe<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

// ---------------------------------------------------------------- run-bound PUTs

export interface OwnedRun {
  id: number;
  repo_id: number;
  sha: string;
  flag: string;
  gh_run_id: number;
  gh_run_attempt: number;
}

export async function ownedRun(env: Env, id: Identity, runId: number): Promise<OwnedRun> {
  const run = await env.DB
    .prepare(`SELECT id, repo_id, sha, flag, gh_run_id, gh_run_attempt FROM runs WHERE id = ?1`)
    .bind(runId)
    .first<OwnedRun>();
  if (!run) throw new HttpError(404, "unknown run");
  if (run.repo_id !== id.repoId || run.gh_run_id !== id.runId || run.gh_run_attempt !== id.runAttempt) {
    throw new HttpError(403, "run does not belong to this token");
  }
  return run;
}

// ---------------------------------------------------------------- cron

export async function sweepLost(db: D1Database, now: number): Promise<number> {
  const r = await db
    .prepare(`UPDATE runs SET state = 'lost', finished_at = ?1 WHERE state = 'started' AND deadline_at < ?1`)
    .bind(now)
    .run();
  return r.meta.changes ?? 0;
}
