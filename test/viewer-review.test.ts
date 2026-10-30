import { beforeEach, describe, expect, test } from "bun:test";
import { DAY } from "../src/env";
import { makeHarness, makeKeyPair, finishN, finishRun, putGz, runClaims, startRun, sumFor, summary, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
const base = "/ProtoDurian/demo";
const covOf = (lines: number, hit: number) => ({ format: "lcov", totals: { lines, linesHit: hit, branches: null, branchesHit: null }, partial: false, files: [{ path: "src/a.ts", lines, hit, chunk: 0 }] });

async function fullRun(n: number, o: Parameters<typeof summary>[0] = {}, report?: unknown) {
  const claims = runClaims(n);
  const id = (await startRun(h, claims)).json.runId as number;
  if (report !== undefined) await putGz(h, `/api/v1/runs/${id}/report`, JSON.stringify(report), claims);
  await putGz(h, `/api/v1/runs/${id}/cov/0`, JSON.stringify({ files: { "src/a.ts": { lines: [[1, 1], [2, 0]] } } }), claims);
  expect((await finishRun(h, claims, sumFor(n, o))).status).toBe(200);
  return id;
}
const sha = (n: number) => n.toString(16).padStart(40, "0");

describe("#1 badges and heads survive a newer run that has no data", () => {
  test("coverage and tests badges stay while the next run is only started or was cancelled", async () => {
    await finishN(h, 1, { coverage: covOf(100, 92) });
    const badge = async (f: string) => (await h.view(`/badge/ProtoDurian/demo/${f}.svg`)).text;
    expect(await badge("unit")).toContain("92.0%");
    await startRun(h, runClaims(2));
    expect(await badge("unit")).toContain("92.0%");
    expect(await badge("tests")).toContain("passing");
    await finishN(h, 3, { cls: "cancelled", tests: null, coverage: null });
    expect(await badge("unit")).toContain("92.0%");
    await finishN(h, 4, { failures: [{ id: "t1" }], coverage: null });
    expect(await badge("unit")).toContain("92.0%");
    expect(await badge("tests")).toContain("failing");
  });

  test("the repo page shows coverage from the coverage head when the newest run had none", async () => {
    await finishN(h, 1, { coverage: covOf(100, 80) });
    await finishN(h, 2, { failures: [{ id: "t1" }], coverage: null });
    const t = (await h.view(`${base}?branch=main`)).text;
    expect(t).toContain("80.0%");
    expect(t).toContain(`from <a href="${base}/commit/${sha(1)}"`);
    expect((await h.view("/")).text).toContain("80.0%");
  });
});

describe("#2 viewer falls back to keep/ when sum/, cov/ and rep/ expired", () => {
  test("the branch head still shows its coverage tree, file view data and test list after GC", async () => {
    const report = { tests: { cases: [{ id: "a", suite: "s", name: "adds", status: "passed", durationMs: 3 }] } };
    const id = await fullRun(1, { coverage: covOf(10, 9) }, report);
    for (const prefix of ["sum/", "rep/", "cov/"]) for (const k of h.r2.keys(prefix)) await h.r2.delete(k);
    expect(h.r2.keys("keep/").length).toBeGreaterThan(0);
    const cov = await h.view(`${base}/commit/${sha(1)}/coverage?flag=unit`);
    expect(cov.status).toBe(200);
    expect(cov.text).toContain("a.ts");
    expect(cov.text).not.toContain("expired");
    expect((await h.view(`${base}/run/${id}/tests`)).text).toContain("adds");
  });

  test("an older, non-head run after expiry says so instead of crashing", async () => {
    await fullRun(1, { coverage: covOf(10, 9) });
    await fullRun(2, { coverage: covOf(10, 8) });
    h.clock.t += 100 * DAY; // sum/, cov/ and rep/ are gone (lifecycle); only the head's keep/ copy remains
    for (const prefix of ["sum/", "rep/", "cov/"]) for (const k of h.r2.keys(prefix)) await h.r2.delete(k);
    const old = await h.view(`${base}/commit/${sha(1)}/coverage?flag=unit`);
    expect(old.status).toBe(200);
    expect(old.text).toContain("expired");
    const head = await h.view(`${base}/commit/${sha(2)}/coverage?flag=unit`);
    expect(head.text).toContain("a.ts");
  });
});

describe("#3 per-run test list from rep/", () => {
  const cases = [
    { id: "p1", suite: "math", name: "adds", file: "m.test.ts", line: 3, status: "passed", durationMs: 4 },
    { id: "s1", suite: "math", name: "is skipped", status: "skipped" },
    { id: "f1", suite: "math", name: "fails <b>x</b>", status: "failed", durationMs: 1 },
    { id: "e1", suite: "io", name: "errors", status: "errored" },
    { id: "x1", name: 5, status: "passed" }, // malformed: ignored
  ];

  test("lists failed, errored, skipped and passed tests in folded groups, escaped", async () => {
    const id = await fullRun(1, { failures: [{ id: "f1" }] }, { tests: { cases } });
    const r = await h.view(`${base}/run/${id}/tests`);
    expect(r.status).toBe(200);
    for (const w of ["Failed", "Errored", "Skipped", "Passed", "adds", "is skipped", "errors"]) expect(r.text).toContain(w);
    expect(r.text).toContain("fails &lt;b&gt;x&lt;/b&gt;");
    expect(r.text).not.toContain("<b>x</b>");
    expect(r.text).toMatch(/<details class="tests" open><summary>[^]*?Failed/);
    expect(r.text).toMatch(/<details class="tests"><summary>[^]*?Passed/);
    const card = (await h.view(`${base}/commit/${sha(1)}`)).text;
    expect(card).toContain(`/run/${id}/tests`);
  });

  test("says why when the report is missing or too large", async () => {
    const claims = runClaims(1);
    const id = (await startRun(h, claims)).json.runId as number;
    await finishRun(h, claims, sumFor(1));
    expect((await h.view(`${base}/run/${id}/tests`)).text).toContain("not available");
    const big = new Uint8Array(5 * 1024 * 1024 + 10);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
    const c2 = runClaims(2);
    const id2 = (await startRun(h, c2)).json.runId as number;
    const put = await h.call("PUT", `/api/v1/runs/${id2}/report`, { claims: c2, rawBody: new Uint8Array(Bun.gzipSync(big, { level: 0 })), headers: { "content-type": "application/gzip" } });
    expect(put.status).toBe(200);
    await finishRun(h, c2, sumFor(2));
    const r = await h.view(`${base}/run/${id2}/tests`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("too large");
  });

  test("the truncation note points at the full list instead of claiming the rest is lost", async () => {
    const fails = Array.from({ length: 3 }, (_, i) => ({ id: `f${i}` }));
    await fullRun(1, { failures: fails, truncated: true }, { tests: { cases } });
    const t = (await h.view(`${base}/commit/${sha(1)}`)).text;
    expect(t).toContain("all-tests page");
    expect(t).not.toContain("only the first 200");
    expect(t).not.toContain("Only the first 200 failures are kept");
  });

  test("bad run ids 404", async () => {
    expect((await h.view(`${base}/run/abc/tests`)).status).toBe(404);
    expect((await h.view(`${base}/run/99999/tests`)).status).toBe(404);
  });
});

describe("#5 malformed stored documents never 500 a page", () => {
  test("patch files without uncovered, numeric coverage paths and junk chunks are skipped", async () => {
    const claims = prClaimsFor(1, 5);
    const id = (await startRun(h, claims, { headSha: sha(0xaa), pr: 5, baseRef: "main" })).json.runId as number;
    const body = sumFor(1, { headSha: sha(0xaa), pr: 5, baseRef: "main" }) as any;
    body.patch = { lines: 4, hit: 2, files: [{ path: "src/a.ts" }, { path: 7 }, { path: "src/b.ts", lines: 4, hit: 2, uncovered: [3, "x", null, 4] }] };
    body.coverage.files = [{ path: 5, lines: 1, hit: 1, chunk: 0 }, { path: "src/a.ts", lines: 2, hit: 1, chunk: 0 }, null, { path: "src/b.ts" }];
    const stored = JSON.stringify(body);
    // write the summary straight into R2 (the API would reject these, the viewer must still survive old/odd documents)
    await finishRun(h, claims, sumFor(1, { headSha: sha(0xaa), pr: 5, baseRef: "main", patch: { lines: 4, hit: 2, files: [{ path: "src/b.ts", lines: 4, hit: 2, uncovered: [3, 4] }] } }));
    const key = h.db.row<{ summary_key: string }>(`SELECT summary_key FROM runs WHERE id = ${id}`)!.summary_key;
    await h.r2.put(key, new Uint8Array(Bun.gzipSync(stored)));
    await h.r2.put(`cov/1001/${sha(1)}/unit/5001-1/0.json.gz`, new Uint8Array(Bun.gzipSync(JSON.stringify({ files: { "src/a.ts": { lines: [[1, 1], "bad", [2]] }, "src/b.ts": 5 } }))));
    for (const p of [`${base}/pull/5`, `${base}/commit/${sha(1)}`, `${base}/commit/${sha(1)}/coverage?flag=unit`, `${base}/commit/${sha(1)}/file?path=src%2Fa.ts&flag=unit`]) {
      const r = await h.view(p);
      expect(`${p} ${r.status}`).toBe(`${p} 200`);
    }
  });
});

const prClaimsFor = (n: number, pr: number) => ({ ref: `refs/pull/${pr}/merge`, event_name: "pull_request", ...runClaims(n) });

describe("#6 job failed after tests", () => {
  test("a passed run whose job failed shows a 'job failed' chip, ranks above passed, and heads the banner", async () => {
    await finishN(h, 1, { jobFailedAfterTests: true });
    const t = (await h.view(`${base}?branch=main`)).text;
    expect(t).toContain("job failed");
    expect(t).not.toMatch(/job failed[^]{0,40}no report/);
    expect(t).toMatch(/class="row tone-warn"/);
    const home = (await h.view("/")).text;
    expect(home).toContain("job failed");
    expect(home).toMatch(/class="row tone-warn"/);
  });
});

describe("#7 PR patch coverage is per flag", () => {
  test("two flags are listed separately and never summed", async () => {
    for (const [flag, hit] of [["unit", 10], ["integration", 2]] as const) {
      const claims = prClaimsFor(1, 9);
      await startRun(h, claims, { flag, job: flag, headSha: sha(0xbb), pr: 9, baseRef: "main" });
      await finishRun(h, claims, sumFor(1, { flag, job: flag, headSha: sha(0xbb), pr: 9, baseRef: "main", patch: { lines: 12, hit, files: [{ path: "src/a.ts", lines: 12, hit, uncovered: [1] }] } }));
    }
    const t = (await h.view(`${base}/pull/9`)).text;
    expect(t).toContain("10/12");
    expect(t).toContain("2/12");
    expect(t).not.toContain("12/24");
    expect(t).not.toContain("50%");
    expect(t).toContain("not added together");
  });
});

describe("#11 commit ids must be full", () => {
  test("a short sha is a clean 404 with a hint; the full id works", async () => {
    await finishN(h, 1);
    const short = await h.view(`${base}/commit/${sha(1).slice(0, 7)}`);
    expect(short.status).toBe(404);
    expect(short.text).toContain("40-character");
    expect((await h.view(`${base}/commit/${sha(1)}`)).status).toBe(200);
  });
});

describe("nits", () => {
  test("test history never claims a pass it cannot know about", async () => {
    await finishN(h, 1);
    await finishN(h, 2, { failures: [{ id: "tflaky0000000001" }] });
    await finishN(h, 3);
    await finishN(h, 4);
    const t = (await h.view(`${base}/test/tflaky0000000001?branch=main`)).text;
    expect(t).toContain("no failure reported");
    expect(t).not.toMatch(/<\/code> passed/);
    expect(t).not.toContain(`commit/${sha(1)}"`); // before the first recorded failure: not listed
    expect(t).toContain(`commit/${sha(2)}"`);
  });

  test("inactive stays out of the red banner", async () => {
    await finishN(h, 1, { cls: "inactive", tests: null, coverage: null });
    const t = (await h.view(`${base}/commit/${sha(1)}`)).text;
    expect(t).not.toContain("Not everything went well");
    expect(t).not.toContain('class="banner');
    await finishN(h, 2, { cls: "inactive", tests: null, coverage: null, flag: "lint", job: "lint" });
    await finishN(h, 2, { cls: "cancelled", tests: null, coverage: null });
    const t2 = (await h.view(`${base}/commit/${sha(2)}`)).text;
    expect(t2).toContain("Not everything went well");
    const banner = /<section class="banner[^]*?<\/section>/.exec(t2)![0];
    expect(banner).toContain("cancelled");
    expect(banner).not.toContain("inactive");
    expect(t2).toContain("nothing to run"); // the card itself still says so, in neutral tone
  });

  test("a raw upload that is not gzip gives a clean 404, not a broken stream", async () => {
    const claims = runClaims(1);
    const id = (await startRun(h, claims)).json.runId as number;
    await h.r2.put(`raw/1001/${sha(1)}/5001-1/unit/x.txt.gz`, new TextEncoder().encode("plain"));
    const r = await h.view(`${base}/run/${id}/raw/x.txt`);
    expect(r.status).toBe(404);
  });

  test("the banner list keeps its bullets in line (block links)", async () => {
    expect((await h.view("/assets/app.css")).text).toContain(".banner li a{display:block");
  });
});
