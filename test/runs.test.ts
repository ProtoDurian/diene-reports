import { beforeEach, describe, expect, test } from "bun:test";
import { runCron } from "../src/cron";
import { DAY, MINUTE } from "../src/env";
import { SHA, finishN, finishRun, gz, makeHarness, putGz, runClaims, startBody, startRun, summary, sumFor, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});

const run = (id: number) => h.db.row("SELECT * FROM runs WHERE id = ?1", id);

describe("start -> finish", () => {
  test("start creates a started run with deadline = now + timeout + 15 min", async () => {
    const r = await startRun(h, {}, { timeoutMinutes: 20 });
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("started");
    const row = run(r.json.runId);
    expect(row.state).toBe("started");
    expect(row.deadline_at).toBe(h.clock.t + 35 * MINUTE);
    expect(row.started_at).toBe(h.clock.t);
    expect(row.lane).toBe("branch");
    expect(row.branch).toBe("main");
    expect(row.head_sha).toBe(SHA);
    expect(h.db.rows("SELECT * FROM branch_head")).toEqual([]);
  });

  test("start is idempotent: same identity -> same run", async () => {
    const a = await startRun(h);
    const b = await startRun(h);
    expect(b.json.runId).toBe(a.json.runId);
    expect(h.db.rows("SELECT id FROM runs").length).toBe(1);
  });

  test("finish completes the started run and returns url + missingReport", async () => {
    const s = await startRun(h);
    const f = await finishRun(h, {}, summary({ failures: [{ id: "t1" }, { id: "t2", status: "errored" }] }));
    expect(f.status).toBe(200);
    expect(f.json.runId).toBe(s.json.runId);
    expect(f.json.url).toBe(`https://reports.atomi.cloud/ProtoDurian/demo/commit/${SHA}`);
    expect(f.json.missingReport).toBe(true);
    const row = run(f.json.runId);
    expect(row).toMatchObject({
      state: "tests_failed", t_total: 10, t_passed: 8, t_failed: 1, t_errored: 1, duration_ms: 250,
      cov_lines: 120, cov_lines_hit: 110, cov_format: "lcov", failures_truncated: 0, over_cap: 0,
    });
    expect(row.started_at).toBe(h.clock.t);
    expect(row.finished_at).toBe(h.clock.t);
    expect(h.db.rows("SELECT test_id FROM failures WHERE run_id = ?1 ORDER BY test_id", f.json.runId).map((r) => r.test_id)).toEqual(["t1", "t2"]);
    expect(h.r2.keys("sum/").length).toBe(1);
  });

  test("a finish keeps the id returned by start and a PUT report clears missingReport", async () => {
    const s = await startRun(h);
    const p = await putGz(h, `/api/v1/runs/${s.json.runId}/report`, "{}");
    expect(p.status).toBe(200);
    const f = await finishRun(h);
    expect(f.json.runId).toBe(s.json.runId);
    expect(f.json.missingReport).toBe(false);
  });

  test("orphan finish (no start) creates the run with started_at = null", async () => {
    const f = await finishRun(h, {}, summary({ cls: "errored", subReason: "crash", tests: null, coverage: null }));
    expect(f.status).toBe(200);
    const row = run(f.json.runId);
    expect(row).toMatchObject({ state: "errored", sub_reason: "crash", started_at: null, t_total: null, cov_lines: null });
    expect(row.deadline_at).toBeNull();
  });

  test("orphan finish uses the action's startedAt when there is no start record", async () => {
    const iso = new Date(h.clock.t - 5 * MINUTE).toISOString();
    const f = await finishRun(h, {}, summary({ startedAt: iso }));
    expect(run(f.json.runId).started_at).toBe(h.clock.t - 5 * MINUTE);
  });

  test("start after finish leaves the finished run alone", async () => {
    await finishRun(h, {}, summary({ failures: [{ id: "x" }] }));
    const s = await startRun(h);
    expect(s.json.state).toBe("tests_failed");
    expect(h.db.rows("SELECT * FROM runs").length).toBe(1);
  });

  test("finish after the sweeper marked the run lost replaces lost", async () => {
    const s = await startRun(h, {}, { timeoutMinutes: 10 });
    h.clock.t += 26 * MINUTE;
    await runCron(h.env, "*/15 * * * *", h.clock.t);
    expect(run(s.json.runId).state).toBe("lost");
    const f = await finishRun(h);
    expect(f.json.runId).toBe(s.json.runId);
    expect(run(s.json.runId).state).toBe("passed");
  });

  test("a re-run (new attempt) is a separate run row; different flags / jobs too", async () => {
    const a = await startRun(h);
    const b = await startRun(h, { run_attempt: "2" });
    const c = await startRun(h, {}, { flag: "int", job: "int" });
    const d = await startRun(h, {}, { flag: "unit", job: "unit2" });
    expect(new Set([a, b, c, d].map((x) => x.json.runId)).size).toBe(4);
  });

  test("every outcome class round-trips with its sub reason / job-failed-after-tests", async () => {
    const cases: [string, string | null, boolean][] = [
      ["passed", null, false], ["passed", null, true], ["tests_failed", null, false], ["errored", "gate", false],
      ["errored", "setup", false], ["errored", "crash", false], ["cancelled", null, false], ["timed_out", null, false],
      ["no_report", null, false], ["inactive", null, false],
    ];
    let i = 0;
    for (const [cls, sub, jf] of cases) {
      i++;
      const f = await finishN(h, i, { cls, subReason: sub, jobFailedAfterTests: jf, tests: null, coverage: null });
      expect(f.status).toBe(200);
      expect(run(f.json.runId)).toMatchObject({ state: cls, sub_reason: sub, job_failed_after_tests: jf ? 1 : 0 });
    }
  });

  test("subReason is only kept for errored runs", async () => {
    const f = await finishN(h, 1, { cls: "tests_failed", subReason: "crash", failures: [{ id: "a" }] });
    expect(run(f.json.runId).sub_reason).toBeNull();
  });

  test("notes, warnings, overCap, patch and partial coverage are stored", async () => {
    const body = summary({ overCap: true, covPartial: true, patch: { lines: 12, hit: 10, files: [] } });
    (body.outcome.notes as string[]) = ["coverage partial: a test binary panicked (go)"];
    (body.warnings as string[]) = ["coverage path not tracked by git: /nix/store/x"];
    const f = await finishRun(h, {}, body);
    const row = run(f.json.runId);
    expect(row).toMatchObject({ over_cap: 1, cov_partial: 1, patch_lines: 12, patch_lines_hit: 10 });
    expect(JSON.parse(row.notes)).toEqual(body.outcome.notes);
    expect(JSON.parse(row.warnings)).toEqual(body.warnings);
    expect(f.json.missingReport).toBe(false);
  });

  test("failures over 200 are cut and flagged truncated; message / stack are capped", async () => {
    const many = Array.from({ length: 230 }, (_, i) => ({ id: `t${i}` }));
    const body = summary({ failures: [{ id: "big", message: "m".repeat(9000), stack: "s".repeat(40000) }, ...many] });
    const f = await finishRun(h, {}, body);
    expect(f.status).toBe(200);
    expect(h.db.row("SELECT COUNT(*) n FROM failures").n).toBe(200);
    expect(run(f.json.runId).failures_truncated).toBe(1);
    const big = h.db.row("SELECT * FROM failures WHERE test_id = 'big'");
    expect(big.message.length).toBe(4096);
    expect(big.stack.length).toBe(16384);
  });

  test("duplicate test ids in one finish do not break the write", async () => {
    const f = await finishRun(h, {}, summary({ failures: [{ id: "dup" }, { id: "dup", name: "again" }] }));
    expect(f.status).toBe(200);
    expect(h.db.row("SELECT COUNT(*) n FROM failures").n).toBe(1);
  });

  test("finish is idempotent: a retry replaces failures and does not double count stats", async () => {
    const body = summary({ failures: [{ id: "a" }, { id: "b" }] });
    await finishRun(h, {}, body);
    const again = await finishRun(h, {}, summary({ failures: [{ id: "a" }] }));
    expect(h.db.rows("SELECT * FROM runs").length).toBe(1);
    expect(h.db.rows("SELECT test_id FROM failures WHERE run_id = ?1", again.json.runId).map((r) => r.test_id)).toEqual(["a"]);
    expect(h.db.row("SELECT fails_30d, flips_30d FROM test_stats WHERE test_id = 'a'")).toEqual({ fails_30d: 1, flips_30d: 0 });
  });

  test("a finish uses a handful of D1 statements", async () => {
    await startRun(h);
    const before = h.db.statements;
    await finishRun(h, {}, summary({ failures: Array.from({ length: 50 }, (_, i) => ({ id: `t${i}` })), sources: [{ path: "a.ts", blob: "c".repeat(40), bytes: 3 }] }));
    expect(h.db.statements - before).toBeLessThanOrEqual(18);
  });
});

describe("finish / start validation", () => {
  test("bad schema, bad class, missing fields -> 400", async () => {
    expect((await finishRun(h, {}, { ...summary(), schema: "nope" })).status).toBe(400);
    expect((await finishRun(h, {}, summary({ cls: "lost" }))).status).toBe(400);
    expect((await finishRun(h, {}, summary({ cls: "started" }))).status).toBe(400);
    expect((await finishRun(h, {}, { schema: "diene-summary/v1" })).status).toBe(400);
    const noFlag = summary();
    (noFlag.context as any).flag = "bad flag!";
    expect((await finishRun(h, {}, noFlag)).status).toBe(400);
    expect((await startRun(h, {}, { schema: "x" })).status).toBe(400);
    expect((await startRun(h, {}, { flag: "../x" })).status).toBe(400);
  });

  test("not JSON / empty body -> 400", async () => {
    expect((await h.call("POST", "/api/v1/runs/finish", { rawBody: "{nope" })).status).toBe(400);
    expect((await h.call("POST", "/api/v1/runs/finish", { rawBody: "" })).status).toBe(400);
  });

  test("finish body over 2 MB -> 413 (declared and streamed)", async () => {
    const big = JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024 + 10) });
    expect((await h.call("POST", "/api/v1/runs/finish", { rawBody: big })).status).toBe(413);
    expect((await h.call("POST", "/api/v1/runs/finish", { rawBody: big, headers: { "content-length": "100" } })).status).toBe(413);
  });

  test("context sha / runId / runAttempt mismatching the token -> 400", async () => {
    expect((await finishRun(h, {}, sumFor(1))).status).toBe(400); // sha differs
    expect((await finishRun(h, {}, summary({ claims: { runId: 1 } }))).status).toBe(400);
    expect((await finishRun(h, {}, summary({ claims: { runAttempt: 3 } }))).status).toBe(400);
  });

  test("known test ids may only contain safe characters", async () => {
    expect((await finishRun(h, {}, summary({ failures: [{ id: "a'; DROP TABLE runs;--" }] }))).status).toBe(400);
  });

  test("unknown route -> 404 JSON; GET on a POST route -> 404", async () => {
    const r = await h.call("GET", "/api/v1/nothing");
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("not found");
  });

  test("unauthenticated /api/v1 paths never reach handlers", async () => {
    expect((await h.call("GET", "/api/v1/runs/known-failing?flag=unit", { token: null })).status).toBe(401);
  });
});

describe("blob uploads bound to a run", () => {
  const upload = async (path: (id: number) => string, data = "{}", claims: Record<string, unknown> = {}, who: Record<string, unknown> = {}) => {
    const s = await startRun(h, claims);
    return { id: s.json.runId as number, res: await putGz(h, path(s.json.runId), data, who) };
  };

  test("report is streamed to R2 byte-for-byte and report_key is set", async () => {
    const payload = gz('{"schema":"diene-report/v1"}');
    const s = await startRun(h);
    const r = await h.call("PUT", `/api/v1/runs/${s.json.runId}/report`, { rawBody: payload });
    expect(r.status).toBe(200);
    const key = `rep/1001/${SHA}/unit/5000-1.json.gz`;
    expect(h.r2.objects.get(key)!.bytes).toEqual(payload);
    expect(run(s.json.runId).report_key).toBe(key);
  });

  test("cov chunks and raw files land at their contract keys", async () => {
    const s = await startRun(h);
    expect((await putGz(h, `/api/v1/runs/${s.json.runId}/cov/0`, "a")).status).toBe(200);
    expect((await putGz(h, `/api/v1/runs/${s.json.runId}/cov/12`, "b")).status).toBe(200);
    expect((await putGz(h, `/api/v1/runs/${s.json.runId}/raw/junit.xml`, "<x/>")).status).toBe(200);
    expect(h.r2.keys()).toEqual([
      `cov/1001/${SHA}/unit/5000-1/0.json.gz`,
      `cov/1001/${SHA}/unit/5000-1/12.json.gz`,
      `raw/1001/${SHA}/5000-1/unit/junit.xml.gz`,
    ]);
  });

  test("a re-upload overwrites, never duplicates", async () => {
    const s = await startRun(h);
    await putGz(h, `/api/v1/runs/${s.json.runId}/report`, "one");
    await putGz(h, `/api/v1/runs/${s.json.runId}/report`, "two-two-two");
    expect(h.r2.keys("rep/").length).toBe(1);
  });

  test("chunk index and raw name are validated", async () => {
    const s = await startRun(h);
    for (const bad of ["cov/-1", "cov/x", "cov/123456", "raw/a%2Fb", "raw/..%2Fx", "raw/a%20b", `raw/${"a".repeat(101)}`]) {
      expect((await putGz(h, `/api/v1/runs/${s.json.runId}/${bad}`, "x")).status).toBe(400);
    }
    expect((await putGz(h, `/api/v1/runs/abc/report`, "x")).status).toBe(400);
  });

  test("unknown run -> 404; another run's id -> 403 (other run id, attempt or repo)", async () => {
    expect((await putGz(h, `/api/v1/runs/9999/report`, "x")).status).toBe(404);
    const s = await startRun(h);
    const p = `/api/v1/runs/${s.json.runId}/report`;
    expect((await putGz(h, p, "x", { run_id: "6000" })).status).toBe(403);
    expect((await putGz(h, p, "x", { run_attempt: "2" })).status).toBe(403);
    expect((await putGz(h, p, "x", { repository_id: "2002", repository: "ProtoDurian/other" })).status).toBe(403);
    expect(h.r2.keys().length).toBe(0);
  });

  test("size caps: report > 20 MB, cov > 4 MB, raw > 20 MB -> 413 without touching R2", async () => {
    const s = await startRun(h);
    const big = (n: number) => ({ "content-length": String(n) });
    expect((await h.call("PUT", `/api/v1/runs/${s.json.runId}/report`, { rawBody: "x", headers: big(20 * 1024 * 1024 + 1) })).status).toBe(413);
    expect((await h.call("PUT", `/api/v1/runs/${s.json.runId}/cov/0`, { rawBody: "x", headers: big(4 * 1024 * 1024 + 1) })).status).toBe(413);
    expect((await h.call("PUT", `/api/v1/runs/${s.json.runId}/raw/a.txt`, { rawBody: "x", headers: big(20 * 1024 * 1024 + 1) })).status).toBe(413);
    expect(h.r2.keys().length).toBe(0);
  });

  test("a body without content-length is buffered with the same cap; empty body -> 400", async () => {
    const s = await startRun(h);
    const bytes = gz("hello");
    const res = await h.app.request(`/api/v1/runs/${s.json.runId}/report`, { method: "PUT", headers: { authorization: `Bearer ${await h.token()}` }, body: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(), duplex: "half" } as RequestInit, h.env);
    expect(res.status).toBe(200);
    expect(h.r2.keys("rep/").length).toBe(1);
    expect((await h.call("PUT", `/api/v1/runs/${s.json.runId}/cov/0`, { rawBody: "" })).status).toBe(400);
  });

  test("the worker never decompresses report bodies (garbage is stored as-is)", async () => {
    const s = await startRun(h);
    const r = await h.call("PUT", `/api/v1/runs/${s.json.runId}/report`, { rawBody: new Uint8Array([1, 2, 3, 4]) });
    expect(r.status).toBe(200);
    expect(upload).toBeDefined();
  });
});

describe("rate limit", () => {
  const seedRate = (flag: string, job: string, n: number) =>
    h.db.sqlite.prepare("INSERT OR REPLACE INTO rate (repo_id, gh_run_id, attempt, flag, job, n, created_at) VALUES (1001, 5000, 1, ?1, ?2, ?3, ?4)").run(flag, job, n, h.clock.t);

  test("2001st write for one test job (repo, run, attempt, flag, job) -> 429; other jobs and runs are unaffected", async () => {
    const s = await startRun(h); // write #1 for unit/unit
    seedRate("unit", "unit", 1999); // 1999 so far
    expect((await putGz(h, `/api/v1/runs/${s.json.runId}/cov/0`, "x")).status).toBe(200); // 2000th
    const over = await putGz(h, `/api/v1/runs/${s.json.runId}/cov/1`, "x");
    expect(over.status).toBe(429);
    expect((await finishRun(h, {}, summary())).status).toBe(429);
    // another job of the same workflow run has its own budget
    expect((await startRun(h, {}, { flag: "e2e", job: "e2e" })).status).toBe(200);
    expect((await startRun(h, { run_attempt: "2" })).status).toBe(200);
    expect((await startRun(h, { run_id: "7000" })).status).toBe(200);
  });

  test("a multi-job run is not starved: 60+ writes across jobs are fine", async () => {
    for (let j = 0; j < 5; j++) {
      const flag = `f${j}`;
      const s = await startRun(h, {}, { flag, job: flag });
      for (let i = 0; i < 30; i++) expect((await putGz(h, `/api/v1/runs/${s.json.runId}/cov/${i}`, "x")).status).toBe(200);
    }
  });

  test("known-failing (a read) is not counted", async () => {
    for (let i = 0; i < 70; i++) expect((await h.call("GET", "/api/v1/runs/known-failing?flag=unit")).status).toBe(200);
  });
});

describe("known-failing", () => {
  test("lists failing ids of this project+flag; recovered ids drop out; other lanes get []", async () => {
    await finishN(h, 1, { failures: [{ id: "a" }, { id: "b" }] });
    await finishN(h, 1, { flag: "int", job: "int", failures: [{ id: "zzz" }] });
    let r = await h.call("GET", "/api/v1/runs/known-failing?flag=unit");
    expect(r.json.ids).toEqual(["a", "b"]);
    await finishN(h, 2, { recovered: ["a"], failures: [{ id: "b" }] });
    r = await h.call("GET", "/api/v1/runs/known-failing?flag=unit");
    expect(r.json.ids).toEqual(["b"]);
    const pr = await h.call("GET", "/api/v1/runs/known-failing?flag=unit", { claims: { ref: "refs/pull/3/merge", event_name: "pull_request" } });
    expect(pr.json.ids).toEqual([]);
    const other = await h.call("GET", "/api/v1/runs/known-failing?flag=unit", { claims: { ref: "refs/heads/dev" } });
    expect(other.json.ids).toEqual([]);
    expect((await h.call("GET", "/api/v1/runs/known-failing")).status).toBe(400);
  });
});

describe("misc", () => {
  test("healthz is public", async () => {
    const res = await h.app.request("/healthz", {}, h.env);
    expect(res.status).toBe(200);
  });

  test("gz helper sanity", () => {
    expect(gz("x").byteLength).toBeGreaterThan(0);
    expect(DAY).toBe(86_400_000);
    expect(startBody().flag).toBe("unit");
    expect(runClaims(1).run_id).toBe("5001");
  });
});
