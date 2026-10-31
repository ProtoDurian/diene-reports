import type { Env } from "../env";
import type { RunRow } from "./format";

export interface Repo {
  repo_id: number;
  owner: string;
  name: string;
  visibility: string;
  default_branch: string | null;
  vis_checked_at: number;
}
export interface FailureRow {
  run_id: number;
  test_id: string;
  suite: string | null;
  name: string;
  file: string | null;
  line: number | null;
  status: string;
  duration_ms: number | null;
  message: string | null;
  stack: string | null;
  is_new: number | null;
  is_flaky: number;
}

export async function findRepo(env: Env, owner: string, name: string): Promise<Repo | null> {
  return env.DB
    .prepare(`SELECT repo_id, owner, name, visibility, default_branch, vis_checked_at FROM repos WHERE owner = ?1 COLLATE NOCASE AND name = ?2 COLLATE NOCASE`)
    .bind(owner, name)
    .first<Repo>();
}

const LATEST = `ORDER BY gh_run_id DESC, gh_run_attempt DESC`;

/** latest attempt of every (flag, job) for these runs, sorted by flag */
export function latestPerJob(rows: RunRow[]): RunRow[] {
  const best = new Map<string, RunRow>();
  for (const r of rows) {
    const k = `${r.flag}\0${r.job}`;
    const cur = best.get(k);
    if (!cur || r.gh_run_id * 1000 + r.gh_run_attempt > cur.gh_run_id * 1000 + cur.gh_run_attempt) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => a.flag.localeCompare(b.flag) || a.job.localeCompare(b.job));
}

/** `sha` must be a full 40-character commit id (the routes enforce it) */
export async function runsForSha(env: Env, repoId: number, sha: string): Promise<RunRow[]> {
  const bySha = await env.DB.prepare(`SELECT * FROM runs WHERE repo_id = ?1 AND sha = ?2 ${LATEST}`).bind(repoId, sha).all<RunRow>();
  if (bySha.results.length) return bySha.results;
  return (await env.DB.prepare(`SELECT * FROM runs WHERE repo_id = ?1 AND head_sha = ?2 ${LATEST} LIMIT 200`).bind(repoId, sha).all<RunRow>()).results;
}

export async function failuresFor(env: Env, runIds: number[]): Promise<Map<number, FailureRow[]>> {
  const out = new Map<number, FailureRow[]>();
  if (!runIds.length) return out;
  const res = await env.DB
    .prepare(
      `SELECT * FROM failures WHERE run_id IN (SELECT value FROM json_each(?1))
       ORDER BY run_id, CASE status WHEN 'failed' THEN 0 ELSE 1 END, is_new DESC, rowid`,
    )
    .bind(JSON.stringify(runIds))
    .all<FailureRow>();
  for (const f of res.results) (out.get(f.run_id) ?? out.set(f.run_id, []).get(f.run_id)!).push(f);
  return out;
}

export async function commitInfo(env: Env, repoId: number, sha: string) {
  return env.DB
    .prepare(`SELECT sha, head_sha, branch, pr, base_ref, message, created_at FROM commits WHERE repo_id = ?1 AND (sha = ?2 OR head_sha = ?2) LIMIT 1`)
    .bind(repoId, sha)
    .first<{ sha: string; head_sha: string; branch: string; pr: number | null; base_ref: string | null; message: string | null; created_at: number }>();
}

export async function projectsOf(env: Env, repoId: number): Promise<string[]> {
  const r = await env.DB
    .prepare(
      `SELECT p.branch FROM projects p WHERE p.repo_id = ?1 AND EXISTS (SELECT 1 FROM runs r WHERE r.project_id = p.project_id)
       ORDER BY (SELECT MAX(r.gh_run_id) FROM runs r WHERE r.project_id = p.project_id) DESC`,
    )
    .bind(repoId)
    .all<{ branch: string }>();
  return r.results.map((x) => x.branch);
}

export async function projectId(env: Env, repoId: number, branch: string): Promise<number | null> {
  const r = await env.DB.prepare(`SELECT project_id FROM projects WHERE repo_id = ?1 AND branch = ?2`).bind(repoId, branch).first<{ project_id: number }>();
  return r ? r.project_id : null;
}

/** run = newest finished branch run with tests or coverage; cov = newest finished branch run with coverage */
export interface Head {
  flag: string;
  run: RunRow;
  cov: RunRow | null;
}

export async function branchHeads(env: Env, pid: number): Promise<Head[]> {
  const res = await env.DB
    .prepare(
      `SELECT h.cov_run_id AS h_cov, r.* FROM branch_head h JOIN runs r ON r.id = h.run_id WHERE h.project_id = ?1 ORDER BY r.flag`,
    )
    .bind(pid)
    .all<RunRow & { h_cov: number | null }>();
  const ids = res.results.map((r) => r.h_cov).filter((x): x is number => x !== null);
  const covs = new Map<number, RunRow>();
  if (ids.length) {
    const c = await env.DB.prepare(`SELECT * FROM runs WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids)).all<RunRow>();
    for (const r of c.results) covs.set(r.id, r);
  }
  return res.results.map(({ h_cov, ...run }) => ({ flag: run.flag, run: run as RunRow, cov: h_cov === null ? null : (covs.get(h_cov) ?? null) }));
}

/** the head run with its coverage columns taken from the coverage head, for rows that show state + coverage */
export const headWithCoverage = (h: Head): RunRow =>
  h.cov ? { ...h.run, cov_lines: h.cov.cov_lines, cov_lines_hit: h.cov.cov_lines_hit, cov_partial: h.cov.cov_partial } : h.run;

export async function homeRows(env: Env) {
  const res = await env.DB
    .prepare(
      `SELECT rp.owner, rp.name, rp.visibility, rp.vis_checked_at, rp.default_branch, p.branch, c.cov_lines AS c_lines, c.cov_lines_hit AS c_hit, c.cov_partial AS c_partial, r.* FROM branch_head h
       JOIN projects p ON p.project_id = h.project_id JOIN repos rp ON rp.repo_id = p.repo_id JOIN runs r ON r.id = h.run_id
       LEFT JOIN runs c ON c.id = h.cov_run_id
       ORDER BY rp.owner, rp.name, p.branch, r.flag`,
    )
    .all<RunRow & { owner: string; name: string; visibility: string; vis_checked_at: number; default_branch: string | null; c_lines: number | null; c_hit: number | null; c_partial: number | null }>();
  return res.results.map(({ c_lines, c_hit, c_partial, ...r }) =>
    c_lines === null ? r : { ...r, cov_lines: c_lines, cov_lines_hit: c_hit, cov_partial: c_partial ?? 0 },
  );
}

export async function recentCommits(env: Env, pid: number, limit = 25) {
  const res = await env.DB
    .prepare(
      `SELECT r.sha, MAX(r.gh_run_id) AS last_run, MAX(COALESCE(r.finished_at, r.created_at)) AS at, c.message
       FROM runs r LEFT JOIN commits c ON c.repo_id = r.repo_id AND c.sha = r.sha
       WHERE r.project_id = ?1 AND r.lane = 'branch' GROUP BY r.sha ORDER BY last_run DESC LIMIT ?2`,
    )
    .bind(pid, limit)
    .all<{ sha: string; last_run: number; at: number; message: string | null }>();
  if (!res.results.length) return [];
  const runs = await env.DB
    .prepare(`SELECT * FROM runs WHERE project_id = ?1 AND lane = 'branch' AND sha IN (SELECT value FROM json_each(?2))`)
    .bind(pid, JSON.stringify(res.results.map((r) => r.sha)))
    .all<RunRow>();
  const by = new Map<string, RunRow[]>();
  for (const r of runs.results) (by.get(r.sha) ?? by.set(r.sha, []).get(r.sha)!).push(r);
  return res.results.map((c) => ({ ...c, runs: latestPerJob(by.get(c.sha) ?? []) }));
}

export async function recentPrs(env: Env, pid: number, limit = 15) {
  const res = await env.DB
    .prepare(
      `SELECT pr, MAX(gh_run_id) AS last_run, MAX(COALESCE(finished_at, created_at)) AS at FROM runs
       WHERE project_id = ?1 AND lane = 'pr' AND pr IS NOT NULL GROUP BY pr ORDER BY last_run DESC LIMIT ?2`,
    )
    .bind(pid, limit)
    .all<{ pr: number; last_run: number; at: number }>();
  if (!res.results.length) return [];
  const all = await env.DB
    .prepare(`SELECT * FROM runs WHERE project_id = ?1 AND lane = 'pr' AND pr IN (SELECT value FROM json_each(?2)) ${LATEST} LIMIT 1500`)
    .bind(pid, JSON.stringify(res.results.map((p) => p.pr)))
    .all<RunRow>();
  const byPr = new Map<number, RunRow[]>();
  for (const r of all.results) (byPr.get(r.pr!) ?? byPr.set(r.pr!, []).get(r.pr!)!).push(r);
  return res.results.map((p) => {
    const runs = (byPr.get(p.pr) ?? []).slice(0, 50);
    const head = runs[0]?.head_sha;
    return { ...p, head, runs: latestPerJob(runs.filter((r) => r.head_sha === head)) };
  });
}

export async function covTrend(env: Env, pid: number, flag: string, limit = 40) {
  const r = await env.DB
    .prepare(
      `SELECT cov_lines, cov_lines_hit, sha, COALESCE(finished_at, created_at) AS at FROM runs WHERE project_id = ?1 AND flag = ?2 AND lane = 'branch' AND cov_lines IS NOT NULL
       ORDER BY gh_run_id DESC, gh_run_attempt DESC LIMIT ?3`,
    )
    .bind(pid, flag, limit)
    .all<{ cov_lines: number; cov_lines_hit: number; sha: string; at: number }>();
  return r.results.reverse();
}

export async function prRuns(env: Env, repoId: number, pr: number): Promise<RunRow[]> {
  return (await env.DB.prepare(`SELECT * FROM runs WHERE repo_id = ?1 AND lane = 'pr' AND pr = ?2 ${LATEST} LIMIT 200`).bind(repoId, pr).all<RunRow>()).results;
}

export async function runById(env: Env, repoId: number, id: number): Promise<RunRow | null> {
  return env.DB.prepare(`SELECT * FROM runs WHERE id = ?1 AND repo_id = ?2`).bind(id, repoId).first<RunRow>();
}

export interface TestHistoryRow {
  id: number;
  sha: string;
  head_sha: string;
  at: number;
  gh_run_id: number;
  failed: string | null;
  status: string | null;
  message: string | null;
  is_flaky: number | null;
}

/**
 * Only failures are stored, so "no failure" cannot tell a pass from a run where the test did not exist or was
 * skipped. The list stops at the oldest recorded failure (the test certainly existed from there on).
 */
export async function testHistory(env: Env, pid: number, flag: string, testId: string, limit = 60) {
  const rows = (
    await env.DB
      .prepare(
        `SELECT r.id, r.sha, r.head_sha, COALESCE(r.finished_at, r.created_at) AS at, r.gh_run_id,
                f.test_id AS failed, f.status, f.message, f.is_flaky
         FROM runs r LEFT JOIN failures f ON f.run_id = r.id AND f.test_id = ?3
         WHERE r.project_id = ?1 AND r.flag = ?2 AND r.lane = 'branch' AND r.state IN ('passed', 'tests_failed') AND r.t_total IS NOT NULL
         ORDER BY r.gh_run_id DESC, r.gh_run_attempt DESC LIMIT ?4`,
      )
      .bind(pid, flag, testId, limit)
      .all<TestHistoryRow>()
  ).results;
  let oldest = -1;
  rows.forEach((r, i) => {
    if (r.failed) oldest = i;
  });
  return rows.slice(0, oldest + 1);
}

export async function testStatsFor(env: Env, pid: number, testId: string) {
  return env.DB
    .prepare(`SELECT * FROM test_stats WHERE project_id = ?1 AND test_id = ?2 ORDER BY updated_at DESC LIMIT 1`)
    .bind(pid, testId)
    .first<{ flag: string; name: string | null; file: string | null; fails_30d: number; flips_30d: number; last_status: string; last_fail_sha: string | null; last_fail_at: number | null; flaky_since: number | null }>();
}

export async function lastFailure(env: Env, pid: number, testId: string) {
  return env.DB
    .prepare(
      `SELECT f.*, r.sha, r.flag, r.finished_at FROM failures f JOIN runs r ON r.id = f.run_id
       WHERE r.project_id = ?1 AND f.test_id = ?2 ORDER BY r.gh_run_id DESC LIMIT 1`,
    )
    .bind(pid, testId)
    .first<FailureRow & { sha: string; flag: string; finished_at: number | null }>();
}

/** Coverage % of the last `limit` branch runs per (project, flag), oldest first. One query for any number of projects. */
export async function covSeries(env: Env, projectIds: number[], limit = 20): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!projectIds.length) return out;
  const res = await env.DB
    .prepare(
      `SELECT project_id, flag, cov_lines, cov_lines_hit FROM (
         SELECT project_id, flag, cov_lines, cov_lines_hit,
                ROW_NUMBER() OVER (PARTITION BY project_id, flag ORDER BY gh_run_id DESC, gh_run_attempt DESC) AS rn
         FROM runs WHERE lane = 'branch' AND cov_lines IS NOT NULL AND project_id IN (SELECT value FROM json_each(?1))
       ) WHERE rn <= ?2 ORDER BY project_id, flag, rn DESC`,
    )
    .bind(JSON.stringify(projectIds), limit)
    .all<{ project_id: number; flag: string; cov_lines: number; cov_lines_hit: number }>();
  for (const r of res.results) {
    const k = `${r.project_id}\0${r.flag}`;
    (out.get(k) ?? out.set(k, []).get(k)!).push(r.cov_lines === 0 ? 100 : (r.cov_lines_hit / r.cov_lines) * 100);
  }
  return out;
}

/** repos the signed-in user was recently allowed to see (no GitHub call): used to fill the left nav */
export async function allowedRepoIds(env: Env, userId: number, since: number): Promise<Set<number>> {
  const res = await env.DB.prepare(`SELECT repo_id FROM repo_access WHERE user_id = ?1 AND allowed = 1 AND checked_at > ?2`).bind(userId, since).all<{ repo_id: number }>();
  return new Set(res.results.map((r) => r.repo_id));
}
