export type RunRow = {
  id: number;
  repo_id: number;
  project_id: number;
  lane: string;
  sha: string;
  head_sha: string;
  branch: string;
  pr: number | null;
  flag: string;
  job: string;
  state: string;
  sub_reason: string | null;
  job_failed_after_tests: number;
  test_step: string | null;
  job_status: string | null;
  gh_run_id: number;
  gh_run_attempt: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  deadline_at: number | null;
  timeout_minutes: number | null;
  t_total: number | null;
  t_passed: number | null;
  t_failed: number | null;
  t_errored: number | null;
  t_skipped: number | null;
  duration_ms: number | null;
  failures_truncated: number;
  cov_format: string | null;
  cov_lines: number | null;
  cov_lines_hit: number | null;
  cov_branches: number | null;
  cov_branches_hit: number | null;
  cov_partial: number;
  patch_lines: number | null;
  patch_lines_hit: number | null;
  over_cap: number;
  report_key: string | null;
  summary_key: string | null;
  notes: string | null;
  warnings: string | null;
  workflow: string | null;
  language: string | null;
};

export interface StateInfo {
  label: string;
  tone: "ok" | "bad" | "warn" | "idle";
  rank: number;
}

export const STATES: Record<string, StateInfo> = {
  passed: { label: "passed", tone: "ok", rank: 0 },
  tests_failed: { label: "tests failed", tone: "bad", rank: 9 },
  errored: { label: "errored", tone: "bad", rank: 8 },
  timed_out: { label: "timed out", tone: "bad", rank: 7 },
  lost: { label: "lost", tone: "bad", rank: 6 },
  cancelled: { label: "cancelled", tone: "warn", rank: 5 },
  no_report: { label: "no report", tone: "warn", rank: 4 },
  started: { label: "running", tone: "idle", rank: 3 },
  inactive: { label: "inactive", tone: "idle", rank: 1 },
};

export const stateInfo = (s: string): StateInfo => STATES[s] ?? { label: s, tone: "idle", rank: 2 };

/** worst state of a set of runs; a "passed" run whose job failed after the tests counts as a warning */
export function worstState(runs: { state: string }[]): string {
  let best = "passed";
  for (const r of runs) if (stateInfo(r.state).rank > stateInfo(best).rank) best = r.state;
  return runs.length ? best : "inactive";
}

export const pct = (hit: number | null, total: number | null): number | null =>
  hit === null || total === null ? null : total === 0 ? 100 : (hit / total) * 100;

export const fmtPct = (p: number | null): string => (p === null ? "n/a" : `${p >= 99.95 || p === 0 ? p.toFixed(0) : p.toFixed(1)}%`);

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "n/a";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

export function fmtTime(ms: number | null): string {
  if (ms === null) return "n/a";
  const d = new Date(ms);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export const short = (sha: string) => sha.slice(0, 7);

/** plain-words headline for a run that did not simply pass */
export function explain(r: RunRow): string | null {
  const name = r.flag;
  switch (r.state) {
    case "passed":
      return r.job_failed_after_tests ? `${name}: tests passed, but the job failed after the tests` : null;
    case "tests_failed": {
      const n = (r.t_failed ?? 0) + (r.t_errored ?? 0);
      return `${name}: ${n} test${n === 1 ? "" : "s"} failed`;
    }
    case "errored":
      if (r.sub_reason === "gate") return `${name}: coverage gate failed${r.t_total !== null ? " (tests ran)" : ""}`;
      if (r.sub_reason === "setup") return `${name}: setup failed before the tests ran`;
      return r.t_total === null ? `${name}: run crashed before reporting tests` : `${name}: run errored after reporting tests`;
    case "cancelled":
      return `${name}: run was cancelled`;
    case "timed_out":
      return `${name}: tests did not finish: timed out${r.timeout_minutes ? ` after ${r.timeout_minutes} min` : ""}`;
    case "lost":
      return `${name}: tests did not finish: runner lost${r.started_at ? ` (started ${fmtTime(r.started_at)})` : ""}`;
    case "no_report":
      return `${name}: the job finished but produced no test or coverage report`;
    case "inactive":
      return `${name}: nothing to run (inactive)`;
    case "started":
      return `${name}: still running`;
    default:
      return `${name}: ${r.state}`;
  }
}

export const parseJsonList = (s: string | null): string[] => {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** GitHub URL helpers; path segments are encoded, `..` is refused */
export const ghBase = (owner: string, repo: string) => `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export function ghBlob(owner: string, repo: string, sha: string, path: string | null, line?: number | null): string | null {
  if (!path || path.startsWith("/") || path.split("/").some((p) => p === ".." || p === "")) return null;
  const p = path.split("/").map(encodeURIComponent).join("/");
  return `${ghBase(owner, repo)}/blob/${sha}/${p}${line ? `#L${line}` : ""}`;
}

export const ghRun = (owner: string, repo: string, r: { gh_run_id: number; gh_run_attempt: number }) =>
  `${ghBase(owner, repo)}/actions/runs/${r.gh_run_id}/attempts/${r.gh_run_attempt}`;

/** worst first, then by flag name, so failed runs lead the page */
export const bySeverity = (runs: RunRow[]): RunRow[] =>
  [...runs].sort((a, b) => stateInfo(b.state).rank - stateInfo(a.state).rank || a.flag.localeCompare(b.flag));
