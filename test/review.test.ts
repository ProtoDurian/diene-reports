import { beforeEach, describe, expect, test } from "bun:test";
import { CRON_GC, runCron } from "../src/cron";
import { DAY } from "../src/env";
import { SHA, SHA2, finishN, finishRun, makeHarness, prClaims, putGz, runClaims, startRun, sumFor, summary, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});

const heads = () => h.db.rows("SELECT * FROM branch_head");
const keys = (p: string) => h.r2.keys(p);

/** start run n, upload a report and one coverage chunk, finish it */
async function fullRun(n: number, o: Parameters<typeof summary>[0] = {}) {
  const claims = runClaims(n);
  const s = await startRun(h, claims);
  const id = s.json.runId as number;
  await putGz(h, `/api/v1/runs/${id}/report`, `report ${n}`, claims);
  await putGz(h, `/api/v1/runs/${id}/cov/0`, `cov ${n}`, claims);
  const f = await finishRun(h, claims, sumFor(n, o));
  expect(f.status).toBe(200);
  return id;
}

describe("#1 branch_head is set on finish only", () => {
  test("start does not move the head; a cancelled run without data never takes it", async () => {
    await finishN(h, 1);
    const first = heads()[0]!.run_id;
    await startRun(h, runClaims(2));
    expect(heads()[0]!.run_id).toBe(first);
    await finishN(h, 3, { cls: "cancelled", tests: null, coverage: null });
    expect(heads()[0]!.run_id).toBe(first);
    expect(heads()[0]!.cov_run_id).toBe(first);
  });

  test("a failed run with tests but no coverage becomes the head but not the coverage head", async () => {
    const a = await finishN(h, 1);
    const b = await finishN(h, 2, { failures: [{ id: "t" }], coverage: null });
    expect(heads()).toEqual([{ project_id: 1, flag: "unit", run_id: b.json.runId, cov_run_id: a.json.runId }]);
  });

  test("an older run finishing while a newer one is only started still writes keep_blobs", async () => {
    await startRun(h, runClaims(5));
    const blob = "e".repeat(40);
    await finishN(h, 3, { sources: [{ path: "a.ts", blob, bytes: 1 }] });
    expect(h.db.rows("SELECT blob_sha FROM keep_blobs").map((r) => r.blob_sha)).toEqual([blob]);
  });

  test("keep_blobs are only replaced when the finishing run has sources", async () => {
    const blob = "e".repeat(40);
    await finishN(h, 1, { sources: [{ path: "a.ts", blob, bytes: 1 }] });
    await finishN(h, 2);
    expect(h.db.rows("SELECT blob_sha FROM keep_blobs").map((r) => r.blob_sha)).toEqual([blob]);
  });

  test("GC keeps the head and coverage-head runs", async () => {
    const a = await finishN(h, 1);
    await finishN(h, 2, { coverage: null });
    h.clock.t += 400 * DAY;
    await runCron(h.env, CRON_GC, h.clock.t);
    const ids = h.db.rows("SELECT id FROM runs").map((r) => r.id);
    expect(ids).toContain(a.json.runId);
  });
});

describe("#2 keep/ copies of the coverage-head run", () => {
  test("sum, report and coverage chunks are copied and replaced when the head changes", async () => {
    const a = await fullRun(1);
    const dirA = `keep/1001/1/unit/5001-1/`;
    expect(keys("keep/")).toEqual([`${dirA}cov/0.json.gz`, `${dirA}rep.json.gz`, `${dirA}sum.json.gz`]);
    const b = await fullRun(2);
    expect(a).not.toBe(b);
    const dirB = `keep/1001/1/unit/5002-1/`;
    expect(keys("keep/")).toEqual([`${dirB}cov/0.json.gz`, `${dirB}rep.json.gz`, `${dirB}sum.json.gz`]);
  });

  test("a stale older run does not take over keep/; a finish retry keeps the copies", async () => {
    await fullRun(5);
    const before = keys("keep/");
    await finishN(h, 3);
    expect(keys("keep/")).toEqual(before);
    await finishN(h, 5);
    expect(keys("keep/")).toEqual(before);
  });

  test("PR and tag runs never write keep/", async () => {
    await finishRun(h, prClaims(1, 3), sumFor(1, { pr: 3, baseRef: "main" }));
    await finishRun(h, runClaims(2, { ref: "refs/tags/v1" }), sumFor(2));
    expect(keys("keep/")).toEqual([]);
  });

  test("a head without coverage leaves the older coverage copy alone", async () => {
    await fullRun(1);
    const before = keys("keep/");
    await finishN(h, 2, { failures: [{ id: "t" }], coverage: null });
    expect(keys("keep/")).toEqual(before);
  });
});

describe("#5 / #13 summary shape validation", () => {
  const withBody = (patch: (s: any) => void) => {
    const s = sumFor(1);
    patch(s);
    return finishRun(h, runClaims(1), s);
  };

  test("patch.files without uncovered, numeric paths and bad raw entries are rejected", async () => {
    expect((await withBody((s) => (s.patch = { lines: 2, hit: 1, files: [{ path: "a" }] }))).status).toBe(400);
    expect((await withBody((s) => (s.coverage.files = [{ path: 5, lines: 1, hit: 1, chunk: 0 }]))).status).toBe(400);
    expect((await withBody((s) => (s.coverage.files = [{ path: "a", lines: 1, hit: 1 }]))).status).toBe(400);
    expect((await withBody((s) => (s.coverage.files = [{ path: "a", lines: 1, hit: 5, chunk: 0 }]))).status).toBe(400);
    expect((await withBody((s) => (s.raw = [{ name: "../x", kind: "junit", bytes: 1 }]))).status).toBe(400);
    expect((await withBody((s) => (s.raw = ["junit.xml"]))).status).toBe(400);
  });

  test("well-formed entries are accepted", async () => {
    const r = await withBody((s) => {
      s.patch = { lines: 2, hit: 1, files: [{ path: "a", lines: 2, hit: 1, uncovered: [7] }] };
      s.raw = [{ name: "junit.xml", kind: "junit", bytes: 12 }];
    });
    expect(r.status).toBe(200);
  });

  test("inconsistent totals are clamped with a warning", async () => {
    const r = await withBody((s) => {
      s.coverage.totals = { lines: 10, linesHit: 15, branches: 4, branchesHit: 9 };
      s.patch = { lines: 4, hit: 6, files: [] };
      s.tests.totals = { total: 5, passed: 9, failed: 0, errored: 0, skipped: 0, durationMs: 1 };
    });
    expect(r.status).toBe(200);
    const row = h.db.row("SELECT * FROM runs WHERE id = ?1", r.json.runId);
    expect(row).toMatchObject({ cov_lines: 10, cov_lines_hit: 10, cov_branches_hit: 4, patch_lines_hit: 4, t_total: 9, t_passed: 9 });
    expect(JSON.parse(row.warnings).length).toBe(4);
  });
});

describe("#8 head_sha", () => {
  test("branch and tag runs ignore a body headSha; PR runs keep it; bad shas are rejected", async () => {
    const a = await finishRun(h, runClaims(1), sumFor(1, { headSha: SHA2 }));
    expect(h.db.row("SELECT sha, head_sha FROM runs WHERE id = ?1", a.json.runId)).toEqual({ sha: "1".padStart(40, "0"), head_sha: "1".padStart(40, "0") });
    const s = await startRun(h, runClaims(2), { headSha: SHA2 });
    expect(h.db.row("SELECT head_sha FROM runs WHERE id = ?1", s.json.runId).head_sha).toBe("2".padStart(40, "0"));
    const p = await finishRun(h, prClaims(3, 7), sumFor(3, { pr: 7, baseRef: "main", headSha: SHA2 }));
    expect(h.db.row("SELECT head_sha FROM runs WHERE id = ?1", p.json.runId).head_sha).toBe(SHA2);
    expect((await finishRun(h, prClaims(4, 7), sumFor(4, { pr: 7, baseRef: "main", headSha: "not-a-sha" }))).status).toBe(400);
    expect((await startRun(h, prClaims(5, 7), { pr: 7, baseRef: "main", baseSha: "zz" })).status).toBe(400);
  });

  test("a PR with a forged headSha cannot mark a branch failure FLAKY", async () => {
    const a = await finishRun(h, runClaims(1, { sha: SHA }), summary({ claims: { sha: SHA, runId: 5001, runAttempt: 1 }, failures: [{ id: "t" }] }));
    await finishRun(h, prClaims(2, 7), sumFor(2, { pr: 7, baseRef: "main", headSha: SHA }));
    expect(h.db.row("SELECT is_flaky FROM failures WHERE run_id = ?1", a.json.runId).is_flaky).toBe(0);
  });
});

describe("#9 failures JSON stays under the D1 value limit", () => {
  test("oversized messages and stacks are shortened, nothing is lost", async () => {
    const failures = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, message: "m".repeat(4096), stack: "s".repeat(5800) }));
    const body = sumFor(1, { failures });
    const size = Buffer.byteLength(JSON.stringify(body));
    expect(size).toBeGreaterThan(1_900_000);
    expect(size).toBeLessThan(2 * 1024 * 1024);
    const r = await finishRun(h, runClaims(1), body);
    expect(r.status).toBe(200);
    const rows = h.db.rows("SELECT length(stack) AS s FROM failures WHERE run_id = ?1", r.json.runId);
    expect(rows.length).toBe(200);
    expect(Math.max(...rows.map((x) => x.s))).toBeLessThan(5800);
    expect(JSON.parse(h.db.row("SELECT warnings FROM runs WHERE id = ?1", r.json.runId).warnings).some((w: string) => w.includes("shortened"))).toBe(true);
  });
});
