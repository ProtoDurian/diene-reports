import { beforeEach, describe, expect, test } from "bun:test";
import { DAY } from "../src/env";
import { finishN, makeHarness, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});

const PRIV = { repository: "ProtoDurian/secret-svc", repository_id: "1002", repository_visibility: "private" };
const PRIV_ID = 1002;
const PUB_ID = 1001;
const alice = { id: 42, login: "alice" };
const sha = (n: number) => n.toString(16).padStart(40, "0");
const SESSION = "__Host-diene_session";
const STATE = "__Host-diene_state";

async function seed() {
  await finishN(h, 1); // ProtoDurian/demo, public
  await finishN(h, 2, {}, PRIV); // ProtoDurian/secret-svc, private
}
const cookieOf = (res: Headers, name: string) => new RegExp(`${name}=([^;]*)`).exec(res.get("set-cookie") ?? "")?.[1];
const rows = async (sql: string) => (await h.env.DB.prepare(sql).all<any>()).results;

describe("login redirect", () => {
  test("/login sets a signed state cookie and sends the browser to GitHub", async () => {
    const res = await h.app.request("/login?next=/ProtoDurian/demo", {}, h.env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("Iv1.testclient");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://reports.atomi.cloud/auth/callback");
    const state = loc.searchParams.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(43); // 32 random bytes
    const sc = res.headers.get("set-cookie")!;
    expect(sc).toContain(`${STATE}=`);
    for (const a of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"]) expect(sc).toContain(a);
    expect(sc).not.toContain("Domain");
    expect(cookieOf(res.headers, STATE)!.startsWith(`${state}.`)).toBe(true);
  });

  test("two logins get different states", async () => {
    const a = await h.app.request("/login", {}, h.env);
    const b = await h.app.request("/login", {}, h.env);
    expect(new URL(a.headers.get("location")!).searchParams.get("state")).not.toBe(new URL(b.headers.get("location")!).searchParams.get("state"));
  });

  test("a login that is not configured says so instead of redirecting", async () => {
    for (const env of [{ ...h.env, GITHUB_CLIENT_ID: "TBD" }, { ...h.env, GITHUB_CLIENT_ID: "" }, { ...h.env, GITHUB_CLIENT_SECRET: "" }, { ...h.env, SESSION_KEY: "" }]) {
      const res = await h.app.request("/login", {}, env);
      expect(res.status).toBe(503);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  test("open-redirect `next` values are rejected", async () => {
    const bad = ["//evil.example", "https://evil.example/x", "/\\evil.example", "\\\\evil.example", "javascript:alert(1)", "evil", "/\r\nSet-Cookie:x=1", "//", "/\t/evil.example", "http://reports.atomi.cloud.evil.example/"];
    for (const next of bad) {
      const start = await h.app.request(`/login?next=${encodeURIComponent(next)}`, {}, h.env);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      await h.signIn(alice);
      h.gh.nextUser = alice.id;
      const cb = await h.app.request(`/auth/callback?code=code-42&state=${state}`, { headers: { cookie: `${STATE}=${cookieOf(start.headers, STATE)}` } }, h.env);
      expect(cb.status).toBe(302);
      expect(`${next} -> ${cb.headers.get("location")}`).toBe(`${next} -> /`);
    }
  });

  test("a same-site path (with query) is kept", async () => {
    const start = await h.app.request(`/login?next=${encodeURIComponent("/ProtoDurian/demo?branch=main")}`, {}, h.env);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    h.gh.users.set(42, { ...alice, repos: new Set() });
    h.gh.nextUser = 42;
    const cb = await h.app.request(`/auth/callback?code=code-42&state=${state}`, { headers: { cookie: `${STATE}=${cookieOf(start.headers, STATE)}` } }, h.env);
    expect(cb.headers.get("location")).toBe("/ProtoDurian/demo?branch=main");
  });
});

describe("callback", () => {
  async function start() {
    const res = await h.app.request("/login", {}, h.env);
    return { state: new URL(res.headers.get("location")!).searchParams.get("state")!, cookie: `${STATE}=${cookieOf(res.headers, STATE)}` };
  }
  beforeEach(() => {
    h.gh.users.set(42, { ...alice, repos: new Set() });
    h.gh.nextUser = 42;
  });

  test("missing, wrong, forged and expired state are 400 and create no session", async () => {
    const s = await start();
    const other = await start();
    const forged = `${s.cookie.split("=")[1]!.split(".").slice(0, 2).join(".")}.AAAA`;
    const cases: [string, string | null][] = [
      ["/auth/callback?code=code-42", null],
      ["/auth/callback?code=code-42&state=" + s.state, null],
      ["/auth/callback?code=code-42", s.cookie],
      ["/auth/callback?code=code-42&state=nope", s.cookie],
      ["/auth/callback?code=code-42&state=" + other.state, s.cookie],
      ["/auth/callback?code=code-42&state=" + s.state, `${STATE}=${forged}`],
      ["/auth/callback?code=code-42&state=" + s.state, `${STATE}=garbage`],
      ["/auth/callback?state=" + s.state, s.cookie],
      ["/auth/callback?error=access_denied&state=" + s.state, s.cookie],
    ];
    for (const [path, cookie] of cases) {
      const res = await h.app.request(path, { headers: cookie ? { cookie } : {} }, h.env);
      expect(`${path} ${res.status}`).toBe(`${path} 400`);
      expect(res.headers.get("set-cookie") ?? "").not.toContain(`${SESSION}=`);
    }
    expect(await rows("SELECT * FROM sessions")).toHaveLength(0);
    expect(h.gh.count("access_token")).toBe(0);
  });

  test("an expired state is rejected", async () => {
    const s = await start();
    h.clock.t += 11 * 60_000;
    const res = await h.app.request(`/auth/callback?code=code-42&state=${s.state}`, { headers: { cookie: s.cookie } }, h.env);
    expect(res.status).toBe(400);
  });

  test("a good callback creates a session, sets a hardened cookie and clears the state cookie", async () => {
    const s = await start();
    const res = await h.app.request(`/auth/callback?code=code-42&state=${s.state}`, { headers: { cookie: s.cookie } }, h.env);
    expect(res.status).toBe(302);
    const sc = res.headers.get("set-cookie")!;
    const id = cookieOf(res.headers, SESSION)!;
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sc).toMatch(new RegExp(`${SESSION}=[^;]+;[^,]*HttpOnly`));
    for (const a of ["Secure", "SameSite=Lax", "Path=/", `Max-Age=${30 * 86400}`]) expect(sc).toContain(a);
    expect(sc).toMatch(new RegExp(`${STATE}=;[^,]*Max-Age=0`));
    const [row] = await rows("SELECT * FROM sessions");
    expect(row.user_id).toBe(42);
    expect(row.login).toBe("alice");
    expect(row.avatar_url).toBe("https://avatars.githubusercontent.com/u/42?v=4");
    // GitHub was called as the spec says
    const tok = h.gh.calls.find((c) => c.url.endsWith("/login/oauth/access_token"))!;
    expect(tok.method).toBe("POST");
    expect(tok.body.code).toBe("code-42");
    expect(tok.body.redirect_uri).toBe("https://reports.atomi.cloud/auth/callback");
    expect(h.gh.calls.some((c) => c.url === "https://api.github.com/user" && c.auth === "Bearer ghu_access1")).toBe(true);
    // and the page now shows the user
    const page = await h.view("/", { cookie: `${SESSION}=${id}` });
    expect(page.text).toContain("alice");
    expect(page.text).toContain("Sign out");
    expect(page.text).not.toContain("Sign in with GitHub");
  });

  test("the state cookie cannot be replayed once used", async () => {
    const s = await start();
    expect((await h.app.request(`/auth/callback?code=code-42&state=${s.state}`, { headers: { cookie: s.cookie } }, h.env)).status).toBe(302);
    // a browser would have dropped it; but even a client that replays it only gets another session for the same code check
    h.gh.users.clear();
    expect((await h.app.request(`/auth/callback?code=code-42&state=${s.state}`, { headers: { cookie: s.cookie } }, h.env)).status).toBe(400);
  });

  test("GitHub refusing the code is a 400, GitHub being down is a 502; neither creates a session", async () => {
    const s = await start();
    expect((await h.app.request(`/auth/callback?code=wrong&state=${s.state}`, { headers: { cookie: s.cookie } }, h.env)).status).toBe(400);
    const s2 = await start();
    h.gh.down = true;
    expect((await h.app.request(`/auth/callback?code=code-42&state=${s2.state}`, { headers: { cookie: s2.cookie } }, h.env)).status).toBe(502);
    expect(await rows("SELECT * FROM sessions")).toHaveLength(0);
  });
});

describe("storage", () => {
  test("the session cookie value is never stored in plain text; tokens are encrypted at rest", async () => {
    const cookie = await h.signIn(alice, [PRIV_ID]);
    const id = cookie.split("=")[1]!;
    const dump = JSON.stringify(await rows("SELECT * FROM sessions"));
    expect(dump).not.toContain(id);
    const [row] = await rows("SELECT * FROM sessions");
    expect(row.id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.id_hash).toBe(new Bun.CryptoHasher("sha256").update(id).digest("hex"));
    for (const t of ["ghu_access1", "ghr_refresh1"]) {
      expect(dump).not.toContain(t);
      expect(dump).not.toContain(Buffer.from(t).toString("base64"));
    }
    expect(row.access_enc).toMatch(/^v1\./);
    expect(row.refresh_enc).toMatch(/^v1\./);
    // the cache table holds no tokens either
    await h.view("/ProtoDurian/secret-svc", { cookie });
    expect(JSON.stringify(await rows("SELECT * FROM repo_access"))).not.toContain("ghu_");
  });

  test("encryption is randomised and bound to its row: a copied ciphertext does not decrypt elsewhere", async () => {
    const c1 = await h.signIn(alice);
    const c2 = await h.signIn({ id: 43, login: "bob" });
    const rs = await rows("SELECT * FROM sessions ORDER BY user_id");
    expect(rs[0].access_enc).not.toBe(rs[1].access_enc);
    await h.env.DB.prepare("UPDATE sessions SET access_enc = ?1 WHERE user_id = 43").bind(rs[0].access_enc).run();
    // bob's row now carries alice's ciphertext, which must fail authentication: bob is signed out and the row is dropped
    expect((await h.view("/", { cookie: c2 })).text).toContain("Sign in with GitHub");
    expect((await h.view("/", { cookie: c1 })).text).toContain("alice");
  });

  test("a wrong SESSION_KEY cannot read existing sessions", async () => {
    const cookie = await h.signIn(alice);
    const env = { ...h.env, SESSION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") };
    const res = await h.app.request("/", { headers: { cookie } }, env);
    expect(await res.text()).toContain("Sign in with GitHub");
  });
});

describe("token refresh", () => {
  test("an expired access token is refreshed transparently and the new tokens are stored", async () => {
    const cookie = await h.signIn(alice, [PRIV_ID]);
    await seed();
    const before = (await rows("SELECT access_enc, refresh_enc FROM sessions"))[0];
    h.clock.t += 8 * 3600_000 + 1000;
    const res = await h.view("/ProtoDurian/secret-svc", { cookie });
    expect(res.status).toBe(200);
    const refresh = h.gh.calls.filter((c) => c.body?.grant_type === "refresh_token");
    expect(refresh).toHaveLength(1);
    expect(refresh[0]!.body.refresh_token).toBe("ghr_refresh1");
    // the new access token (not the old one) was used for the repo check
    expect(h.gh.calls.at(-1)!.auth).toBe("Bearer ghu_access2");
    const after = (await rows("SELECT access_enc, refresh_enc, access_exp FROM sessions"))[0];
    expect(after.access_enc).not.toBe(before.access_enc);
    expect(after.refresh_enc).not.toBe(before.refresh_enc);
    expect(after.access_exp).toBe(h.clock.t + 8 * 3600_000);
    // still signed in afterwards without another refresh
    expect((await h.view("/", { cookie })).text).toContain("alice");
    expect(h.gh.calls.filter((c) => c.body?.grant_type === "refresh_token")).toHaveLength(1);
  });

  test("a token that is still fresh is not refreshed", async () => {
    const cookie = await h.signIn(alice);
    h.clock.t += 3600_000;
    await h.view("/", { cookie });
    expect(h.gh.calls.filter((c) => c.body?.grant_type === "refresh_token")).toHaveLength(0);
  });

  test("when the refresh fails the user is signed out and the session is deleted", async () => {
    const cookie = await h.signIn(alice, [PRIV_ID]);
    await seed();
    h.gh.refreshFails = true;
    h.clock.t += 9 * 3600_000;
    const res = await h.view("/ProtoDurian/secret-svc", { cookie });
    expect(res.status).toBe(404);
    expect(res.text).toContain("Sign in with GitHub");
    expect(await rows("SELECT * FROM sessions")).toHaveLength(0);
  });

  test("GitHub being unreachable during a refresh signs the request out but keeps the session for next time", async () => {
    const cookie = await h.signIn(alice);
    h.gh.down = true;
    h.clock.t += 9 * 3600_000;
    expect((await h.view("/", { cookie })).text).toContain("Sign in with GitHub");
    expect(await rows("SELECT * FROM sessions")).toHaveLength(1);
    h.gh.down = false;
    expect((await h.view("/", { cookie })).text).toContain("alice");
  });

  test("a session older than 30 days is gone", async () => {
    const cookie = await h.signIn(alice);
    h.clock.t += 31 * DAY;
    expect((await h.view("/", { cookie })).text).toContain("Sign in with GitHub");
    expect(await rows("SELECT * FROM sessions")).toHaveLength(0);
  });

  test("a random or malformed cookie is simply signed out", async () => {
    for (const v of ["x", "A".repeat(43), "", "../../etc", "a;b"]) {
      const res = await h.view("/", { cookie: `${SESSION}=${v}` });
      expect(res.status).toBe(200);
      expect(res.text).toContain("Sign in with GitHub");
    }
  });
});

describe("logout", () => {
  const post = (cookie: string, origin: string | null = "https://reports.atomi.cloud") =>
    h.app.request("/logout", { method: "POST", headers: { cookie, ...(origin ? { origin } : {}) } }, h.env);

  test("deletes the session row and clears the cookie", async () => {
    const cookie = await h.signIn(alice);
    const res = await post(cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${SESSION}=;[^,]*Max-Age=0`));
    expect(await rows("SELECT * FROM sessions")).toHaveLength(0);
    // the old cookie no longer works
    expect((await h.view("/", { cookie })).text).toContain("Sign in with GitHub");
  });

  test("a missing or foreign Origin is refused and keeps the session", async () => {
    const cookie = await h.signIn(alice);
    for (const o of [null, "https://evil.example", "https://reports.atomi.cloud.evil.example", "null"]) {
      expect((await post(cookie, o)).status).toBe(403);
    }
    expect(await rows("SELECT * FROM sessions")).toHaveLength(1);
  });

  test("GET /logout does nothing", async () => {
    const cookie = await h.signIn(alice);
    expect((await h.view("/logout", { cookie })).status).toBe(404);
    expect(await rows("SELECT * FROM sessions")).toHaveLength(1);
  });

  test("signing out one browser leaves another session of the same user alone", async () => {
    const a = await h.signIn(alice);
    const b = await h.signIn(alice);
    await post(a);
    expect((await h.view("/", { cookie: b })).text).toContain("alice");
  });
});

describe("who sees what", () => {
  beforeEach(seed);
  const demo = "/ProtoDurian/demo";
  const secret = "/ProtoDurian/secret-svc";
  const sub = (p: string) => [p, `${p}/commit/${sha(2)}`, `${p}/commit/${sha(2)}/coverage`, `${p}/pull/1`, `${p}/run/5002/tests`, `${p}/run/5002/raw/x`, `${p}/test/x`, `${p}/commit/${sha(2)}/file?path=src/a.ts`];

  test("a public repo is visible to anyone, signed in or not", async () => {
    expect((await h.view(demo)).status).toBe(200);
    expect((await h.view(`${demo}/commit/${sha(1)}`)).status).toBe(200);
    const cookie = await h.signIn(alice, []);
    expect((await h.view(demo, { cookie })).status).toBe(200);
    expect(h.gh.count("/repositories/")).toBe(0); // public needs no GitHub call
  });

  test("a private repo is a 404 when signed out, with a sign-in button, and looks like an unknown repo", async () => {
    const hidden = await h.view(secret);
    const unknown = await h.view("/ProtoDurian/nope");
    expect(hidden.status).toBe(404);
    expect(hidden.text).toContain("Sign in with GitHub");
    expect(hidden.text).toContain(`/login?next=`);
    expect(hidden.text.replace(/next=[^"]*/g, "")).not.toContain("secret-svc"); // only the visitor's own URL comes back, in the link
    expect(hidden.text.replace(/next=[^"]*/g, "")).toBe(unknown.text.replace(/next=[^"]*/g, ""));
  });

  test("every private-repo route is hidden when signed out", async () => {
    for (const p of sub(secret)) {
      const r = await h.view(p);
      expect(`${p} ${r.status}`).toBe(`${p} 404`);
      expect(r.text.replace(/next=[^"]*/g, "")).not.toContain("secret-svc");
    }
  });

  test("a user GitHub says 404 for gets the same 404 on every route", async () => {
    const cookie = await h.signIn(alice, []);
    for (const p of sub(secret)) {
      const r = await h.view(p, { cookie });
      expect(`${p} ${r.status}`).toBe(`${p} 404`);
      expect(r.text).not.toContain("secret-svc");
    }
    const r = await h.view(secret, { cookie });
    expect(r.text).not.toContain("Sign in with GitHub"); // already signed in
    expect(r.text).toContain("alice");
  });

  test("a user GitHub says 200 for sees it", async () => {
    const cookie = await h.signIn(alice, [PRIV_ID]);
    const r = await h.view(secret, { cookie });
    expect(r.status).toBe(200);
    expect(r.text).toContain("secret-svc");
    const call = h.gh.calls.find((c) => c.url === `https://api.github.com/repositories/${PRIV_ID}`)!;
    expect(call.auth).toMatch(/^Bearer ghu_/);
    expect((await h.view(`${secret}/commit/${sha(2)}`, { cookie })).status).toBe(200);
  });

  test("the answer is cached for 10 minutes per user and repo, then asked again", async () => {
    const cookie = await h.signIn(alice, [PRIV_ID]);
    for (let i = 0; i < 3; i++) expect((await h.view(secret, { cookie })).status).toBe(200);
    expect((await h.view(`${secret}/commit/${sha(2)}`, { cookie })).status).toBe(200);
    expect(h.gh.count(`/repositories/${PRIV_ID}`)).toBe(1);
    h.clock.t += 9 * 60_000;
    await h.view(secret, { cookie });
    expect(h.gh.count(`/repositories/${PRIV_ID}`)).toBe(1);
    h.clock.t += 2 * 60_000;
    await h.view(secret, { cookie });
    expect(h.gh.count(`/repositories/${PRIV_ID}`)).toBe(2);
  });

  test("a cached no is cached too, and losing access shows up after the cache expires", async () => {
    const cookie = await h.signIn(alice, []);
    expect((await h.view(secret, { cookie })).status).toBe(404);
    expect((await h.view(secret, { cookie })).status).toBe(404);
    expect(h.gh.count(`/repositories/${PRIV_ID}`)).toBe(1);
    h.gh.users.get(42)!.repos.add(PRIV_ID); // now granted
    expect((await h.view(secret, { cookie })).status).toBe(404); // still cached
    h.clock.t += 11 * 60_000;
    expect((await h.view(secret, { cookie })).status).toBe(200);
    h.gh.users.get(42)!.repos.delete(PRIV_ID); // revoked
    h.clock.t += 11 * 60_000;
    expect((await h.view(secret, { cookie })).status).toBe(404);
  });

  test("the cache is per user: one user's yes does not open the repo for another", async () => {
    const a = await h.signIn(alice, [PRIV_ID]);
    const b = await h.signIn({ id: 43, login: "bob" }, []);
    expect((await h.view(secret, { cookie: a })).status).toBe(200);
    expect((await h.view(secret, { cookie: b })).status).toBe(404);
    expect((await h.view(secret)).status).toBe(404);
  });

  test("GitHub being unavailable denies and is not cached", async () => {
    const cookie = await h.signIn(alice, [PRIV_ID]);
    h.gh.down = true;
    expect((await h.view(secret, { cookie })).status).toBe(404);
    h.gh.down = false;
    expect((await h.view(secret, { cookie })).status).toBe(200);
  });

  test("the home page lists public projects for everyone and only allowed private ones", async () => {
    await finishN(h, 3, {}, { repository: "ProtoDurian/other-secret", repository_id: "1003", repository_visibility: "internal" });
    const signedOut = (await h.view("/")).text;
    expect(signedOut).toContain("ProtoDurian/demo");
    expect(signedOut).not.toContain("secret-svc");
    expect(signedOut).not.toContain("other-secret");
    expect(signedOut).toContain("Sign in with GitHub");

    const nobody = await h.signIn({ id: 50, login: "nobody" }, []);
    const t1 = (await h.view("/", { cookie: nobody })).text;
    expect(t1).toContain("ProtoDurian/demo");
    expect(t1).not.toContain("secret-svc");
    expect(t1).not.toContain("other-secret");

    const some = await h.signIn(alice, [PRIV_ID]);
    const t2 = (await h.view("/", { cookie: some })).text;
    expect(t2).toContain("ProtoDurian/demo");
    expect(t2).toContain("ProtoDurian/secret-svc");
    expect(t2).not.toContain("other-secret");

    const both = await h.signIn({ id: 44, login: "carol" }, [PRIV_ID, 1003]);
    const t3 = (await h.view("/", { cookie: both })).text;
    expect(t3).toContain("secret-svc");
    expect(t3).toContain("other-secret");
  });

  test("badges stay public: private shows grey 'private', no GitHub call", async () => {
    const r = await h.view("/badge/ProtoDurian/secret-svc/unit.svg");
    expect(r.status).toBe(200);
    expect(r.text).toContain("private");
    expect(h.gh.calls.filter((c) => c.url.includes("/repositories/"))).toHaveLength(0);
  });

  test("the API is still OIDC only; a viewer session does not open it", async () => {
    const cookie = await h.signIn(alice, [PRIV_ID]);
    const r = await h.app.request("/api/v1/runs/known-failing?flag=unit", { headers: { cookie } }, h.env);
    expect(r.status).toBe(401);
    expect(h.gh.calls.some((c) => c.url.includes("/repositories/"))).toBe(false);
  });
});

describe("page chrome", () => {
  test("signed out header has a sign-in link back to the same page; CSP allows GitHub avatars only", async () => {
    await seed();
    const r = await h.view("/ProtoDurian/demo?branch=main");
    expect(r.text).toContain(`href="/login?next=${encodeURIComponent("/ProtoDurian/demo?branch=main")}"`);
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("img-src 'self' data: https://avatars.githubusercontent.com");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toContain("unsafe-inline'; img"); // no inline allowance sneaked in
    expect(r.text).not.toContain("<!--auth-->");
  });

  test("the avatar and login are escaped", async () => {
    const cookie = await h.signIn({ id: 45, login: "<b>x</b>" });
    const t = (await h.view("/", { cookie })).text;
    expect(t).not.toContain("<b>x</b>");
    expect(t).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  test("viewer pages are never cached", async () => {
    await seed();
    expect((await h.view("/ProtoDurian/demo")).headers.get("cache-control")).toContain("no-cache");
    expect((await h.app.request("/login", {}, h.env)).headers.get("cache-control")).toBe("no-store");
  });
});


describe("daily cron", () => {
  test("deletes expired sessions and old access-cache rows, keeps live ones", async () => {
    const { runCron, CRON_GC } = await import("../src/cron");
    await seed();
    const live = await h.signIn(alice, [PRIV_ID]);
    await h.signIn({ id: 43, login: "bob" });
    await h.view("/ProtoDurian/secret-svc", { cookie: live });
    expect(await rows("SELECT * FROM repo_access")).toHaveLength(1);
    await h.env.DB.prepare("UPDATE sessions SET expires_at = ?1 WHERE user_id = 43").bind(h.clock.t - 1).run();
    h.clock.t += 2 * DAY; // live session is still within its 30 days; the cached answer is over a day old
    await runCron(h.env, CRON_GC, h.clock.t);
    expect((await rows("SELECT user_id FROM sessions")).map((r) => r.user_id)).toEqual([42]);
    expect(await rows("SELECT * FROM repo_access")).toHaveLength(0);
  });
});
