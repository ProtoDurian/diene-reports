import { beforeEach, describe, expect, test } from "bun:test";
import { runCron, CRON_GC, CRON_SWEEP } from "../src/cron";
import { DAY, MINUTE } from "../src/env";
import { finishN, finishRun, gitSha, gz, makeHarness, putGz, runClaims, startRun, sumFor, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});

const put = (content: string, sha = gitSha(content), claims: Record<string, unknown> = {}) =>
  h.call("PUT", `/api/v1/sources/${sha}`, { claims, rawBody: gz(content), headers: { "content-type": "application/gzip" } });
const check = (blobs: unknown, claims: Record<string, unknown> = {}) => h.call("POST", "/api/v1/sources/check", { claims, body: { blobs } });

describe("sources", () => {
  test("check reports missing blobs; put stores; check then reports none", async () => {
    const sha = gitSha("hello\n");
    expect((await check([sha])).json).toEqual({ missing: [sha] });
    const p = await put("hello\n");
    expect(p.status).toBe(200);
    expect((await check([sha])).json).toEqual({ missing: [] });
    expect(h.r2.keys("src/")).toEqual([`src/1001/${sha}`]);
    expect(h.db.row("SELECT bytes FROM blobs").bytes).toBe(6);
  });

  test("known git sha of the empty / known blob content matches the recompute", async () => {
    expect(gitSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  test("sha mismatch -> 400 and nothing stored", async () => {
    const r = await put("hello\n", gitSha("other"));
    expect(r.status).toBe(400);
    expect(h.r2.keys().length).toBe(0);
    expect(h.db.rows("SELECT * FROM blobs")).toEqual([]);
  });

  test("not gzip -> 400; empty -> 400; bad sha in path -> 400", async () => {
    expect((await h.call("PUT", `/api/v1/sources/${gitSha("x")}`, { rawBody: "plain text, not gzip" })).status).toBe(400);
    expect((await h.call("PUT", `/api/v1/sources/${gitSha("x")}`, { rawBody: "" })).status).toBe(400);
    expect((await put("x", "nothex")).status).toBe(400);
  });

  test("a repeat upload returns 204, re-stamps last_ref_at and does not rewrite R2", async () => {
    await put("same");
    const puts = h.r2.puts.length;
    h.clock.t += 5 * DAY;
    const r = await put("same");
    expect(r.status).toBe(204);
    expect(h.r2.puts.length).toBe(puts);
    expect(h.db.row("SELECT last_ref_at FROM blobs").last_ref_at).toBe(h.clock.t);
  });

  test("size caps: > 2 MB gzipped -> 413; > 1 MB decompressed -> 413", async () => {
    expect((await h.call("PUT", `/api/v1/sources/${gitSha("x")}`, { rawBody: "x", headers: { "content-length": String(2 * 1024 * 1024 + 1) } })).status).toBe(413);
    const bomb = "a".repeat(1024 * 1024 + 1);
    expect((await put(bomb)).status).toBe(413);
  });

  test("blobs are scoped per repo: another repo does not see them", async () => {
    await put("scoped");
    const other = { repository_id: "2002", repository: "ProtoDurian/other" };
    expect((await check([gitSha("scoped")], other)).json.missing.length).toBe(1);
  });

  test("check validates input and caps the list at 20000", async () => {
    expect((await check("nope")).status).toBe(400);
    expect((await check(["xyz"])).status).toBe(400);
    expect((await check(Array.from({ length: 20001 }, () => gitSha("a")))).status).toBe(400);
    expect((await check([])).json).toEqual({ missing: [] });
    expect((await check(Array.from({ length: 20000 }, (_, i) => gitSha(String(i % 50))))).status).toBe(200);
  });

  test("check re-stamps last_ref_at of present blobs", async () => {
    await put("keepme");
    h.clock.t += 10 * DAY;
    await check([gitSha("keepme")]);
    expect(h.db.row("SELECT last_ref_at FROM blobs").last_ref_at).toBe(h.clock.t);
  });

  test("source uploads have their own, larger rate bucket", async () => {
    for (let i = 0; i < 70; i++) expect((await check([gitSha("a")])).status).toBe(200);
    expect((await startRun(h)).status).toBe(200);
  });
});

describe("cron: lost sweeper", () => {
  test("marks started runs past their deadline as lost; leaves others alone", async () => {
    const late = await startRun(h, runClaims(1), { timeoutMinutes: 10 });
    const fine = await startRun(h, runClaims(2), { timeoutMinutes: 60 });
    const done = await finishN(h, 3);
    h.clock.t += 26 * MINUTE;
    const r = (await runCron(h.env, CRON_SWEEP, h.clock.t)) as { lost: number };
    expect(r.lost).toBe(1);
    const st = (id: number) => h.db.row("SELECT state FROM runs WHERE id = ?1", id).state;
    expect([st(late.json.runId), st(fine.json.runId), st(done.json.runId)]).toEqual(["lost", "started", "passed"]);
    expect(((await runCron(h.env, CRON_SWEEP, h.clock.t)) as { lost: number }).lost).toBe(0);
  });

  test("exactly at the deadline is not lost yet; a started run still reports its coverage after being lost", async () => {
    const s = await startRun(h, {}, { timeoutMinutes: 10 });
    h.clock.t = h.db.row("SELECT deadline_at FROM runs").deadline_at;
    await runCron(h.env, CRON_SWEEP, h.clock.t);
    expect(h.db.row("SELECT state FROM runs").state).toBe("started");
    await runCron(h.env, CRON_SWEEP, h.clock.t + 1);
    expect(h.db.row("SELECT state FROM runs").state).toBe("lost");
    expect((await putGz(h, `/api/v1/runs/${s.json.runId}/report`, "x")).status).toBe(200);
  });
});

describe("cron: GC", () => {
  const blob = async (content: string, ageDays: number) => {
    const t = h.clock.t;
    h.clock.t = T(ageDays, t);
    await put(content);
    h.clock.t = t;
    return gitSha(content);
  };
  const T = (ageDays: number, now: number) => now - ageDays * DAY;

  test("deletes unreferenced blobs older than 90 d from R2 and D1; keeps fresh and kept ones", async () => {
    const old = await blob("old", 100);
    const fresh = await blob("fresh", 10);
    const kept = await blob("kept", 120);
    await finishN(h, 1, { sources: [{ path: "k.ts", blob: kept, bytes: 4 }] });
    const r = (await runCron(h.env, CRON_GC, h.clock.t)) as { blobs: number };
    expect(r.blobs).toBe(1);
    const left = h.db.rows("SELECT blob_sha FROM blobs").map((x) => x.blob_sha).sort();
    expect(left).toEqual([fresh, kept].sort());
    expect(h.r2.keys("src/").sort()).toEqual([`src/1001/${fresh}`, `src/1001/${kept}`].sort());
    expect(h.r2.keys("src/").some((k) => k.endsWith(old))).toBe(false);
  });

  test("deletes run rows older than 180 d except branch heads; failures go with them", async () => {
    const headUnit = await finishN(h, 1, { failures: [{ id: "a" }] });
    const dropped = await finishN(h, 2, { flag: "int", job: "int", failures: [{ id: "z" }] });
    const headInt = await finishN(h, 3, { flag: "int", job: "int2", failures: [{ id: "h" }] });
    await h.env.DB.prepare("UPDATE runs SET created_at = ?1").bind(h.clock.t - 200 * DAY).run();
    h.clock.t += 1;
    await runCron(h.env, CRON_GC, h.clock.t);
    const ids = h.db.rows("SELECT id FROM runs ORDER BY id").map((r) => r.id);
    expect(ids).toEqual([headUnit.json.runId, headInt.json.runId]);
    expect(ids).not.toContain(dropped.json.runId);
    expect(h.db.rows("SELECT DISTINCT run_id FROM failures").map((r) => r.run_id).sort()).toEqual([...ids].sort());
  });

  test("young rows and stale rate counters", async () => {
    await finishN(h, 1);
    expect(h.db.rows("SELECT * FROM rate").length).toBeGreaterThan(0);
    h.clock.t += 3 * DAY;
    await runCron(h.env, CRON_GC, h.clock.t);
    expect(h.db.rows("SELECT * FROM runs").length).toBe(1);
    expect(h.db.rows("SELECT * FROM rate").length).toBe(0);
  });

  test("unknown cron strings fall back to the sweeper", async () => {
    expect(await runCron(h.env, "* * * * *", h.clock.t)).toEqual({ lost: 0 });
  });
});
