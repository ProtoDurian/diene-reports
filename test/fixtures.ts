import { scheduled } from "../src/app";
import { gitSha, putGz, finishRun, startRun, summary, type Fail, type Harness, T0 } from "./harness";

const HOUR = 3_600_000;
export const REPO = { owner: "ProtoDurian", name: "demo-app" };
const REPO_CLAIMS = { repository: "ProtoDurian/demo-app", repository_id: "1001" };

export const shaN = (n: number) => n.toString(16).padStart(40, "0");
export const PR_HEAD = "f".repeat(40);

export const MATH_SRC = `export function add(a: number, b: number): number {
  return a + b;
}

export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new Error("division by zero");
  }
  return a / b;
}

export function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
`;

export const FLAKY_ID = "flaky00000000001";
export const NEW_ID = "new0000000000001";
export const XSS_ID = "xss0000000000001";
export const XSS_NAME = `renders <script>alert("x")</script> & "quotes"`;
export const XSS_MSG = `Expected <b>bold</b> but got <img src=x onerror=alert(1)>`;

const LONG_STACK = Array.from({ length: 40 }, (_, i) => `    at someVeryLongFunctionNameThatKeepsGoing${i} (/home/runner/work/demo-app/demo-app/src/some/deeply/nested/directory/file${i}.ts:${10 + i}:${i + 3})`).join("\n");

export interface Seeded {
  showcaseSha: string;
  failedRunSha: string;
  prRunId: number;
  showcaseFailedRunId: number;
}

/** every outcome class, driven through the real API with signed tokens */
export async function seedDemo(h: Harness): Promise<Seeded> {
  const commitClaims = (n: number, over: Record<string, unknown> = {}) => ({ ...REPO_CLAIMS, run_id: String(6000 + n), sha: shaN(n), ...over });
  const sum = (n: number, o: Parameters<typeof summary>[0]) => summary({ ...o, claims: { sha: shaN(n), runId: 6000 + n, runAttempt: 1 } });
  const ok = async (p: Promise<{ status: number; json: any }>) => {
    const r = await p;
    if (r.status !== 200) throw new Error(`seed call failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  const flagRun = async (n: number, flag: string, o: Parameters<typeof summary>[0], start: Record<string, unknown> = {}, claims: Record<string, unknown> = {}) => {
    const c = commitClaims(n, claims);
    await ok(startRun(h, c, { flag, job: flag, ...start }));
    return ok(finishRun(h, c, sum(n, { flag, job: flag, ...o })));
  };

  h.clock.t = T0;
  // c1: a flaky test fails once
  await flagRun(1, "unit", { failures: [{ id: FLAKY_ID, name: "retries the upload", file: "src/upload.test.ts" }] });
  await flagRun(1, "integration", {});
  await flagRun(1, "e2e", {});
  // c2: all green, flaky test recovered
  h.clock.t += HOUR;
  await flagRun(2, "unit", { recovered: [FLAKY_ID] });
  await flagRun(2, "integration", {});
  await flagRun(2, "e2e", {});

  // c3: the showcase — failed tests, a lost run, a timeout, inactive and no_report flags
  h.clock.t += HOUR;
  const SHOW = 3;
  const failures: Fail[] = [
    { id: FLAKY_ID, name: "retries the upload", file: "src/upload.test.ts", message: "Timed out after 5000ms waiting for the retry" },
    { id: NEW_ID, name: "divide by zero throws a RangeError", file: "src/lib/math.ts", message: "Expected: RangeError\nReceived: Error: division by zero" },
    { id: "err0000000000001", name: "loads fixtures from disk", file: "test/fixtures.test.ts", status: "errored", message: "ENOENT: no such file or directory, open 'test/data/big.json'", stack: LONG_STACK },
    { id: XSS_ID, name: XSS_NAME, file: "src/render.test.ts", message: XSS_MSG, stack: `at ${"averyveryveryverylongunbrokentokenwithoutanyspacesatall".repeat(6)}` },
  ];
  const unitRun = await flagRun(SHOW, "unit", {
    failures,
    coverage: { format: "lcov", totals: { lines: 120, linesHit: 94, branches: null, branchesHit: null }, partial: false, files: [{ path: "src/lib/math.ts", lines: 14, hit: 11, chunk: 0 }, { path: "src/upload.ts", lines: 40, hit: 22, chunk: 0 }] },
    tests: undefined,
  });
  // integration starts and its runner is lost
  await ok(startRun(h, commitClaims(SHOW), { flag: "integration", job: "integration", timeoutMinutes: 5 }));
  await flagRun(SHOW, "e2e", { cls: "timed_out", failures: [], tests: null, coverage: null });
  await flagRun(SHOW, "lint", { cls: "inactive", tests: null, coverage: null });
  await flagRun(SHOW, "docs", { cls: "no_report", tests: null, coverage: null });
  h.clock.t += 3 * HOUR;
  await scheduled(h.env, "*/15 * * * *", h.clock.t);

  // c4: gate failure with results present, cancelled, crash, and job failed after tests
  h.clock.t += HOUR;
  await flagRun(4, "unit", { cls: "errored", subReason: "gate", coverage: { format: "lcov", totals: { lines: 120, linesHit: 60, branches: null, branchesHit: null }, partial: false, files: [] } });
  await flagRun(4, "integration", { cls: "cancelled", tests: null, coverage: null });
  await flagRun(4, "e2e", { cls: "errored", subReason: "crash", tests: null, coverage: null });
  await flagRun(4, "smoke", { jobFailedAfterTests: true });

  // PR #7: patch coverage, source, coverage chunk, report diff
  h.clock.t += HOUR;
  const prClaims = { ...REPO_CLAIMS, ref: "refs/pull/7/merge", event_name: "pull_request", run_id: "6100", sha: shaN(0x77) };
  const prStart = { flag: "unit", job: "unit", headSha: PR_HEAD, pr: 7, baseRef: "main", baseSha: shaN(4) };
  await ok(startRun(h, prClaims, prStart));
  const blob = gitSha(MATH_SRC);
  const prSum = summary({
    claims: { sha: shaN(0x77), runId: 6100, runAttempt: 1 },
    flag: "unit", job: "unit", headSha: PR_HEAD, pr: 7, baseRef: "main",
    failures: [{ id: NEW_ID, name: "divide by zero throws a RangeError", file: "src/lib/math.ts", message: "Expected: RangeError" }],
    coverage: { format: "lcov", totals: { lines: 120, linesHit: 100, branches: null, branchesHit: null }, partial: false, files: [{ path: "src/lib/math.ts", lines: 14, hit: 11, chunk: 0 }] },
    patch: { lines: 8, hit: 5, files: [{ path: "src/lib/math.ts", lines: 8, hit: 5, uncovered: [14, 15, 16] }] },
    sources: [{ path: "src/lib/math.ts", blob, bytes: MATH_SRC.length }],
  });
  const fin = await ok(finishRun(h, prClaims, prSum));
  await ok(putGz(h, `/api/v1/sources/${blob}`, MATH_SRC, prClaims));
  const hits: [number, number][] = [[1, 5], [2, 5], [5, 3], [6, 3], [7, 1], [9, 2], [13, 2], [14, 0], [15, 0], [16, 0]];
  await ok(putGz(h, `/api/v1/runs/${fin.runId}/cov/0`, JSON.stringify({ files: { "src/lib/math.ts": { lines: hits } } }), prClaims));
  await ok(putGz(h, `/api/v1/runs/${fin.runId}/report`, JSON.stringify({ diff: { files: { "src/lib/math.ts": [12, 13, 14, 15, 16] } } }), prClaims));

  // PR #8: started only
  h.clock.t += HOUR;
  const pr8 = { ...REPO_CLAIMS, ref: "refs/pull/8/merge", event_name: "pull_request", run_id: "6200", sha: shaN(0x88) };
  await ok(startRun(h, pr8, { flag: "unit", job: "unit", headSha: shaN(0x89), pr: 8, baseRef: "main" }));

  // a private repo: badges must stay grey
  const priv = { repository: "ProtoDurian/secret-svc", repository_id: "1002", repository_visibility: "private", run_id: "7001", sha: shaN(0x51) };
  await ok(startRun(h, priv, { flag: "unit", job: "unit" }));
  await ok(finishRun(h, priv, summary({ claims: { sha: shaN(0x51), runId: 7001, runAttempt: 1 }, flag: "unit", job: "unit" })));

  return { showcaseSha: shaN(SHOW), failedRunSha: shaN(4), prRunId: fin.runId, showcaseFailedRunId: unitRun.runId };
}
