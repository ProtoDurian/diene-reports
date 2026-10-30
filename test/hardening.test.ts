import { beforeEach, describe, expect, test } from "bun:test";
import { CRON_VISIBILITY, runCron } from "../src/cron";
import { HOUR } from "../src/env";
import { safeNext } from "../src/session";
import { VIS_FRESH_MS } from "../src/visibility";
import { finishN, makeHarness, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  await finishN(h, 1); // ProtoDurian/demo, public, id 1001
  await finishN(h, 2, {}, { repository: "ProtoDurian/secret-svc", repository_id: "1002", repository_visibility: "private" });
});

const PUB_ID = 1001;
const PRIV_ID = 1002;
const alice = { id: 42, login: "alice" };
const sha = (n: number) => n.toString(16).padStart(40, "0");
const demo = "/ProtoDurian/demo";
const secret = "/ProtoDurian/secret-svc";
const SESSION = "__Host-diene_session";
const STATE = "__Host-diene_state";
const rows = async (sql: string) => (await h.env.DB.prepare(sql).all<any>()).results;
const repoRow = async (id: number) => (await rows(`SELECT * FROM repos WHERE repo_id = ${id}`))[0];
/** GitHub lookups made by the visibility check (not the signed-in user's own token checks) */
const visCalls = () => h.gh.calls.filter((c) => c.method === "GET" && c.url.includes("/repositories/") && !c.auth?.startsWith("Bearer ghu_"));
const sweep = () => runCron(h.env, CRON_VISIBILITY, h.clock.t, h.gh.fetch) as Promise<{ checked: number; changed: number; skipped: number }>;
const pagesOf = (p: string) => [p, `${p}/commit/${sha(1)}`, `${p}/commit/${sha(1)}/coverage`, `${p}/commit/${sha(1)}/file?path=src/a.ts`, `${p}/run/5001/tests`, `${p}/run/5001/raw/x`, `${p}/pull/1`, `${p}/test/x`];

describe("safeNext", () => {
  test("nothing that a browser could read as another site survives normalisation", () => {
    for (const bad of ["/.//evil.example", "/a/..//evil.example", "/.///evil.example", "//evil.example", "/\\evil", "https://evil.example"]) {
      expect(`${bad} -> ${safeNext(bad)}`).toBe(`${bad} -> /`);
    }
    expect(safeNext("/ProtoDurian/demo?branch=main")).toBe("/ProtoDurian/demo?branch=main");
    expect(safeNext("/a/../b")).toBe("/b");
  });
});

describe("badges", () => {
  test("a private repo's badge is byte-for-byte the badge of a repo that does not exist", async () => {
    const p = await h.view("/badge/ProtoDurian/secret-svc/unit.svg");
    const u = await h.view("/badge/ProtoDurian/nope/unit.svg");
    expect(p.status).toBe(200);
    expect(p.text).toBe(u.text);
    expect(p.text).toContain("unknown");
  });
});

describe("GitHub rate limit on the user's check", () => {
  test("is a try-again page, never a cached 'no'", async () => {
    const cookie = await h.signIn(alice, [PRIV_ID]);
    h.gh.rateLimited = true;
    const limited = await h.view(secret, { cookie });
    expect(limited.status).toBe(503);
    expect(limited.text).toContain("try again");
    expect(await rows("SELECT * FROM repo_access")).toHaveLength(0);
    h.gh.rateLimited = false;
    expect((await h.view(secret, { cookie })).status).toBe(200);
  });
});

describe("token refresh failing with a server error", () => {
  test("a 5xx keeps the session; a 4xx signs out for good", async () => {
    const cookie = await h.signIn(alice);
    h.clock.t += 9 * HOUR;
    h.gh.refreshStatus = 502;
    expect((await h.view("/", { cookie })).text).toContain("Sign in with GitHub");
    expect(await rows("SELECT * FROM sessions")).toHaveLength(1);
    h.gh.refreshStatus = null;
    expect((await h.view("/", { cookie })).text).toContain("alice");

    h.clock.t += 9 * HOUR;
    h.gh.refreshStatus = 401;
    expect((await h.view("/", { cookie })).text).toContain("Sign in with GitHub");
    expect(await rows("SELECT * FROM sessions")).toHaveLength(0);
  });
});

describe("one session per sign-in", () => {
  test("signing in again from the same browser deletes the old session row", async () => {
    const old = await h.signIn(alice);
    const oldValue = old.split("=")[1]!;
    const start = await h.app.request("/login", {}, h.env);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = new RegExp(`${STATE}=([^;]+)`).exec(start.headers.get("set-cookie")!)![1];
    const cb = await h.app.request(`/auth/callback?code=code-42&state=${state}`, { headers: { cookie: `${STATE}=${stateCookie}; ${SESSION}=${oldValue}` } }, h.env);
    expect(cb.status).toBe(302);
    expect(await rows("SELECT * FROM sessions")).toHaveLength(1);
    expect((await h.view("/", { cookie: old })).text).toContain("Sign in with GitHub");
    expect((await h.view("/", { cookie: new RegExp(`(${SESSION}=[^;]+)`).exec(cb.headers.get("set-cookie")!)![1]! })).text).toContain("alice");
  });
});

describe("logout also revokes the token at GitHub", () => {
  const post = (cookie: string) => h.app.request("/logout", { method: "POST", headers: { cookie, origin: "https://reports.atomi.cloud" } }, h.env);

  test("DELETE /applications/{client_id}/token with Basic auth and the user's token", async () => {
    const cookie = await h.signIn(alice);
    const [token] = [...h.gh.tokens.keys()];
    expect((await post(cookie)).status).toBe(303);
    const del = h.gh.calls.filter((c) => c.method === "DELETE");
    expect(del).toHaveLength(1);
    expect(del[0]!.url).toBe("https://api.github.com/applications/Iv1.testclient/token");
    expect(del[0]!.auth).toBe(`Basic ${btoa("Iv1.testclient:test-client-secret")}`);
    expect(del[0]!.body).toEqual({ access_token: token });
    expect(h.gh.tokens.has(token!)).toBe(false);
    expect(await rows("SELECT * FROM sessions")).toHaveLength(0);
  });

  test("a failing or unreachable GitHub does not stop the sign-out", async () => {
    let cookie = await h.signIn(alice);
    h.gh.revokeStatus = 500;
    expect((await post(cookie)).status).toBe(303);
    expect(await rows("SELECT * FROM sessions")).toHaveLength(0);
    cookie = await h.signIn(alice);
    h.gh.down = true;
    const res = await post(cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${SESSION}=;[^,]*Max-Age=0`));
    expect(await rows("SELECT * FROM sessions")).toHaveLength(0);
  });

  test("signing out when already signed out calls nothing", async () => {
    await post(`${SESSION}=${"A".repeat(43)}`);
    expect(h.gh.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });
});

describe("visibility cron", () => {
  test("is its own trigger and, with no App configured, asks GitHub unauthenticated", async () => {
    const r = await sweep();
    expect(r.checked).toBe(2);
    const calls = visCalls();
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.auth).toBeNull();
    expect(calls.map((c) => c.url).sort()).toEqual([`https://api.github.com/repositories/${PUB_ID}`, `https://api.github.com/repositories/${PRIV_ID}`]);
  });

  test("public turned private: hidden from then on, anonymous gets the unknown-repo 404 everywhere", async () => {
    h.gh.repos.set(PUB_ID, { visibility: "private" });
    h.clock.t += 31 * 60_000;
    const r = await sweep();
    expect(r.changed).toBe(1);
    expect((await repoRow(PUB_ID)).visibility).toBe("private");
    expect((await repoRow(PUB_ID)).vis_checked_at).toBe(h.clock.t);
    for (const p of pagesOf(demo)) expect(`${p} ${(await h.view(p)).status}`).toBe(`${p} 404`);
    expect((await h.view("/badge/ProtoDurian/demo/unit.svg")).text).toContain("unknown");
    expect((await h.view("/")).text).not.toContain("ProtoDurian/demo");
  });

  test("private turned public becomes visible; internal stays closed", async () => {
    h.gh.repos.set(PRIV_ID, { visibility: "public" });
    await sweep();
    expect((await h.view(secret)).status).toBe(200);
    h.gh.repos.set(PRIV_ID, { visibility: "internal" });
    await sweep();
    expect((await h.view(secret)).status).toBe(404);
  });

  test("a rename is followed: the new name works, the old one is gone", async () => {
    h.gh.repos.set(PUB_ID, { visibility: "public", full_name: "ProtoDurian/demo-renamed" });
    await sweep();
    const row = await repoRow(PUB_ID);
    expect([row.owner, row.name, row.visibility]).toEqual(["ProtoDurian", "demo-renamed", "public"]);
    expect((await h.view("/ProtoDurian/demo-renamed")).status).toBe(200);
    expect((await h.view(demo)).status).toBe(404);
  });

  test("404 fails closed: the repo is marked private", async () => {
    for (const status of [404]) {
      await h.env.DB.prepare(`UPDATE repos SET visibility = 'public' WHERE repo_id = ?1`).bind(PUB_ID).run();
      h.gh.repos.set(PUB_ID, { status });
      await sweep();
      expect(`${status} ${(await repoRow(PUB_ID)).visibility}`).toBe(`${status} private`);
    }
  });

  test("other errors (bad app credentials 401, 5xx, rate limit, network) leave the repo as it was", async () => {
    const before = await repoRow(PUB_ID);
    h.clock.t += 31 * 60_000;
    for (const status of [500, 502, 403, 429, 401]) {
      h.gh.repos.set(PUB_ID, { status });
      await sweep();
    }
    h.gh.repos.delete(PUB_ID);
    h.gh.down = true;
    const r = await sweep();
    expect(r.changed).toBe(0);
    const after = await repoRow(PUB_ID);
    expect([after.visibility, after.vis_checked_at]).toEqual([before.visibility, before.vis_checked_at]);
  });

  test("checks the repos confirmed longest ago first", async () => {
    await h.env.DB.prepare(`UPDATE repos SET vis_checked_at = 5 WHERE repo_id = ?1`).bind(PRIV_ID).run();
    const { VIS_BATCH } = await import("../src/visibility");
    expect(VIS_BATCH).toBeGreaterThanOrEqual(2);
    await sweep();
    expect(visCalls()[0]!.url).toContain(`/repositories/${PRIV_ID}`);
  });

  test("a CI upload (GitHub's own token) counts as a fresh confirmation", async () => {
    await h.env.DB.prepare(`UPDATE repos SET vis_checked_at = 0`).run();
    await finishN(h, 3);
    expect((await repoRow(PUB_ID)).vis_checked_at).toBe(h.clock.t);
  });
});

describe("a stale public mark is re-checked before serving", () => {
  test("within 6 h nothing is asked; after 6 h one call, then cached", async () => {
    h.clock.t += VIS_FRESH_MS - 1000;
    for (const p of pagesOf(demo)) await h.view(p);
    expect(visCalls()).toHaveLength(0);
    h.clock.t += 2000;
    expect((await h.view(demo)).status).toBe(200);
    expect(visCalls()).toHaveLength(1);
    for (const p of pagesOf(demo)) await h.view(p);
    expect(visCalls()).toHaveLength(1);
  });

  test("if it turned private meanwhile, every route is the unknown-repo 404 and the row is updated", async () => {
    h.clock.t += 7 * HOUR;
    h.gh.repos.set(PUB_ID, { visibility: "private" });
    for (const p of pagesOf(demo)) expect(`${p} ${(await h.view(p)).status}`).toBe(`${p} 404`);
    expect((await repoRow(PUB_ID)).visibility).toBe("private");
  });

  test("a signed-in user who GitHub lets in still sees it, a stranger does not", async () => {
    h.clock.t += 7 * HOUR;
    h.gh.repos.set(PUB_ID, { visibility: "private" });
    const ok = await h.signIn(alice, [PUB_ID]);
    const no = await h.signIn({ id: 43, login: "bob" }, []);
    expect((await h.view(demo, { cookie: ok })).status).toBe(200);
    expect((await h.view(demo, { cookie: no })).status).toBe(404);
  });

  test("when GitHub cannot confirm it, the repo is not served anonymously (try again), and nothing is stored", async () => {
    h.clock.t += 7 * HOUR;
    const before = await repoRow(PUB_ID);
    for (const set of [() => h.gh.repos.set(PUB_ID, { status: 502 }), () => h.gh.repos.set(PUB_ID, { status: 403 }), () => ((h.gh.down = true), h.gh.repos.delete(PUB_ID))]) {
      set();
      const r = await h.view(demo);
      expect(r.status).toBe(503);
      expect(r.text).toContain("try again");
    }
    expect((await repoRow(PUB_ID)).vis_checked_at).toBe(before.vis_checked_at);
    h.gh.down = false;
    h.gh.repos.delete(PUB_ID);
    expect((await h.view(demo)).status).toBe(200);
  });

  test("the home page hides a stale public repo that turned private", async () => {
    h.clock.t += 7 * HOUR;
    h.gh.repos.set(PUB_ID, { visibility: "private" });
    expect((await h.view("/")).text).not.toContain("ProtoDurian/demo");
  });

});

describe("the gated repo is looked up once", () => {
  test("every viewer route reads the repos table a single time", async () => {
    const real = h.env.DB.prepare.bind(h.env.DB);
    let lookups = 0;
    (h.env.DB as any).prepare = (sql: string) => {
      if (/FROM repos WHERE owner/.test(sql)) lookups++;
      return real(sql);
    };
    for (const p of pagesOf(demo)) {
      lookups = 0;
      await h.view(p);
      expect(`${p} ${lookups}`).toBe(`${p} 1`);
    }
  });
});
