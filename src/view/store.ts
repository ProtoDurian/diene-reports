import type { Env } from "../env";
import { gunzipCapped } from "../http";
import type { RunRow } from "./format";

const MAX_JSON = 32 * 1024 * 1024;

export interface SummaryDoc {
  coverage?: { totals?: unknown; partial?: boolean; files?: { path: string; lines: number; hit: number; chunk: number }[] } | null;
  patch?: { lines: number; hit: number; files: { path: string; lines: number; hit: number; uncovered: number[] }[] } | null;
  sources?: { path: string; blob: string; bytes: number }[];
  raw?: { name: string; kind: string; bytes: number }[];
}

async function readGzJson<T>(env: Env, key: string | null): Promise<T | null> {
  if (!key) return null;
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  try {
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const text = new TextDecoder().decode(await gunzipCapped(bytes, MAX_JSON));
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** the stored `finish` body; null once R2 expired it (90 d) */
export const loadSummary = (env: Env, run: Pick<RunRow, "summary_key">) => readGzJson<SummaryDoc>(env, run.summary_key);

export async function loadCovChunk(env: Env, run: Pick<RunRow, "repo_id" | "sha" | "flag" | "gh_run_id" | "gh_run_attempt">, chunk: number) {
  const key = `cov/${run.repo_id}/${run.sha}/${run.flag}/${run.gh_run_id}-${run.gh_run_attempt}/${chunk}.json.gz`;
  return readGzJson<{ files: Record<string, { lines: [number, number][]; branches?: ([number, number, number][]) | null }> }>(env, key);
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

export async function loadReportDiff(env: Env, run: Pick<RunRow, "report_key">): Promise<Record<string, number[]> | null> {
  if (!run.report_key) return null;
  const head = await env.BUCKET.head(run.report_key);
  if (!head || head.size > 6 * 1024 * 1024) return null;
  const doc = await readGzJson<{ diff?: { files?: Record<string, number[]> } }>(env, run.report_key);
  return doc?.diff?.files ?? null;
}
