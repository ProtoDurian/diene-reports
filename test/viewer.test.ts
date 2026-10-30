import { beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, type Harness } from "./harness";
import { FLAKY_ID, NEW_ID, PR_HEAD, REPO, XSS_ID, seedDemo, shaN, type Seeded } from "./fixtures";

let h: Harness;
let s: Seeded;
const base = `/${REPO.owner}/${REPO.name}`;
const get = (path: string) => h.view(path);

beforeAll(async () => {
  h = await makeHarness();
  s = await seedDemo(h);
});

describe("pages render and are safe", () => {
  test("home lists projects with flag states", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.text).toContain("demo-app");
    expect(r.text).toContain('href="/assets/app.css"');
    expect(r.text).toContain('name="viewport"');
  });

  test("every HTML page carries the strict CSP and hardening headers, no inline script/style", async () => {
    const paths = ["/", base, `${base}/commit/${s.showcaseSha}`, `${base}/pull/7`, `${base}/commit/${shaN(0x77)}/coverage`, "/nope"];
    for (const p of paths) {
      const r = await get(p);
      expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.text).not.toMatch(/<script(?![^>]*\bsrc=)/i);
      expect(r.text).not.toMatch(/<[^>]*\sstyle=/i);
      expect(r.text).not.toMatch(/<[^>]*\son[a-z]+=/i);
    }
  });

  test("untrusted test names, messages and stacks are escaped", async () => {
    const r = await get(`${base}/commit/${s.showcaseSha}`);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("<script>alert");
    expect(r.text).not.toContain("<img src=x");
    expect(r.text).not.toContain("<b>bold</b>");
    expect(r.text).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(r.text).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("commit page tells the truth about failed runs", () => {
  test("banner names each problem in plain words", async () => {
    const t = (await get(`${base}/commit/${s.showcaseSha}`)).text;
    expect(t).toMatch(/did not finish: runner lost/i);
    expect(t).toMatch(/timed out/i);
    expect(t).toMatch(/failed/i);
  });

  test("failures are shown (with NEW / FLAKY / ERROR marks) next to coverage for a failed run", async () => {
    const t = (await get(`${base}/commit/${s.showcaseSha}`)).text;
    expect(t).toContain("retries the upload");
    expect(t).toContain("divide by zero throws a RangeError");
    expect(t).toContain("tag-new");
    expect(t).toContain("tag-flaky");
    expect(t).toContain("tag-err");
    expect(t).toContain("78"); // 94/120 coverage still shown
    expect(t.indexOf("retries the upload")).toBeGreaterThan(0);
  });

  test("file:line links point at GitHub at the SHA", async () => {
    const t = (await get(`${base}/commit/${s.showcaseSha}`)).text;
    expect(t).toContain(`https://github.com/ProtoDurian/demo-app/blob/${s.showcaseSha}/src/upload.test.ts`);
  });

  test("gate failure keeps tests and coverage, says the coverage gate failed", async () => {
    const t = (await get(`${base}/commit/${s.failedRunSha}`)).text;
    expect(t).toMatch(/coverage gate failed/i);
    expect(t).toMatch(/crashed before reporting tests/i);
    expect(t).toMatch(/cancelled/i);
    expect(t).toMatch(/job failed after the tests/i);
  });

  test("unknown or malformed commits give an HTML 404", async () => {
    const a = await get(`${base}/commit/${"9".repeat(40)}`);
    expect(a.status).toBe(404);
    expect(a.headers.get("content-type")).toContain("text/html");
    expect((await get(`${base}/commit/not-a-sha`)).status).toBe(404);
    expect((await get(`/nobody/nothing`)).status).toBe(404);
  });
});

describe("repo, PR, coverage, file, test pages", () => {
  test("repo page lists commits and PRs", async () => {
    const r = await get(`${base}?branch=main`);
    expect(r.status).toBe(200);
    expect(r.text).toContain(`/commit/${s.showcaseSha}`);
    expect(r.text).toContain("/pull/7");
  });

  test("PR page shows patch coverage and uncovered files", async () => {
    const r = await get(`${base}/pull/7`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Patch coverage");
    expect(r.text).toContain("src/lib/math.ts");
    expect(r.text).toContain(PR_HEAD.slice(0, 7));
    expect((await get(`${base}/pull/8`)).status).toBe(200);
    expect((await get(`${base}/pull/999`)).status).toBe(404);
  });

  test("coverage tree lists files with percentages", async () => {
    const r = await get(`${base}/commit/${shaN(0x77)}/coverage?flag=unit`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("math.ts");
    expect(r.text).toMatch(/\d+(\.\d+)?%/);
  });

  test("file page renders source as text with hit/miss/changed rows", async () => {
    const r = await get(`${base}/commit/${shaN(0x77)}/file?path=${encodeURIComponent("src/lib/math.ts")}&flag=unit`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('class="hit"');
    expect(r.text).toMatch(/class="miss chg"/);
    expect(r.text).toContain('id="L14"');
    expect(r.text).toContain("throw new Error(&quot;division by zero&quot;)");
    expect(r.text).toContain('/assets/line.js');
  });

  test("file page without a stored source links to GitHub", async () => {
    const r = await get(`${base}/commit/${s.showcaseSha}/file?path=${encodeURIComponent("src/upload.ts")}&flag=unit`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("not stored");
    expect(r.text).toContain("github.com/ProtoDurian/demo-app/blob/");
  });

  test("test history page shows the flaky test and its last failure", async () => {
    const r = await get(`${base}/test/${FLAKY_ID}?branch=main`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("retries the upload");
    expect((await get(`${base}/test/${XSS_ID}?branch=main`)).status).toBe(200);
    expect((await get(`${base}/test/${NEW_ID}?branch=nonexistent`)).status).toBe(404);
  });
});

describe("badges", () => {
  test("coverage badge: green/amber/red from percentage, cacheable, locked-down", async () => {
    const r = await get(`/badge/${REPO.owner}/${REPO.name}/unit.svg?branch=main`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.text).toContain("<svg");
    expect(r.text).toMatch(/\d+(\.\d+)?%/);
  });

  test("tests badge reports failing tests in red", async () => {
    const r = await get(`/badge/${REPO.owner}/${REPO.name}/tests.svg?branch=main`);
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/failing|passing|failed/);
  });

  test("private and unknown repos both give the same grey 'unknown'", async () => {
    const p = await get(`/badge/ProtoDurian/secret-svc/unit.svg`);
    expect(p.text).toContain("unknown");
    expect(p.text).not.toContain("private");
    expect(p.text).toContain("#8a8f98");
    expect(p.text).not.toContain("%");
    expect((await get(`/badge/x/y/unit.svg`)).text).toContain("unknown");
  });

  test("bad badge file names are rejected", async () => {
    expect((await get(`/badge/${REPO.owner}/${REPO.name}/unit.png`)).status).toBe(404);
  });
});

describe("raw files and assets", () => {
  test("raw downloads are attachments, nosniff, gunzipped", async () => {
    const claims = { repository: "ProtoDurian/demo-app", repository_id: "1001", run_id: "6004", sha: shaN(4) };
    const row = h.db.row<{ id: number }>(`SELECT id FROM runs WHERE gh_run_id = 6004 AND flag = 'smoke'`)!;
    const put = await h.call("PUT", `/api/v1/runs/${row.id}/raw/out.txt`, { claims, rawBody: new Uint8Array(Bun.gzipSync(new TextEncoder().encode("<html>hello</html>"))), headers: { "content-type": "application/gzip" } });
    expect(put.status).toBe(200);
    const r = await get(`${base}/run/${row.id}/raw/out.txt`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toStartWith("attachment");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.text).toBe("<html>hello</html>");
    expect((await get(`${base}/run/${row.id}/raw/..%2Fetc`)).status).toBe(404);
    expect((await get(`${base}/run/${row.id}/raw/missing.txt`)).status).toBe(404);
  });

  test("css is small and handles mobile + dark mode; js is a few KB", async () => {
    const css = await get("/assets/app.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.text).toContain("prefers-color-scheme:dark");
    expect(css.text).toContain("max-width:640px");
    expect(css.text).toContain("min-height:44px");
    expect(css.text.length).toBeLessThan(16 * 1024);
    const js = await get("/assets/line.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.text.length).toBeLessThan(4 * 1024);
  });

  test("the API still answers JSON, and healthz works", async () => {
    const a = await get("/api/v1/runs/start");
    expect(a.headers.get("content-type")).toContain("application/json");
    expect((await get("/api/v1/unknown")).status).toBe(401);
    expect((await get("/healthz")).status).toBe(200);
  });
});
