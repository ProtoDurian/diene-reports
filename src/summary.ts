import { HttpError } from "./http";
import { LIMITS } from "./env";

export const FINISH_CLASSES = ["passed", "tests_failed", "errored", "cancelled", "timed_out", "no_report", "inactive"] as const;
export type FinishClass = (typeof FINISH_CLASSES)[number];
export const SUB_REASONS = ["gate", "setup", "crash"] as const;

export interface FailureIn {
  id: string;
  suite: string | null;
  name: string;
  file: string | null;
  line: number | null;
  status: "failed" | "errored";
  durationMs: number | null;
  message: string | null;
  stack: string | null;
}

export interface Summary {
  context: {
    sha: string;
    runId: number;
    runAttempt: number;
    headSha: string | null;
    pr: number | null;
    baseRef: string | null;
    baseSha: string | null;
    workflow: string | null;
    job: string;
    flag: string;
    language: string | null;
    tool: string | null;
    timeoutMinutes: number | null;
  };
  outcome: {
    testStep: string | null;
    jobStatus: string | null;
    class: FinishClass;
    subReason: string | null;
    jobFailedAfterTests: boolean;
    startedAt: number | null;
    finishedAt: number | null;
    notes: string[];
  };
  tests: null | {
    totals: { total: number; passed: number; failed: number; errored: number; skipped: number; durationMs: number };
    failures: FailureIn[];
    failuresTruncated: boolean;
    recovered: string[];
  };
  coverage: null | {
    format: string;
    totals: { lines: number; linesHit: number; branches: number | null; branchesHit: number | null };
    partial: boolean;
    chunks: number[];
  };
  patch: null | { lines: number; hit: number };
  sources: { path: string; blob: string; bytes: number }[];
  warnings: string[];
  overCap: boolean;
}

type Obj = Record<string, unknown>;
const bad = (path: string, why: string): never => {
  throw new HttpError(400, `${path}: ${why}`);
};
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

function obj(v: unknown, path: string): Obj {
  return isObj(v) ? v : bad(path, "expected object");
}
function str(v: unknown, path: string, max = 500): string {
  if (typeof v !== "string") bad(path, "expected string");
  return (v as string).length > max ? (v as string).slice(0, max) : (v as string);
}
function strOrNull(v: unknown, path: string, max = 500): string | null {
  return v === null || v === undefined ? null : str(v, path, max);
}
function int(v: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) bad(path, `expected integer ${min}..${max}`);
  return v as number;
}
function intOrNull(v: unknown, path: string): number | null {
  return v === null || v === undefined ? null : int(v, path);
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") bad(path, "expected boolean");
  return v as boolean;
}
function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) bad(path, "expected array");
  if ((v as unknown[]).length > max) bad(path, `max ${max} items`);
  return v as unknown[];
}
function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) bad(path, `expected one of ${allowed.join("|")}`);
  return v as T;
}
function shaOrNull(v: unknown, path: string): string | null {
  if (v === null || v === undefined) return null;
  const s = str(v, path, 64);
  return SHA_RE.test(s) ? s : bad(path, "expected 40-char lowercase hex sha");
}
function ts(v: unknown, path: string): number | null {
  if (v === null || v === undefined) return null;
  const n = Date.parse(str(v, path, 64));
  return Number.isNaN(n) ? null : n;
}

export const FLAG_RE = /^[A-Za-z0-9._-]{1,50}$/;
export const JOB_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const SHA_RE = /^[0-9a-f]{40}$/;
const RAW_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseFlag(v: unknown, path: string): string {
  const s = str(v, path, 100);
  return FLAG_RE.test(s) ? s : bad(path, "invalid flag");
}
export function parseJob(v: unknown, path: string): string {
  const s = str(v, path, 200);
  return JOB_RE.test(s) ? s : bad(path, "invalid job");
}

export function parseSummary(raw: unknown): Summary {
  const d = obj(raw, "summary");
  if (d.schema !== "diene-summary/v1") bad("schema", "expected diene-summary/v1");

  const c = obj(d.context, "context");
  const context: Summary["context"] = {
    sha: str(c.sha, "context.sha", 64),
    runId: int(c.runId, "context.runId"),
    runAttempt: int(c.runAttempt, "context.runAttempt"),
    headSha: shaOrNull(c.headSha, "context.headSha"),
    pr: intOrNull(c.pr, "context.pr"),
    baseRef: strOrNull(c.baseRef, "context.baseRef", 250),
    baseSha: shaOrNull(c.baseSha, "context.baseSha"),
    workflow: strOrNull(c.workflow, "context.workflow", 200),
    job: parseJob(c.job, "context.job"),
    flag: parseFlag(c.flag, "context.flag"),
    language: strOrNull(c.language, "context.language", 30),
    tool: strOrNull(c.tool, "context.tool", 100),
    timeoutMinutes: c.timeoutMinutes === null || c.timeoutMinutes === undefined ? null : int(c.timeoutMinutes, "context.timeoutMinutes", 1, 1440),
  };

  const o = obj(d.outcome, "outcome");
  const cls = oneOf(o.class, "outcome.class", FINISH_CLASSES);
  const subReason = o.subReason === null || o.subReason === undefined ? null : oneOf(o.subReason, "outcome.subReason", SUB_REASONS);
  const outcome: Summary["outcome"] = {
    testStep: strOrNull(o.testStep, "outcome.testStep", 20),
    jobStatus: strOrNull(o.jobStatus, "outcome.jobStatus", 20),
    class: cls,
    subReason: cls === "errored" ? subReason : null,
    jobFailedAfterTests: o.jobFailedAfterTests === undefined ? false : bool(o.jobFailedAfterTests, "outcome.jobFailedAfterTests"),
    startedAt: ts(o.startedAt, "outcome.startedAt"),
    finishedAt: ts(o.finishedAt, "outcome.finishedAt"),
    notes: o.notes === undefined ? [] : arr(o.notes, "outcome.notes", 100).map((n, i) => str(n, `outcome.notes[${i}]`, 500)),
  };

  const warnings: string[] = [];
  let tests: Summary["tests"] = null;
  if (d.tests !== null && d.tests !== undefined) {
    const t = obj(d.tests, "tests");
    const tt = obj(t.totals, "tests.totals");
    const rawFailures = Array.isArray(t.failures) ? t.failures : bad("tests.failures", "expected array");
    let truncated = t.failuresTruncated === undefined ? false : bool(t.failuresTruncated, "tests.failuresTruncated");
    const list = rawFailures as unknown[];
    if (list.length > LIMITS.failures) truncated = true;
    const failures: FailureIn[] = list.slice(0, LIMITS.failures).map((f, i) => {
      const p = `tests.failures[${i}]`;
      const fo = obj(f, p);
      const id = str(fo.id, `${p}.id`, 64);
      if (!ID_RE.test(id)) bad(`${p}.id`, "invalid test id");
      return {
        id,
        suite: strOrNull(fo.suite, `${p}.suite`, 500),
        name: str(fo.name, `${p}.name`, 1000),
        file: strOrNull(fo.file, `${p}.file`, 500),
        line: intOrNull(fo.line, `${p}.line`),
        status: oneOf(fo.status, `${p}.status`, ["failed", "errored"] as const),
        durationMs: intOrNull(fo.durationMs, `${p}.durationMs`),
        message: strOrNull(fo.message, `${p}.message`, LIMITS.message),
        stack: strOrNull(fo.stack, `${p}.stack`, LIMITS.stack),
      };
    });
    const recovered =
      t.recovered === undefined || t.recovered === null
        ? []
        : arr(t.recovered, "tests.recovered", LIMITS.recovered).map((r, i) => {
            const s = str(r, `tests.recovered[${i}]`, 64);
            return ID_RE.test(s) ? s : bad(`tests.recovered[${i}]`, "invalid test id");
          });
    const totals = {
      total: int(tt.total, "tests.totals.total"),
      passed: int(tt.passed, "tests.totals.passed"),
      failed: int(tt.failed, "tests.totals.failed"),
      errored: int(tt.errored, "tests.totals.errored"),
      skipped: int(tt.skipped, "tests.totals.skipped"),
      durationMs: int(tt.durationMs ?? 0, "tests.totals.durationMs"),
    };
    const parts = totals.passed + totals.failed + totals.errored + totals.skipped;
    if (parts > totals.total) {
      warnings.push(`tests.totals: total ${totals.total} is below the sum of its parts (${parts}); total raised`);
      totals.total = parts;
    }
    tests = {
      totals,
      failures,
      failuresTruncated: truncated,
      recovered,
    };
  }

  let coverage: Summary["coverage"] = null;
  if (d.coverage !== null && d.coverage !== undefined) {
    const cv = obj(d.coverage, "coverage");
    const ct = obj(cv.totals, "coverage.totals");
    const chunks = new Set<number>();
    arr(cv.files ?? [], "coverage.files", LIMITS.covFiles).forEach((f, i) => {
      const p = `coverage.files[${i}]`;
      const fo = obj(f, p);
      str(fo.path, `${p}.path`, 1000);
      const lines = int(fo.lines, `${p}.lines`);
      if (int(fo.hit, `${p}.hit`) > lines) bad(`${p}.hit`, "hit exceeds lines");
      chunks.add(int(fo.chunk, `${p}.chunk`, 0, 99_999));
    });
    const cTotals = {
      lines: int(ct.lines, "coverage.totals.lines"),
      linesHit: int(ct.linesHit, "coverage.totals.linesHit"),
      branches: intOrNull(ct.branches, "coverage.totals.branches"),
      branchesHit: intOrNull(ct.branchesHit, "coverage.totals.branchesHit"),
    };
    if (cTotals.linesHit > cTotals.lines) {
      warnings.push(`coverage.totals: linesHit ${cTotals.linesHit} exceeds lines ${cTotals.lines}; clamped`);
      cTotals.linesHit = cTotals.lines;
    }
    if (cTotals.branches !== null && cTotals.branchesHit !== null && cTotals.branchesHit > cTotals.branches) {
      warnings.push(`coverage.totals: branchesHit ${cTotals.branchesHit} exceeds branches ${cTotals.branches}; clamped`);
      cTotals.branchesHit = cTotals.branches;
    }
    coverage = {
      format: oneOf(cv.format, "coverage.format", ["lcov", "cobertura", "go"] as const),
      totals: cTotals,
      partial: cv.partial === undefined ? false : bool(cv.partial, "coverage.partial"),
      chunks: [...chunks].sort((a, b) => a - b),
    };
  }

  let patch: Summary["patch"] = null;
  if (d.patch !== null && d.patch !== undefined) {
    const p = obj(d.patch, "patch");
    arr(p.files ?? [], "patch.files", LIMITS.covFiles).forEach((f, i) => {
      const q = `patch.files[${i}]`;
      const fo = obj(f, q);
      str(fo.path, `${q}.path`, 1000);
      const lines = int(fo.lines, `${q}.lines`);
      if (int(fo.hit, `${q}.hit`) > lines) bad(`${q}.hit`, "hit exceeds lines");
      arr(fo.uncovered ?? [], `${q}.uncovered`, 5000).forEach((n, j) => int(n, `${q}.uncovered[${j}]`));
    });
    const pl = int(p.lines, "patch.lines");
    let ph = int(p.hit, "patch.hit");
    if (ph > pl) {
      warnings.push(`patch: hit ${ph} exceeds lines ${pl}; clamped`);
      ph = pl;
    }
    patch = { lines: pl, hit: ph };
  }

  const sources = arr(d.sources ?? [], "sources", LIMITS.covFiles).map((s, i) => {
    const so = obj(s, `sources[${i}]`);
    const blob = str(so.blob, `sources[${i}].blob`, 40);
    if (!SHA_RE.test(blob)) bad(`sources[${i}].blob`, "expected git blob sha1");
    return { path: str(so.path, `sources[${i}].path`, 1000), blob, bytes: int(so.bytes ?? 0, `sources[${i}].bytes`) };
  });

  arr(d.raw ?? [], "raw", 1000).forEach((r, i) => {
    const p = `raw[${i}]`;
    const ro = obj(r, p);
    if (!RAW_NAME_RE.test(str(ro.name, `${p}.name`, 100))) bad(`${p}.name`, "invalid raw name");
    strOrNull(ro.kind, `${p}.kind`, 30);
    int(ro.bytes ?? 0, `${p}.bytes`);
  });
  warnings.push(...arr(d.warnings ?? [], "warnings", 200).map((w, i) => str(w, `warnings[${i}]`, 500)));

  return {
    context,
    outcome,
    tests,
    coverage,
    patch,
    sources,
    warnings,
    overCap: d.overCap === undefined ? false : bool(d.overCap, "overCap"),
  };
}

export interface StartBody {
  flag: string;
  job: string;
  language: string | null;
  workflow: string | null;
  timeoutMinutes: number;
  headSha: string | null;
  pr: number | null;
  baseRef: string | null;
  baseSha: string | null;
  sha: string | null;
  runId: number | null;
  runAttempt: number | null;
}

export function parseStart(raw: unknown): StartBody {
  const d = obj(raw, "body");
  if (d.schema !== "diene-start/v1") bad("schema", "expected diene-start/v1");
  return {
    flag: parseFlag(d.flag, "flag"),
    job: parseJob(d.job, "job"),
    language: strOrNull(d.language, "language", 30),
    workflow: strOrNull(d.workflow, "workflow", 200),
    timeoutMinutes: int(d.timeoutMinutes ?? 30, "timeoutMinutes", 1, 1440),
    headSha: shaOrNull(d.headSha, "headSha"),
    pr: intOrNull(d.pr, "pr"),
    baseRef: strOrNull(d.baseRef, "baseRef", 250),
    baseSha: shaOrNull(d.baseSha, "baseSha"),
    sha: strOrNull(d.sha, "sha", 64),
    runId: intOrNull(d.runId, "runId"),
    runAttempt: intOrNull(d.runAttempt, "runAttempt"),
  };
}
