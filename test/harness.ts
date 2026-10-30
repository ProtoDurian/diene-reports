import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { buildApp } from "../src/app";
import { JwksCache, type Jwk } from "../src/auth";
import type { Env } from "../src/env";
import { D1Shim, R2Shim } from "./shims";

export const T0 = 1_800_000_000_000; // fixed test clock (ms)
export const OWNER_ID = "349664883";
export const SHA = "a".repeat(40);
export const SHA2 = "b".repeat(40);

const b64u = (b: ArrayBuffer | Uint8Array | string): string =>
  Buffer.from(typeof b === "string" ? b : b instanceof Uint8Array ? b : new Uint8Array(b))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

export interface KeyPair {
  kid: string;
  privateKey: CryptoKey;
  jwk: Jwk;
}

export async function makeKeyPair(kid: string): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: "RSA", n: jwk.n!, e: jwk.e!, alg: "RS256", use: "sig" } };
}

export async function signJwt(
  key: KeyPair,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const h = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid, ...header }));
  const p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
}

export const baseClaims = (nowMs: number): Record<string, unknown> => ({
  iss: "https://token.actions.githubusercontent.com",
  aud: "diene-reports",
  iat: Math.floor(nowMs / 1000),
  nbf: Math.floor(nowMs / 1000),
  exp: Math.floor(nowMs / 1000) + 300,
  repository: "ProtoDurian/demo",
  repository_id: "1001",
  repository_owner: "ProtoDurian",
  repository_owner_id: OWNER_ID,
  repository_visibility: "public",
  sha: SHA,
  ref: "refs/heads/main",
  event_name: "push",
  run_id: "5000",
  run_attempt: "1",
  actor: "kirin",
  job_workflow_ref: "ProtoDurian/demo/.github/workflows/ci.yaml@refs/heads/main",
  workflow: "CI",
});

// ------------------------------------------------------------- fake GitHub

export interface FakeGithub {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: { method: string; url: string; auth: string | null; body: any }[];
  users: Map<number, { id: number; login: string; repos: Set<number> }>;
  /** every token pair handed out so far: access -> user id */
  tokens: Map<string, number>;
  /** user the next code exchange signs in */
  nextUser: number;
  /** seconds until an access token expires */
  accessTtl: number;
  /** make refresh requests fail the way GitHub does (HTTP 200 + error body) */
  refreshFails: boolean;
  /** GitHub is unreachable */
  down: boolean;
  /** what GitHub says about a repo to the App (Basic auth). Unlisted repos answer from our own table, i.e. "nothing changed". */
  repos: Map<number, { visibility: string; full_name?: string } | { status: number }>;
  /** user-token repo lookups answer 403 + x-ratelimit-remaining: 0 */
  rateLimited: boolean;
  /** the refresh grant answers with this HTTP status (e.g. 502) instead of a normal reply */
  refreshStatus: number | null;
  /** DELETE /applications/{id}/token answers with this status */
  revokeStatus: number;
  count(match: string): number;
}

export function makeFakeGithub(now: () => number, own: (repoId: number) => Promise<{ visibility: string; owner: string; name: string } | null> = async () => null): FakeGithub {
  let n = 0;
  const refreshTokens = new Map<string, number>();
  const gh: FakeGithub = {
    calls: [],
    users: new Map(),
    tokens: new Map(),
    nextUser: 0,
    accessTtl: 8 * 3600,
    refreshFails: false,
    down: false,
    repos: new Map(),
    rateLimited: false,
    refreshStatus: null,
    revokeStatus: 204,
    count: (match) => gh.calls.filter((c) => c.url.includes(match)).length,
    fetch: async (url, init = {}) => {
      const h = new Headers(init.headers);
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      gh.calls.push({ method: init.method ?? "GET", url, auth: h.get("authorization"), body });
      if (gh.down) throw new Error("network down");
      const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
      const issue = (uid: number) => {
        n++;
        const access = `ghu_access${n}`;
        const refresh = `ghr_refresh${n}`;
        gh.tokens.set(access, uid);
        refreshTokens.set(refresh, uid);
        return { access_token: access, refresh_token: refresh, expires_in: gh.accessTtl, refresh_token_expires_in: 15811200, token_type: "bearer" };
      };
      if (url === "https://github.com/login/oauth/access_token") {
        if (body.client_secret !== "test-client-secret" || body.client_id !== "Iv1.testclient") return json({ error: "incorrect_client_credentials" });
        if (body.grant_type === "refresh_token") {
          if (gh.refreshStatus) return json({ message: "Bad Gateway" }, gh.refreshStatus);
          const uid = refreshTokens.get(body.refresh_token);
          if (gh.refreshFails || uid === undefined) return json({ error: "bad_refresh_token" });
          refreshTokens.delete(body.refresh_token); // single use, like GitHub
          return json(issue(uid));
        }
        if (body.code !== `code-${gh.nextUser}` || !gh.users.has(gh.nextUser)) return json({ error: "bad_verification_code" });
        return json(issue(gh.nextUser));
      }
      const mTok = /^https:\/\/api\.github\.com\/applications\/([^/]+)\/token$/.exec(url);
      if (mTok && init.method === "DELETE") {
        if (h.get("authorization") !== `Basic ${btoa("Iv1.testclient:test-client-secret")}`) return json({ message: "Bad credentials" }, 401);
        if (gh.revokeStatus === 204) gh.tokens.delete(body.access_token);
        return new Response(null, { status: gh.revokeStatus });
      }
      const auth = h.get("authorization") ?? "";
      const uid = gh.tokens.get(auth.replace(/^Bearer /, ""));
      if (url === "https://api.github.com/user") {
        if (uid === undefined) return json({ message: "Bad credentials" }, 401);
        const u = gh.users.get(uid)!;
        return json({ id: u.id, login: u.login, avatar_url: `https://avatars.githubusercontent.com/u/${u.id}?v=4` });
      }
      const m = /^https:\/\/api\.github\.com\/repositories\/(\d+)$/.exec(url);
      if (m && auth.startsWith("Basic ")) {
        if (auth !== `Basic ${btoa("Iv1.testclient:test-client-secret")}`) return json({ message: "Bad credentials" }, 401);
        const id = Number(m[1]);
        const set = gh.repos.get(id);
        if (set && "status" in set) return json({ message: "boom" }, set.status);
        if (set) return json({ id, visibility: set.visibility, private: set.visibility !== "public", full_name: set.full_name ?? undefined });
        const mine = await own(id);
        // like GitHub, the App sees public repos only
        if (!mine || mine.visibility !== "public") return json({ message: "Not Found" }, 404);
        return json({ id, visibility: "public", private: false, full_name: `${mine.owner}/${mine.name}` });
      }
      if (m) {
        if (gh.rateLimited) return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "x-ratelimit-remaining": "0" } });
        if (uid === undefined) return json({ message: "Bad credentials" }, 401);
        return gh.users.get(uid)!.repos.has(Number(m[1])) ? json({ id: Number(m[1]) }) : json({ message: "Not Found" }, 404);
      }
      return json({}, 404);
    },
  };
  return gh;
}

export const gz = (data: string | Uint8Array): Uint8Array => new Uint8Array(gzipSync(data));
export const gitSha = (content: string | Uint8Array): string => {
  const buf = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
};

export interface Res {
  status: number;
  json: any;
  res: Response;
}

export interface Harness {
  db: D1Shim;
  r2: R2Shim;
  env: Env;
  clock: { t: number };
  key: KeyPair;
  jwksFetches: { n: number };
  gh: FakeGithub;
  /** GET a viewer path; pass `cookie` (from signIn) to be a signed-in user */
  view(path: string, opts?: { cookie?: string | null; headers?: Record<string, string> }): Promise<{ status: number; headers: Headers; text: string }>;
  /** run the real /login + /auth/callback round trip as this GitHub user; returns the session cookie ("name=value") */
  signIn(user: { id: number; login: string }, repoIds?: number[]): Promise<string>;
  setJwks(keys: Jwk[]): void;
  token(over?: Record<string, unknown>, key?: KeyPair, header?: Record<string, unknown>): Promise<string>;
  call(method: string, path: string, opts?: CallOpts): Promise<Res>;
  app: ReturnType<typeof buildApp>;
}
export interface CallOpts {
  claims?: Record<string, unknown>;
  body?: unknown;
  rawBody?: Uint8Array | string;
  headers?: Record<string, string>;
  token?: string | null;
}

export async function makeHarness(jwksOpts: { minRefetchMs?: number } = { minRefetchMs: 0 }): Promise<Harness> {
  const key = await makeKeyPair("kid-1");
  const clock = { t: T0 };
  const jwksFetches = { n: 0 };
  let keys: Jwk[] = [key.jwk];
  const jwks = new JwksCache(
    async () => {
      jwksFetches.n++;
      return { keys };
    },
    () => clock.t,
    jwksOpts,
  );
  const db = new D1Shim();
  const gh = makeFakeGithub(
    () => clock.t,
    (id) => db.prepare(`SELECT visibility, owner, name FROM repos WHERE repo_id = ?1`).bind(id).first(),
  );
  const r2 = new R2Shim();
  const env = {
    DB: db as unknown as D1Database,
    BUCKET: r2 as unknown as R2Bucket,
    ALLOWED_OWNER_IDS: "349664883,55664364",
    OIDC_AUDIENCE: "diene-reports",
    PUBLIC_BASE_URL: "https://reports.atomi.cloud",
    GITHUB_CLIENT_ID: "Iv1.testclient",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    SESSION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  } satisfies Env;
  const app = buildApp({ jwks, now: () => clock.t, fetch: gh.fetch });
  const h: Harness = {
    db,
    r2,
    env,
    clock,
    key,
    jwksFetches,
    gh,
    app,
    async view(path, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.cookie) headers.cookie = opts.cookie;
      const res = await app.request(path, { headers }, env);
      return { status: res.status, headers: res.headers, text: await res.text() };
    },
    async signIn(user, repoIds = []) {
      gh.users.set(user.id, { ...user, repos: new Set(repoIds) });
      gh.nextUser = user.id;
      const start = await app.request("/login?next=/", {}, env);
      const stateCookie = /__Host-diene_state=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")![1]!;
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const cb = await app.request(`/auth/callback?code=code-${user.id}&state=${state}`, { headers: { cookie: `__Host-diene_state=${stateCookie}` } }, env);
      const m = /(__Host-diene_session=[^;]+)/.exec(cb.headers.get("set-cookie") ?? "");
      if (!m) throw new Error(`sign-in failed: ${cb.status}`);
      return m[1]!;
    },
    setJwks: (k) => {
      keys = k;
    },
    token: (over = {}, k = key, header = {}) => signJwt(k, { ...baseClaims(clock.t), ...over }, header),
    async call(method, path, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      const tok = opts.token === undefined ? await h.token(opts.claims) : opts.token;
      if (tok !== null) headers.authorization = `Bearer ${tok}`;
      let body: BodyInit | undefined;
      if (opts.rawBody !== undefined) {
        body = opts.rawBody as BodyInit;
        headers["content-length"] ??= String(typeof opts.rawBody === "string" ? Buffer.byteLength(opts.rawBody) : opts.rawBody.byteLength);
      } else if (opts.body !== undefined) {
        const s = JSON.stringify(opts.body);
        body = s;
        headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(s));
      }
      const res = await app.request(path, { method, headers, body }, env);
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: res.status, json, res };
    },
  };
  return h;
}

// ------------------------------------------------------------- body builders

export const startBody = (o: Record<string, unknown> = {}) => ({
  schema: "diene-start/v1",
  flag: "unit",
  job: "unit",
  language: "bun",
  workflow: "CI",
  timeoutMinutes: 30,
  headSha: null,
  pr: null,
  baseRef: null,
  baseSha: null,
  ...o,
});

export interface Fail {
  id: string;
  name?: string;
  status?: "failed" | "errored";
  message?: string;
  stack?: string | null;
  file?: string | null;
}

export function summary(o: {
  claims?: { sha?: string; runId?: number; runAttempt?: number };
  flag?: string;
  job?: string;
  cls?: string;
  subReason?: string | null;
  failures?: Fail[];
  recovered?: string[];
  tests?: unknown;
  coverage?: unknown;
  patch?: unknown;
  sources?: unknown[];
  headSha?: string | null;
  pr?: number | null;
  baseRef?: string | null;
  jobFailedAfterTests?: boolean;
  overCap?: boolean;
  truncated?: boolean;
  covPartial?: boolean;
  startedAt?: string | null;
} = {}) {
  const failures = (o.failures ?? []).map((f) => ({
    id: f.id,
    suite: "math",
    name: f.name ?? `test ${f.id}`,
    file: f.file === undefined ? "tests/m.test.ts" : f.file,
    line: 5,
    status: f.status ?? "failed",
    durationMs: 1,
    message: f.message ?? "Expected: 4\nReceived: 3",
    stack: f.stack === undefined ? "at m (tests/m.test.ts:5)" : f.stack,
  }));
  const cls = o.cls ?? (failures.length ? "tests_failed" : "passed");
  const tests =
    o.tests !== undefined
      ? o.tests
      : {
          totals: { total: Math.max(10, failures.length), passed: Math.max(10, failures.length) - failures.length, failed: failures.filter((f) => f.status === "failed").length, errored: failures.filter((f) => f.status === "errored").length, skipped: 0, durationMs: 250 },
          failures,
          failuresTruncated: o.truncated ?? false,
          recovered: o.recovered ?? [],
        };
  return {
    schema: "diene-summary/v1",
    context: {
      sha: o.claims?.sha ?? SHA,
      runId: o.claims?.runId ?? 5000,
      runAttempt: o.claims?.runAttempt ?? 1,
      headSha: o.headSha ?? null,
      pr: o.pr ?? null,
      baseRef: o.baseRef ?? null,
      baseSha: null,
      workflow: "CI",
      job: o.job ?? "unit",
      flag: o.flag ?? "unit",
      language: "bun",
      tool: "bun 1.3.13",
      timeoutMinutes: 30,
    },
    outcome: {
      testStep: cls === "passed" ? "success" : "failure",
      jobStatus: cls === "passed" && !o.jobFailedAfterTests ? "success" : "failure",
      class: cls,
      subReason: o.subReason ?? null,
      jobFailedAfterTests: o.jobFailedAfterTests ?? false,
      startedAt: o.startedAt === undefined ? null : o.startedAt,
      finishedAt: new Date(T0).toISOString(),
      notes: [],
    },
    tests,
    coverage:
      o.coverage !== undefined
        ? o.coverage
        : {
            format: "lcov",
            totals: { lines: 120, linesHit: 110, branches: null, branchesHit: null },
            partial: o.covPartial ?? false,
            files: [{ path: "src/lib/m.ts", lines: 10, hit: 9, chunk: 0 }],
          },
    patch: o.patch ?? null,
    sources: o.sources ?? [],
    raw: [],
    warnings: [],
    overCap: o.overCap ?? false,
  };
}

/** claims for run N of the same repo; later runs have larger run ids */
export const runClaims = (n: number, over: Record<string, unknown> = {}) => ({ run_id: String(5000 + n), sha: n.toString(16).padStart(40, "0"), ...over });
export const sumFor = (n: number, o: Parameters<typeof summary>[0] = {}) =>
  summary({ ...o, claims: { sha: n.toString(16).padStart(40, "0"), runId: 5000 + n, runAttempt: 1 } });

export const prClaims = (n: number, pr: number, over: Record<string, unknown> = {}) => ({
  ref: `refs/pull/${pr}/merge`,
  event_name: "pull_request",
  ...runClaims(n),
  ...over,
});

export const startRun = (h: Harness, claims: Record<string, unknown> = {}, body: Record<string, unknown> = {}) =>
  h.call("POST", "/api/v1/runs/start", { claims, body: startBody(body) });

export const finishRun = (h: Harness, claims: Record<string, unknown> = {}, body: unknown = summary()) =>
  h.call("POST", "/api/v1/runs/finish", { claims, body });

/** finish for the n-th run of the repo on branch main */
export const finishN = (h: Harness, n: number, o: Parameters<typeof summary>[0] = {}, claims: Record<string, unknown> = {}) =>
  finishRun(h, runClaims(n, claims), sumFor(n, o));

export const putGz = (h: Harness, path: string, data: string | Uint8Array, claims: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  h.call("PUT", path, { claims, rawBody: gz(data), headers: { "content-type": "application/gzip", ...headers } });

/** finish for run n whose token sha is `sha` (a re-run of one commit) */
export const finishSha = (h: Harness, n: number, sha: string, o: Parameters<typeof summary>[0] = {}, claims: Record<string, unknown> = {}) =>
  finishRun(h, runClaims(n, { sha, ...claims }), summary({ ...o, claims: { sha, runId: 5000 + n, runAttempt: 1 } }));
