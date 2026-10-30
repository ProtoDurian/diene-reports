import { beforeEach, describe, expect, test } from "bun:test";
import { CRON_VISIBILITY, runCron } from "../src/cron";
import { HOUR, MINUTE } from "../src/env";
import { NO_INSTALL_RETRY_MS, TOKEN_SKEW_MS, appJwt, pemToPkcs8, pkcs1ToPkcs8 } from "../src/githubapp";
import { VIS_FRESH_MS, checkRepoVisibility } from "../src/visibility";
import { finishN, makeHarness, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
  await finishN(h, 1); // ProtoDurian/demo, public, id 1001
  await finishN(h, 2, {}, { repository: "ProtoDurian/secret-svc", repository_id: "1002", repository_visibility: "private" });
});

const PUB_ID = 1001;
const PRIV_ID = 1002;
const ORG_INSTALL = 777;
const rows = async (sql: string) => (await h.env.DB.prepare(sql).all<any>()).results;
const repoRow = async (id: number) => (await rows(`SELECT * FROM repos WHERE repo_id = ${id}`))[0];
const sweep = () => runCron(h.env, CRON_VISIBILITY, h.clock.t, h.gh.fetch) as Promise<{ checked: number; changed: number; skipped: number }>;
const count = (match: string, method = "GET") => h.gh.calls.filter((c) => c.method === method && c.url.includes(match)).length;
const repoCalls = () => h.gh.calls.filter((c) => c.url.includes("/repositories/") && !c.auth?.startsWith("Bearer ghu_"));
const deps = () => ({ fetch: h.gh.fetch, now: () => h.clock.t });
const check = async (id: number) => checkRepoVisibility(h.env, deps(), (await repoRow(id)) as any);
const pad = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4);
const b64uDecode = (s: string) => Uint8Array.from(atob(pad(s.replace(/-/g, "+").replace(/_/g, "/"))), (c) => c.charCodeAt(0));

describe("PEM handling", () => {
  test("PKCS#1 (what GitHub hands out) is wrapped into exactly the PKCS#8 WebCrypto exports", async () => {
    const k = await h.enableApp({});
    expect(Buffer.from(pkcs1ToPkcs8(k.pkcs1)).equals(Buffer.from(k.pkcs8))).toBe(true);
  });

  test("both PEM labels import; anything else is refused", async () => {
    const k = await h.enableApp({}, "pkcs1");
    const pem = (label: string, der: Uint8Array) => `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64")}\n-----END ${label}-----`;
    expect(Buffer.from(pemToPkcs8(pem("RSA PRIVATE KEY", k.pkcs1))).equals(Buffer.from(k.pkcs8))).toBe(true);
    expect(Buffer.from(pemToPkcs8(pem("PRIVATE KEY", k.pkcs8))).equals(Buffer.from(k.pkcs8))).toBe(true);
    expect(() => pemToPkcs8(pem("EC PRIVATE KEY", k.pkcs8))).toThrow();
    expect(() => pemToPkcs8("not a pem")).toThrow();
  });
});

describe("app JWT", () => {
  for (const format of ["pkcs1", "pkcs8"] as const) {
    test(`${format} key: RS256, iss = app id, iat 60 s back, exp 9 min ahead, signature verifies`, async () => {
      const k = await h.enableApp({}, format);
      const jwt = await appJwt(h.env, h.clock.t);
      const [head, claims, sig] = jwt.split(".") as [string, string, string];
      expect(JSON.parse(new TextDecoder().decode(b64uDecode(head)))).toEqual({ alg: "RS256", typ: "JWT" });
      const c = JSON.parse(new TextDecoder().decode(b64uDecode(claims)));
      const nowS = Math.floor(h.clock.t / 1000);
      expect(c).toEqual({ iss: "5545592", iat: nowS - 60, exp: nowS + 540 });
      expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k.publicKey, b64uDecode(sig), new TextEncoder().encode(`${head}.${claims}`))).toBe(true);
      // a different key does not verify it
      const other = await h.enableApp({});
      expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", other.publicKey, b64uDecode(sig), new TextEncoder().encode(`${head}.${claims}`))).toBe(false);
    });
  }

  test("a PEM that is not base64-wrapped is accepted too", async () => {
    await h.enableApp({});
    h.env.GITHUB_APP_PRIVATE_KEY_B64 = atob(h.env.GITHUB_APP_PRIVATE_KEY_B64);
    expect((await appJwt(h.env, h.clock.t)).split(".")).toHaveLength(3);
  });
});

describe("visibility checked as the App installation", () => {
  test("JWT -> /orgs/{owner}/installation -> access token -> GET /repositories/{id} with that token (never Basic)", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    const r = await sweep();
    expect(r).toEqual({ checked: 2, changed: 0, skipped: 0 });
    expect(count("/orgs/ProtoDurian/installation")).toBe(1);
    expect(count(`/app/installations/${ORG_INSTALL}/access_tokens`, "POST")).toBe(1);
    const calls = repoCalls();
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.auth).toMatch(/^Bearer ghs_install/);
    expect(h.gh.calls.some((c) => c.auth?.startsWith("Basic "))).toBe(false);
    // every JWT the fake saw verified and carried the app id
    expect(h.gh.app.jwts.length).toBeGreaterThanOrEqual(2);
    for (const j of h.gh.app.jwts) expect(j.iss).toBe("5545592");
  });

  test("the installation sees the owner's private repos: a repo that went private is stored as private (200 + visibility)", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    h.gh.repos.set(PUB_ID, { visibility: "private" });
    expect(await check(PUB_ID)).toBe("private");
    expect((await repoRow(PUB_ID)).visibility).toBe("private");
    h.gh.repos.set(PRIV_ID, { visibility: "internal" });
    expect(await check(PRIV_ID)).toBe("internal");
  });

  test("a rename comes back in full_name and is stored", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    h.gh.repos.set(PUB_ID, { visibility: "public", full_name: "ProtoDurian/demo-2" });
    await check(PUB_ID);
    const row = await repoRow(PUB_ID);
    expect([row.owner, row.name]).toEqual(["ProtoDurian", "demo-2"]);
  });

  test("404 fails closed: the repo becomes private", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    h.gh.repos.set(PUB_ID, { status: 404 });
    expect(await check(PUB_ID)).toBe("private");
    expect((await repoRow(PUB_ID)).visibility).toBe("private");
  });

  test("401, 403, 429, 5xx and network errors return null and store nothing", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    const before = await repoRow(PUB_ID);
    for (const status of [401, 403, 429, 500, 503]) {
      h.gh.repos.set(PUB_ID, { status });
      expect(`${status} ${await check(PUB_ID)}`).toBe(`${status} null`);
    }
    h.gh.repos.delete(PUB_ID);
    h.gh.down = true;
    expect(await check(PUB_ID)).toBeNull();
    expect(await repoRow(PUB_ID)).toEqual(before);
  });

  test("a 401 drops the cached token so the next check mints a new one", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    await check(PUB_ID);
    expect(count("/access_tokens", "POST")).toBe(1);
    h.gh.repos.set(PUB_ID, { status: 401 });
    await check(PUB_ID);
    h.gh.repos.delete(PUB_ID);
    await check(PUB_ID);
    expect(count("/access_tokens", "POST")).toBe(2);
  });

  test("the stale-repo check in the viewer uses the installation too, and fails closed", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    h.clock.t += VIS_FRESH_MS + 1000;
    h.gh.repos.set(PUB_ID, { visibility: "private" });
    expect((await h.view("/ProtoDurian/demo")).status).toBe(404);
    expect(repoCalls()[0]!.auth).toMatch(/^Bearer ghs_install/);
    h.gh.repos.set(PRIV_ID, { status: 502 });
    h.clock.t += VIS_FRESH_MS + 1000;
    await h.env.DB.prepare(`UPDATE repos SET visibility = 'public' WHERE repo_id = ?1`).bind(PRIV_ID).run();
    expect((await h.view("/ProtoDurian/secret-svc")).status).toBe(503);
  });
});

describe("installation lookup", () => {
  test("is cached in D1 per owner: two repos of one owner, two sweeps, one lookup", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    await sweep();
    await sweep();
    expect(count("/installation")).toBe(1);
    expect(await rows(`SELECT owner, installation_id FROM app_installations`)).toEqual([{ owner: "ProtoDurian", installation_id: ORG_INSTALL }]);
  });

  test("the owner match is case-insensitive", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    await check(PUB_ID);
    await h.env.DB.prepare(`UPDATE repos SET owner = 'protodurian' WHERE repo_id = ?1`).bind(PUB_ID).run();
    await check(PUB_ID);
    expect(count("/installation")).toBe(1);
  });

  test("a personal account falls back from /orgs/{owner} to /users/{owner}", async () => {
    await h.enableApp({ ProtoDurian: { id: 55, type: "User" } });
    await check(PUB_ID);
    expect(count("/orgs/ProtoDurian/installation")).toBe(1);
    expect(count("/users/ProtoDurian/installation")).toBe(1);
    expect(repoCalls()[0]!.auth).toMatch(/^Bearer ghs_install/);
  });

  test("an owner without the App installed is checked unauthenticated; 'not installed' is remembered for an hour", async () => {
    await h.enableApp({});
    await sweep();
    expect(repoCalls().every((c) => c.auth === null)).toBe(true);
    expect(await rows(`SELECT installation_id FROM app_installations`)).toEqual([{ installation_id: null }]);
    expect(count("/orgs/ProtoDurian/installation")).toBe(1);
    h.clock.t += NO_INSTALL_RETRY_MS - 1000;
    await sweep();
    expect(count("/orgs/ProtoDurian/installation")).toBe(1);
    h.clock.t += 2000;
    h.gh.app.installs.set("protodurian", { id: ORG_INSTALL, type: "Organization" }); // installed meanwhile
    await sweep();
    expect(count("/orgs/ProtoDurian/installation")).toBe(2);
    expect(repoCalls().at(-1)!.auth).toMatch(/^Bearer ghs_install/);
  });

  test("an uninstalled App (token mint says 404) is forgotten and looked up again", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    await check(PUB_ID);
    h.gh.app.installs.clear(); // uninstalled
    h.clock.t += 2 * HOUR; // the cached token has expired
    expect(await check(PUB_ID)).toBe("public"); // unauthenticated, public repo
    expect(await rows(`SELECT installation_id FROM app_installations`)).toEqual([{ installation_id: null }]);
    expect(repoCalls().at(-1)!.auth).toBeNull();
  });

  test("a failed lookup (5xx) is not cached and does NOT fall back to unauthenticated calls", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    h.gh.app.lookupStatus = 500;
    expect(await check(PUB_ID)).toBeNull();
    expect(repoCalls()).toHaveLength(0);
    expect(await rows(`SELECT * FROM app_installations`)).toHaveLength(0);
    h.gh.app.lookupStatus = null;
    expect(await check(PUB_ID)).toBe("public");
  });

  test("a rejected JWT (GitHub knows a different key) is an error, not 'not installed'", async () => {
    const known = await h.enableApp({ ProtoDurian: ORG_INSTALL });
    await h.enableApp({ ProtoDurian: ORG_INSTALL }); // env now holds a second key...
    h.gh.app.publicKey = known.publicKey; // ...but GitHub only knows the first
    expect(await check(PUB_ID)).toBeNull();
    expect(await rows(`SELECT * FROM app_installations`)).toHaveLength(0);
    expect(repoCalls()).toHaveLength(0);
  });

  test("a garbage private key is an error, never a crash", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    h.env.GITHUB_APP_PRIVATE_KEY_B64 = btoa("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----");
    expect(await check(PUB_ID)).toBeNull();
    expect(repoCalls()).toHaveLength(0);
  });
});

describe("installation token cache", () => {
  test("one token serves many checks, and many concurrent ones share a single mint", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    await Promise.all([check(PUB_ID), check(PRIV_ID), check(PUB_ID), check(PRIV_ID)]);
    for (let i = 0; i < 3; i++) await check(PUB_ID);
    expect(count("/access_tokens", "POST")).toBe(1);
    expect(count("/installation")).toBe(1);
  });

  test("renewed 5 minutes before it expires, not earlier", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL }); // tokens live 1 h
    await check(PUB_ID);
    h.clock.t += HOUR - TOKEN_SKEW_MS - 1000;
    await check(PUB_ID);
    expect(count("/access_tokens", "POST")).toBe(1);
    h.clock.t += 2000;
    await check(PUB_ID);
    expect(count("/access_tokens", "POST")).toBe(2);
    expect(new Set(repoCalls().map((c) => c.auth)).size).toBe(2);
  });

  test("a failed mint returns null and is retried by the next check", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    h.gh.app.mintStatus = 500;
    expect(await check(PUB_ID)).toBeNull();
    expect(repoCalls()).toHaveLength(0);
    h.gh.app.mintStatus = null;
    expect(await check(PUB_ID)).toBe("public");
  });

  test("the app JWT is minted fresh for each request, never reused past its life", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    await check(PUB_ID);
    h.clock.t += 2 * HOUR;
    await check(PUB_ID);
    const exps = h.gh.app.jwts.map((j) => j.exp as number);
    expect(exps.at(-1)!).toBeGreaterThan(exps[0]!);
  });
});

describe("no App configured: unauthenticated fallback", () => {
  test("200 stores the visibility, 404 means private", async () => {
    expect(await check(PUB_ID)).toBe("public");
    expect(repoCalls().every((c) => c.auth === null)).toBe(true);
    h.gh.repos.set(PUB_ID, { visibility: "private" }); // unauthenticated callers cannot read it
    expect(await check(PUB_ID)).toBe("private");
    expect(count("/installation")).toBe(0);
  });

  test("a half-configured App (id but no key, or key but no id) counts as not configured", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    for (const [id, key] of [["", h.env.GITHUB_APP_PRIVATE_KEY_B64], ["5545592", ""], ["TBD", h.env.GITHUB_APP_PRIVATE_KEY_B64]] as const) {
      h.env.GITHUB_APP_ID = id;
      h.env.GITHUB_APP_PRIVATE_KEY_B64 = key;
      await check(PUB_ID);
    }
    expect(count("/installation")).toBe(0);
    expect(repoCalls().every((c) => c.auth === null)).toBe(true);
  });

  test("403 / 429 (the shared-IP rate limit), 5xx and network errors return null and change nothing", async () => {
    h.gh.unauthLeft = 0;
    const before = await repoRow(PUB_ID);
    expect(await check(PUB_ID)).toBeNull();
    h.gh.unauthLeft = null;
    for (const status of [403, 429, 500]) {
      h.gh.repos.set(PUB_ID, { status });
      expect(`${status} ${await check(PUB_ID)}`).toBe(`${status} null`);
    }
    h.gh.repos.delete(PUB_ID);
    h.gh.down = true;
    expect(await check(PUB_ID)).toBeNull();
    expect(await repoRow(PUB_ID)).toEqual(before);
  });

  test("rate limited while the cron runs: the sweep skips instead of flipping anything", async () => {
    h.gh.unauthLeft = 1;
    h.clock.t += 31 * MINUTE;
    const r = await sweep();
    expect(r.checked + r.skipped).toBe(2);
    expect(r.skipped).toBe(1);
    expect((await repoRow(PUB_ID)).visibility).toBe("public");
  });
});

describe("Basic auth is only left for revoking a token", () => {
  test("no visibility call carries client id + secret", async () => {
    await h.enableApp({ ProtoDurian: ORG_INSTALL });
    await sweep();
    await h.view("/ProtoDurian/demo");
    expect(h.gh.calls.filter((c) => c.auth?.startsWith("Basic "))).toHaveLength(0);
  });
});
