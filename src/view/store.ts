import type { Env } from "../env";
import { gunzipCapped } from "../http";
import { keepRunDir } from "../runs";
import type { RunRow } from "./format";

const MAX_JSON = 32 * 1024 * 1024;
/** the full report is only parsed for the test list below this gzip size */
export const REPORT_MAX_GZ = 5 * 1024 * 1024;

export interface CoverageFile {
  path: string;
  lines: number;
  hit: number;
  chunk: number;
}
export interface PatchFile {
  path: string;
  lines: number;
  hit: number;
  uncovered: number[];
}
export interface SummaryDoc {
  coverage?: { totals?: unknown; partial?: boolean; files?: CoverageFile[] } | null;
  patch?: { lines: number; hit: number; files: PatchFile[] } | null;
  sources?: { path: string; blob: string; bytes: number }[];
  raw?: { name: string; kind: string; bytes: number }[];
}
export interface TestCase {
  id: string;
  suite: string | null;
  name: string;
  file: string | null;
  line: number | null;
  status: "passed" | "failed" | "errored" | "skipped";
  durationMs: number | null;
}
export type TestList = { kind: "ok"; cases: TestCase[] } | { kind: "missing" } | { kind: "too_large"; bytes: number } | { kind: "unreadable" };

type RunKeys = Pick<RunRow, "repo_id" | "project_id" | "flag" | "gh_run_id" | "gh_run_attempt">;
const keepDir = (r: RunKeys) => keepRunDir(r.repo_id, r.project_id, r.flag, r.gh_run_id, r.gh_run_attempt);

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

async function readGz(env: Env, key: string): Promise<{ doc: unknown } | null> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  try {
    const bytes = new Uint8Array(await obj.arrayBuffer());
    return { doc: JSON.parse(new TextDecoder().decode(await gunzipCapped(bytes, MAX_JSON))) };
  } catch {
    return { doc: undefined };
  }
}

/** first key that exists; a stored-but-unreadable object yields null (do not fall through to older copies) */
async function readFirst(env: Env, keys: (string | null)[]): Promise<unknown> {
  for (const k of keys) {
    if (!k) continue;
    const r = await readGz(env, k);
    if (r) return r.doc ?? null;
  }
  return null;
}

/** Stored documents are untrusted (a bad upload must not break a page for good): keep only well-formed entries. */
export function cleanSummary(doc: unknown): SummaryDoc | null {
  if (!isObj(doc)) return null;
  const out: SummaryDoc = {};
  const cov = doc.coverage;
  if (isObj(cov)) {
    out.coverage = {
      totals: cov.totals,
      partial: cov.partial === true,
      files: Array.isArray(cov.files)
        ? cov.files.filter((f): f is CoverageFile => isObj(f) && str(f.path) && f.path.length > 0 && isInt(f.lines) && isInt(f.hit) && isInt(f.chunk))
        : undefined,
    };
  }
  const patch = doc.patch;
  if (isObj(patch)) {
    out.patch = {
      lines: isInt(patch.lines) ? patch.lines : 0,
      hit: isInt(patch.hit) ? patch.hit : 0,
      files: (Array.isArray(patch.files) ? patch.files : [])
        .filter((f): f is Record<string, unknown> => isObj(f) && str(f.path) && f.path.length > 0)
        .map((f) => ({
          path: f.path as string,
          lines: isInt(f.lines) ? f.lines : 0,
          hit: isInt(f.hit) ? f.hit : 0,
          uncovered: Array.isArray(f.uncovered) ? f.uncovered.filter(isInt) : [],
        })),
    };
  }
  if (Array.isArray(doc.sources)) {
    out.sources = doc.sources.filter((s): s is { path: string; blob: string; bytes: number } => isObj(s) && str(s.path) && str(s.blob) && /^[0-9a-f]{40}$/i.test(s.blob) && isInt(s.bytes));
  }
  if (Array.isArray(doc.raw)) {
    out.raw = doc.raw.filter((r): r is { name: string; kind: string; bytes: number } => isObj(r) && str(r.name) && NAME_RE.test(r.name) && str(r.kind) && isInt(r.bytes));
  }
  return out;
}

/** the stored `finish` body; falls back to the keep/ copy when sum/ expired (90 d) */
export async function loadSummary(env: Env, run: Pick<RunRow, "summary_key"> & RunKeys): Promise<SummaryDoc | null> {
  if (!run.summary_key) return null;
  return cleanSummary(await readFirst(env, [run.summary_key, `${keepDir(run)}sum.json.gz`]));
}

export type ChunkDoc = { files: Record<string, { lines: [number, number][] }> };

export async function loadCovChunk(env: Env, run: RunKeys & Pick<RunRow, "sha">, chunk: number): Promise<ChunkDoc | null> {
  const key = `cov/${run.repo_id}/${run.sha}/${run.flag}/${run.gh_run_id}-${run.gh_run_attempt}/${chunk}.json.gz`;
  const doc = await readFirst(env, [key, `${keepDir(run)}cov/${chunk}.json.gz`]);
  if (!isObj(doc) || !isObj(doc.files)) return null;
  const files: ChunkDoc["files"] = {};
  for (const [p, v] of Object.entries(doc.files)) {
    if (!isObj(v) || !Array.isArray(v.lines)) continue;
    files[p] = { lines: v.lines.filter((l): l is [number, number] => Array.isArray(l) && isInt(l[0]) && isInt(l[1])) };
  }
  return { files };
}

export async function loadSource(env: Env, repoId: number, blob: string): Promise<string | null> {
  const obj = await env.BUCKET.get(`src/${repoId}/${blob}`);
  if (!obj) return null;
  try {
    return new TextDecoder("utf-8").decode(await gunzipCapped(new Uint8Array(await obj.arrayBuffer()), 2 * 1024 * 1024));
  } catch {
    return null;
  }
}

/** report object (rep/, then the keep/ copy) if present and under the size cap */
async function loadReport(env: Env, run: Pick<RunRow, "report_key"> & RunKeys): Promise<{ kind: "ok"; doc: Record<string, unknown> } | { kind: "missing" } | { kind: "too_large"; bytes: number } | { kind: "unreadable" }> {
  for (const key of [run.report_key, `${keepDir(run)}rep.json.gz`]) {
    if (!key) continue;
    const head = await env.BUCKET.head(key);
    if (!head) continue;
    if (head.size > REPORT_MAX_GZ) return { kind: "too_large", bytes: head.size };
    const r = await readGz(env, key);
    if (!r) continue;
    return isObj(r.doc) ? { kind: "ok", doc: r.doc } : { kind: "unreadable" };
  }
  return { kind: "missing" };
}

export async function loadReportDiff(env: Env, run: Pick<RunRow, "report_key"> & RunKeys): Promise<Record<string, number[]> | null> {
  const r = await loadReport(env, run);
  if (r.kind !== "ok" || !isObj(r.doc.diff) || !isObj(r.doc.diff.files)) return null;
  const out: Record<string, number[]> = {};
  for (const [p, v] of Object.entries(r.doc.diff.files)) if (Array.isArray(v)) out[p] = v.filter(isInt);
  return out;
}

const STATUSES = new Set(["passed", "failed", "errored", "skipped"]);

/** every test case of a run, read from the full report */
export async function loadTestList(env: Env, run: Pick<RunRow, "report_key"> & RunKeys): Promise<TestList> {
  const r = await loadReport(env, run);
  if (r.kind !== "ok") return r;
  const tests = r.doc.tests;
  if (!isObj(tests) || !Array.isArray(tests.cases)) return { kind: "unreadable" };
  const cases: TestCase[] = [];
  for (const c of tests.cases) {
    if (!isObj(c) || !str(c.name) || !str(c.status) || !STATUSES.has(c.status)) continue;
    cases.push({
      id: str(c.id) ? c.id : "",
      suite: str(c.suite) ? c.suite : null,
      name: c.name,
      file: str(c.file) ? c.file : null,
      line: isInt(c.line) ? c.line : null,
      status: c.status as TestCase["status"],
      durationMs: isInt(c.durationMs) ? c.durationMs : null,
    });
  }
  return { kind: "ok", cases };
}
