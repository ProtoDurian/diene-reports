import { beforeEach, describe, expect, test } from "bun:test";
import { DAY } from "../src/env";
import { SHA, SHA2, finishN, finishRun, makeHarness, prClaims, runClaims, summary, sumFor, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});

const marks = (runId: number) =>
  Object.fromEntries(h.db.rows("SELECT test_id, is_new, is_flaky FROM failures WHERE run_id = ?1", runId).map((r) => [r.test_id, [r.is_new, r.is_flaky]]));
const stats = (id: string) => h.db.row("SELECT * FROM test_stats WHERE test_id = ?1", id);

describe("NEW marks", () => {
  test("no base run -> unknown (null)", async () => {
    const f = await finishN(h, 1, { failures: [{ id: "a" }] });
    expect(marks(f.json.runId)).toEqual({ a: [null, 0] });
  });

  test("failure also in the base -> not new; only in head -> NEW", async () => {
    await finishN(h, 1, { failures: [{ id: "a" }] });
    const f = await finishN(h, 2, { failures: [{ id: "a" }, { id: "b" }] });
    expect(marks(f.json.runId)).toEqual({ a: [0, 0], b: [1, 0] });
    expect(h.db.row("SELECT base_run_id FROM runs WHERE id = ?1", f.json.runId).base_run_id).not.toBeNull();
  });

  test("a clean passing base makes every failure NEW", async () => {
    await finishN(h, 1);
    const f = await finishN(h, 2, { failures: [{ id: "a" }] });
    expect(marks(f.json.runId)).toEqual({ a: [1, 0] });
  });

  test("base incomplete (partial coverage, truncated, errored, no tests) -> skipped, else unknown", async () => {
    await finishN(h, 1, { failures: [{ id: "a" }], truncated: true });
    await finishN(h, 2, { cls: "errored", subReason: "crash", tests: null });
    await finishN(h, 3, { failures: [{ id: "a" }], covPartial: true });
    await finishN(h, 4, { failures: [{ id: "a" }], overCap: true });
    const f = await finishN(h, 5, { failures: [{ id: "a" }] });
    expect(marks(f.json.runId)).toEqual({ a: [null, 0] });
    expect(h.db.row("SELECT base_run_id FROM runs WHERE id = ?1", f.json.runId).base_run_id).toBeNull();
  });

  test("base search skips incomplete runs and uses the newest complete one", async () => {
    await finishN(h, 1, { failures: [{ id: "old" }] });
    await finishN(h, 2, { cls: "timed_out", tests: null });
    const f = await finishN(h, 3, { failures: [{ id: "old" }, { id: "n" }] });
    expect(marks(f.json.runId)).toEqual({ old: [0, 0], n: [1, 0] });
  });

  test("PR lane compares to the base branch's latest complete run, ignoring newer-than-itself rule", async () => {
    await finishN(h, 1, { failures: [{ id: "a" }] });
    const f = await finishRun(h, prClaims(9, 7), sumFor(9, { pr: 7, baseRef: "main", headSha: SHA2, failures: [{ id: "a" }, { id: "b" }] }));
    expect(f.status).toBe(200);
    expect(marks(f.json.runId)).toEqual({ a: [0, 0], b: [1, 0] });
  });

  test("PR lane with no base history -> unknown", async () => {
    const f = await finishRun(h, prClaims(9, 7), sumFor(9, { pr: 7, baseRef: "main", failures: [{ id: "a" }] }));
    expect(marks(f.json.runId)).toEqual({ a: [null, 0] });
  });

  test("tag / other lanes never get a base", async () => {
    await finishN(h, 1, { failures: [{ id: "a" }] });
    const f = await finishRun(h, runClaims(2, { ref: "refs/tags/v1", ref_type: "tag" }), sumFor(2, { failures: [{ id: "a" }] }));
    expect(marks(f.json.runId)).toEqual({ a: [null, 0] });
  });
});

describe("FLAKY marks", () => {
  test("same head_sha failed then passed in a later run -> the earlier failure becomes FLAKY (retroactive)", async () => {
    const a = await finishN(h, 1, { headSha: SHA2, failures: [{ id: "t" }] });
    expect(marks(a.json.runId)).toEqual({ t: [null, 0] });
    await finishN(h, 2, { headSha: SHA2 });
    expect(marks(a.json.runId).t[1]).toBe(1);
  });

  test("same head_sha passed first then failed -> FLAKY at insert", async () => {
    await finishN(h, 1, { headSha: SHA2 });
    const b = await finishN(h, 2, { headSha: SHA2, failures: [{ id: "t" }] });
    expect(marks(b.json.runId).t[1]).toBe(1);
  });

  test("different head_sha does not make it flaky; a still-failing re-run does not either", async () => {
    await finishN(h, 1, { headSha: SHA, failures: [{ id: "t" }] });
    const x = await finishN(h, 2, { headSha: SHA2, failures: [{ id: "t" }] });
    expect(marks(x.json.runId).t[1]).toBe(0);
    const y = await finishN(h, 3, { headSha: SHA2, failures: [{ id: "t" }] });
    expect(marks(y.json.runId).t[1]).toBe(0);
    expect(marks(x.json.runId).t[1]).toBe(0);
  });

  test("an incomplete same-sha run (errored) does not prove the test passed", async () => {
    const a = await finishN(h, 1, { headSha: SHA2, failures: [{ id: "t" }] });
    await finishN(h, 2, { headSha: SHA2, cls: "errored", subReason: "crash", tests: null });
    expect(marks(a.json.runId).t[1]).toBe(0);
  });

  test("another flag's pass does not count", async () => {
    const a = await finishN(h, 1, { headSha: SHA2, failures: [{ id: "t" }] });
    await finishN(h, 2, { headSha: SHA2, flag: "int", job: "int" });
    expect(marks(a.json.runId).t[1]).toBe(0);
  });

  test(">= 2 flips in 30 d on a branch marks FLAKY and sets flaky_since", async () => {
    await finishN(h, 1, { failures: [{ id: "t" }] }); // fail
    await finishN(h, 2, { recovered: ["t"] }); // pass  (flip 1)
    await finishN(h, 3, { failures: [{ id: "t" }] }); // fail (flip 2)
    expect(stats("t")).toMatchObject({ fails_30d: 2, flips_30d: 2, last_status: "failed" });
    const c = await finishN(h, 4, { failures: [{ id: "t" }] });
    expect(marks(c.json.runId).t[1]).toBe(1);
    expect(stats("t").flaky_since).toBe(h.clock.t);
  });

  test("the flips window rolls after 30 days", async () => {
    await finishN(h, 1, { failures: [{ id: "t" }] });
    await finishN(h, 2, { recovered: ["t"] });
    await finishN(h, 3, { failures: [{ id: "t" }] });
    h.clock.t += 31 * DAY;
    const c = await finishN(h, 4, { failures: [{ id: "t" }] });
    expect(marks(c.json.runId).t[1]).toBe(0);
    expect(stats("t")).toMatchObject({ fails_30d: 1, flips_30d: 0 });
  });
});

describe("test_stats and recovered", () => {
  test("failing counts +1 and recovered flips to passed", async () => {
    await finishN(h, 1, { failures: [{ id: "t" }, { id: "u" }] });
    expect(stats("t")).toMatchObject({ fails_30d: 1, flips_30d: 0, last_status: "failed", last_fail_sha: "1".padStart(40, "0") });
    await finishN(h, 2, { recovered: ["t"], failures: [{ id: "u" }] });
    expect(stats("t")).toMatchObject({ last_status: "passed", flips_30d: 1 });
    expect(stats("u")).toMatchObject({ last_status: "failed", fails_30d: 2, flips_30d: 0 });
  });

  test("recovering an unknown test is a no-op and an id in both lists counts as failing", async () => {
    const f = await finishN(h, 1, { recovered: ["ghost", "t"], failures: [{ id: "t" }] });
    expect(f.status).toBe(200);
    expect(stats("ghost")).toBeFalsy();
    expect(stats("t").last_status).toBe("failed");
  });

  test("finish retry does not double count; lane pr and tag do not touch stats", async () => {
    await finishN(h, 1, { failures: [{ id: "t" }] });
    await finishN(h, 1, { failures: [{ id: "t" }] });
    expect(stats("t").fails_30d).toBe(1);
    await finishRun(h, prClaims(9, 7), sumFor(9, { pr: 7, baseRef: "main", failures: [{ id: "p" }], recovered: ["t"] }));
    expect(stats("p")).toBeFalsy();
    expect(stats("t").last_status).toBe("failed");
    await finishRun(h, runClaims(10, { ref: "refs/tags/v2" }), sumFor(10, { failures: [{ id: "tg" }] }));
    expect(stats("tg")).toBeFalsy();
  });
});

describe("lanes", () => {
  const heads = () => h.db.rows("SELECT * FROM branch_head");

  test("PR runs never write branch_head, keep_blobs or test_stats", async () => {
    const blob = "d".repeat(40);
    const f = await finishRun(h, prClaims(1, 3), sumFor(1, { pr: 3, baseRef: "main", failures: [{ id: "x" }], sources: [{ path: "a.ts", blob, bytes: 1 }] }));
    expect(f.status).toBe(200);
    expect(heads()).toEqual([]);
    expect(h.db.rows("SELECT * FROM keep_blobs")).toEqual([]);
    expect(h.db.rows("SELECT * FROM test_stats")).toEqual([]);
    const row = h.db.row("SELECT lane, pr, branch FROM runs WHERE id = ?1", f.json.runId);
    expect(row).toEqual({ lane: "pr", pr: 3, branch: "main" });
  });

  test("PR run without baseRef -> 400 (start and finish)", async () => {
    const f = await finishRun(h, prClaims(1, 3), sumFor(1, { pr: 3 }));
    expect(f.status).toBe(400);
    const s = await h.call("POST", "/api/v1/runs/start", { claims: prClaims(1, 3), body: { schema: "diene-start/v1", flag: "unit", job: "unit", language: "bun", workflow: "CI", timeoutMinutes: 30, headSha: null, pr: 3, baseRef: null, baseSha: null } });
    expect(s.status).toBe(400);
  });

  test("PR body pr number must match the ref", async () => {
    expect((await finishRun(h, prClaims(1, 3), sumFor(1, { pr: 4, baseRef: "main" }))).status).toBe(400);
  });

  test("branch runs write branch_head; older run ids never replace a newer head", async () => {
    await finishN(h, 5);
    const newer = h.db.row("SELECT run_id FROM branch_head").run_id;
    await finishN(h, 3);
    expect(h.db.row("SELECT run_id FROM branch_head").run_id).toBe(newer);
    const n6 = await finishN(h, 6);
    expect(h.db.row("SELECT run_id FROM branch_head").run_id).toBe(n6.json.runId);
    expect(heads().length).toBe(1);
  });

  test("a different flag or branch gets its own head", async () => {
    await finishN(h, 1);
    await finishN(h, 2, { flag: "int", job: "int" });
    await finishRun(h, runClaims(3, { ref: "refs/heads/dev" }), sumFor(3));
    expect(heads().length).toBe(3);
  });

  test("tag and other refs are lanes of their own without branch_head", async () => {
    const t = await finishRun(h, runClaims(1, { ref: "refs/tags/v1" }), sumFor(1));
    const o = await finishRun(h, runClaims(2, { ref: "refs/merge-queue/x", event_name: "merge_group" }), sumFor(2));
    expect(h.db.row("SELECT lane, branch FROM runs WHERE id = ?1", t.json.runId)).toEqual({ lane: "tag", branch: "tag:v1" });
    expect(h.db.row("SELECT lane FROM runs WHERE id = ?1", o.json.runId).lane).toBe("other");
    expect(heads()).toEqual([]);
  });

  test("keep_blobs follow the newest branch run per flag and drop old ones", async () => {
    const a = "1".repeat(40), b = "2".repeat(40);
    await finishN(h, 1, { sources: [{ path: "a", blob: a, bytes: 1 }] });
    expect(h.db.rows("SELECT blob_sha FROM keep_blobs").map((r) => r.blob_sha)).toEqual([a]);
    await finishN(h, 2, { sources: [{ path: "a", blob: b, bytes: 1 }] });
    expect(h.db.rows("SELECT blob_sha FROM keep_blobs").map((r) => r.blob_sha)).toEqual([b]);
    await finishN(h, 1, { sources: [{ path: "a", blob: a, bytes: 1 }] }); // stale retry cannot resurrect
    expect(h.db.rows("SELECT blob_sha FROM keep_blobs").map((r) => r.blob_sha)).toEqual([b]);
  });
});
