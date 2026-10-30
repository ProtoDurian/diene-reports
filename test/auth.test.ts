import { beforeEach, describe, expect, test } from "bun:test";
import { SHA, baseClaims, makeHarness, makeKeyPair, signJwt, startBody, type Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});

const start = (opts: Parameters<Harness["call"]>[2] = {}) => h.call("POST", "/api/v1/runs/start", { body: startBody(), ...opts });

describe("OIDC", () => {
  test("valid token is accepted", async () => {
    const r = await start();
    expect(r.status).toBe(200);
    expect(r.json.state).toBe("started");
  });

  test("missing / non-bearer authorization -> 401", async () => {
    expect((await start({ token: null })).status).toBe(401);
    expect((await start({ headers: { authorization: "Basic abc" }, token: null })).status).toBe(401);
    expect((await start({ token: "not.a.jwt" })).status).toBe(401);
    expect((await start({ token: "garbage" })).status).toBe(401);
  });

  test("bad signature -> 401 (right kid, wrong private key)", async () => {
    const other = await makeKeyPair("kid-1");
    const tok = await signJwt(other, baseClaims(h.clock.t));
    const r = await start({ token: tok });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("bad signature");
  });

  test("tampered payload -> 401", async () => {
    const tok = await h.token();
    const [a, , c] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ ...baseClaims(h.clock.t), repository_owner_id: "55664364", repository_id: "999" })).toString("base64url");
    expect((await start({ token: `${a}.${forged}.${c}` })).json.error).toBe("bad signature");
  });

  test("alg none / HS256 are rejected", async () => {
    const hdr = Buffer.from(JSON.stringify({ alg: "none", kid: "kid-1" })).toString("base64url");
    const pay = Buffer.from(JSON.stringify(baseClaims(h.clock.t))).toString("base64url");
    expect((await start({ token: `${hdr}.${pay}.` })).json.error).toBe("unsupported alg");
    expect((await start({ token: await h.token({}, h.key, { alg: "HS256" }) })).json.error).toBe("unsupported alg");
  });

  test("wrong audience -> 401; array audience containing it is accepted", async () => {
    const r = await start({ claims: { aud: "someone-else" } });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("bad audience");
    expect((await start({ claims: { aud: ["x", "diene-reports"] } })).status).toBe(200);
  });

  test("wrong issuer -> 401", async () => {
    const r = await start({ claims: { iss: "https://evil.example" } });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("bad issuer");
  });

  test("expired -> 401, but 60 s skew is tolerated", async () => {
    const now = Math.floor(h.clock.t / 1000);
    const r = await start({ claims: { exp: now - 61 } });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("token expired");
    expect((await start({ claims: { exp: now - 30 } })).status).toBe(200);
    expect((await start({ claims: { exp: undefined } })).status).toBe(401);
  });

  test("not yet valid (nbf / iat) -> 401, skew tolerated", async () => {
    const now = Math.floor(h.clock.t / 1000);
    expect((await start({ claims: { nbf: now + 120 } })).json.error).toBe("token not yet valid");
    expect((await start({ claims: { iat: now + 120 } })).json.error).toBe("token not yet valid");
    expect((await start({ claims: { nbf: now + 30, iat: now + 30 } })).status).toBe(200);
  });

  test("owner not in allow-list -> 403", async () => {
    const r = await start({ claims: { repository_owner_id: "12345" } });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("owner not allowed");
    expect((await start({ claims: { repository_owner_id: "55664364" } })).status).toBe(200);
  });

  test("missing / malformed identity claims -> 401", async () => {
    expect((await start({ claims: { run_id: undefined } })).status).toBe(401);
    expect((await start({ claims: { repository_id: "abc" } })).status).toBe(401);
    expect((await start({ claims: { sha: undefined } })).status).toBe(401);
  });

  test("body sha / runId / runAttempt must match the token -> 400", async () => {
    expect((await start({ body: startBody({ sha: "c".repeat(40) }) })).status).toBe(400);
    expect((await start({ body: startBody({ runId: 1 }) })).status).toBe(400);
    expect((await start({ body: startBody({ runAttempt: 2 }) })).status).toBe(400);
    expect((await start({ body: startBody({ sha: SHA, runId: 5000, runAttempt: 1 }) })).status).toBe(200);
  });

  test("a token for owner A cannot spoof the repository through the body", async () => {
    await start();
    expect(h.db.row("SELECT repo_id, owner, name FROM repos")).toEqual({ repo_id: 1001, owner: "ProtoDurian", name: "demo" });
  });
});

describe("JWKS cache", () => {
  test("cached for an hour, re-fetched after", async () => {
    await start();
    await start();
    await start();
    expect(h.jwksFetches.n).toBe(1);
    h.clock.t += 59 * 60_000;
    await start({ token: await h.token() });
    expect(h.jwksFetches.n).toBe(1);
    h.clock.t += 2 * 60_000;
    await start({ token: await h.token() });
    expect(h.jwksFetches.n).toBe(2);
  });

  test("unknown kid triggers one re-fetch and succeeds after key rotation", async () => {
    await start();
    expect(h.jwksFetches.n).toBe(1);
    const rotated = await makeKeyPair("kid-2");
    h.setJwks([h.key.jwk, rotated.jwk]);
    const tok = await signJwt(rotated, baseClaims(h.clock.t));
    expect((await start({ token: tok })).status).toBe(200);
    expect(h.jwksFetches.n).toBe(2);
  });

  test("unknown kid that stays unknown -> 401 after a single re-fetch", async () => {
    await start();
    const stranger = await makeKeyPair("kid-9");
    const r = await start({ token: await signJwt(stranger, baseClaims(h.clock.t)) });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("unknown kid");
    expect(h.jwksFetches.n).toBe(2);
  });

  test("forced re-fetches are throttled (default 30 s)", async () => {
    const t = await makeHarness({});
    const stranger = await makeKeyPair("kid-9");
    const go = async () => t.call("POST", "/api/v1/runs/start", { body: startBody(), token: await signJwt(stranger, baseClaims(t.clock.t)) });
    expect((await go()).status).toBe(401); // first call: initial fetch
    expect((await go()).status).toBe(401);
    expect((await go()).status).toBe(401);
    expect(t.jwksFetches.n).toBe(1);
    t.clock.t += 31_000;
    await go();
    expect(t.jwksFetches.n).toBe(2);
  });

  test("JWKS outage with no cached keys -> 503; with cached keys keeps working", async () => {
    const t = await makeHarness();
    (t as any).app = undefined;
    const broken = await makeHarness();
    const { JwksCache } = await import("../src/auth");
    const { buildApp } = await import("../src/app");
    const app = buildApp({ jwks: new JwksCache(async () => { throw new Error("down"); }, () => broken.clock.t), now: () => broken.clock.t });
    const res = await app.request("/api/v1/runs/start", { method: "POST", headers: { authorization: `Bearer ${await broken.token()}`, "content-type": "application/json" }, body: JSON.stringify(startBody()) }, broken.env);
    expect(res.status).toBe(503);
  });
});
