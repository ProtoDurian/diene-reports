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
  const r2 = new R2Shim();
  const env = {
    DB: db as unknown as D1Database,
    BUCKET: r2 as unknown as R2Bucket,
    ALLOWED_OWNER_IDS: "349664883,55664364",
    OIDC_AUDIENCE: "diene-reports",
    PUBLIC_BASE_URL: "https://reports.atomi.cloud",
  } satisfies Env;
  const app = buildApp({ jwks, now: () => clock.t });
  const h: Harness = {
    db,
    r2,
    env,
    clock,
    key,
    jwksFetches,
    app,
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
          totals: { total: 10, passed: 10 - failures.length, failed: failures.filter((f) => f.status === "failed").length, errored: failures.filter((f) => f.status === "errored").length, skipped: 0, durationMs: 250 },
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
