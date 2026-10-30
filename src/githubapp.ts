import { MINUTE, HOUR, type Env } from "./env";
import type { AuthDeps } from "./session";

const API = "https://api.github.com";
const UA = "diene-reports";
/** the token is renewed this long before GitHub says it expires */
export const TOKEN_SKEW_MS = 5 * MINUTE;
/** an owner without an installation is looked up again after this long */
export const NO_INSTALL_RETRY_MS = HOUR;

export const appConfigured = (env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY_B64">): boolean =>
  !!env.GITHUB_APP_ID && env.GITHUB_APP_ID !== "TBD" && !!env.GITHUB_APP_PRIVATE_KEY_B64;

// ----------------------------------------------------------------------------- PEM -> CryptoKey

const b64Bytes = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
const b64url = (b: ArrayBuffer | Uint8Array | string): string => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};

const derLen = (n: number): number[] => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
const der = (tag: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(1 + derLen(len).length + len);
  out.set([tag, ...derLen(len)]);
  let at = 1 + derLen(len).length;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};

/** GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto wants PKCS#8. Wrap it: SEQ { 0, SEQ { rsaEncryption, NULL }, OCTET STRING { pkcs1 } } */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const rsaEncryption = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return der(0x30, new Uint8Array([0x02, 0x01, 0x00]), der(0x30, rsaEncryption), der(0x04, pkcs1));
}

/** PKCS#8 DER of a PEM, accepting both "BEGIN RSA PRIVATE KEY" (PKCS#1) and "BEGIN PRIVATE KEY" (PKCS#8) */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(pem);
  if (!m) throw new Error("not a PEM private key");
  const body = b64Bytes(m[2]!);
  if (m[1] === "RSA PRIVATE KEY") return pkcs1ToPkcs8(body);
  if (m[1] === "PRIVATE KEY") return body;
  throw new Error(`unsupported PEM type ${m[1]}`);
}

const keyCache = new Map<string, Promise<CryptoKey>>();
async function appKey(env: Pick<Env, "GITHUB_APP_PRIVATE_KEY_B64">): Promise<CryptoKey> {
  const raw = env.GITHUB_APP_PRIVATE_KEY_B64;
  let p = keyCache.get(raw);
  if (!p) {
    const text = raw.includes("-----BEGIN") ? raw : new TextDecoder().decode(b64Bytes(raw));
    p = crypto.subtle.importKey("pkcs8", pemToPkcs8(text), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    p.catch(() => keyCache.delete(raw));
    keyCache.set(raw, p);
  }
  return p;
}

/** The GitHub App's own JWT (RS256): issued 60 s in the past for clock drift, valid 9 minutes (GitHub allows 10). */
export async function appJwt(env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY_B64">, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iat, exp: Math.floor(nowMs / 1000) + 9 * 60, iss: env.GITHUB_APP_ID }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await appKey(env), new TextEncoder().encode(`${head}.${claims}`));
  return `${head}.${claims}.${b64url(sig)}`;
}

// ----------------------------------------------------------------------------- installation token

const headers = (bearer: string): Record<string, string> => ({
  authorization: `Bearer ${bearer}`,
  accept: "application/vnd.github+json",
  "user-agent": UA,
  "x-github-api-version": "2022-11-28",
});

/** in-memory, per isolate: installation id -> token. Concurrent callers share one request. */
const tokens = new Map<number, { token: string; exp: number }>();
const minting = new Map<number, Promise<string | null | "gone">>();
const looking = new Map<string, Promise<number | null | "error">>();

/** tests only */
export function resetAppCaches(): void {
  tokens.clear();
  minting.clear();
  looking.clear();
  keyCache.clear();
}

export const dropToken = (installationId: number) => tokens.delete(installationId);

/** installation id of the App on this owner (org first, then user), cached in D1. null = not installed; "error" = could not tell. */
async function installationOf(env: Env, deps: AuthDeps, owner: string): Promise<number | null | "error"> {
  const now = deps.now();
  const hit = await env.DB.prepare(`SELECT installation_id, checked_at FROM app_installations WHERE owner = ?1`).bind(owner).first<{ installation_id: number | null; checked_at: number }>();
  if (hit && (hit.installation_id !== null || now - hit.checked_at < NO_INSTALL_RETRY_MS) && now >= hit.checked_at) return hit.installation_id;
  const key = owner.toLowerCase();
  let p = looking.get(key);
  if (!p) {
    p = lookupInstallation(env, deps, owner).finally(() => looking.delete(key));
    looking.set(key, p);
  }
  return p;
}

async function lookupInstallation(env: Env, deps: AuthDeps, owner: string): Promise<number | null | "error"> {
  try {
    const jwt = await appJwt(env, deps.now());
    for (const kind of ["orgs", "users"] as const) {
      const res = await deps.fetch(`${API}/${kind}/${encodeURIComponent(owner)}/installation`, { headers: headers(jwt) });
      if (res.status === 200) {
        const id = ((await res.json()) as { id?: unknown }).id;
        if (typeof id !== "number") throw new Error("installation without an id");
        await env.DB
          .prepare(`INSERT INTO app_installations (owner, installation_id, checked_at) VALUES (?1, ?2, ?3) ON CONFLICT (owner) DO UPDATE SET installation_id = excluded.installation_id, checked_at = excluded.checked_at`)
          .bind(owner, id, deps.now())
          .run();
        return id;
      }
      if (res.status !== 404) {
        console.error("installation lookup failed", owner, kind, res.status);
        return "error";
      }
    }
    await env.DB
      .prepare(`INSERT INTO app_installations (owner, installation_id, checked_at) VALUES (?1, NULL, ?2) ON CONFLICT (owner) DO UPDATE SET installation_id = NULL, checked_at = excluded.checked_at`)
      .bind(owner, deps.now())
      .run();
    return null;
  } catch (e) {
    console.error("installation lookup failed", owner, String(e));
    return "error";
  }
}

async function mint(env: Env, deps: AuthDeps, id: number): Promise<string | null | "gone"> {
  try {
    const res = await deps.fetch(`${API}/app/installations/${id}/access_tokens`, { method: "POST", headers: headers(await appJwt(env, deps.now())) });
    if (res.status === 404) return "gone";
    if (res.status !== 201 && res.status !== 200) {
      console.error("installation token request failed", id, res.status);
      return null;
    }
    const b = (await res.json()) as { token?: unknown; expires_at?: unknown };
    const exp = typeof b.expires_at === "string" ? Date.parse(b.expires_at) : NaN;
    if (typeof b.token !== "string" || Number.isNaN(exp)) throw new Error("malformed token reply");
    tokens.set(id, { token: b.token, exp });
    return b.token;
  } catch (e) {
    console.error("installation token request failed", id, String(e));
    return null;
  }
}

async function tokenFor(env: Env, deps: AuthDeps, id: number): Promise<string | null | "gone"> {
  const hit = tokens.get(id);
  if (hit && deps.now() < hit.exp - TOKEN_SKEW_MS) return hit.token;
  let p = minting.get(id);
  if (!p) {
    p = mint(env, deps, id).finally(() => minting.delete(id));
    minting.set(id, p);
  }
  return p;
}

/**
 * How to call GitHub for this owner's repos:
 *  - `{ token }`: as the App's installation (needs GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_B64 and the App installed on the owner)
 *  - `{ token: null }`: unauthenticated (App not configured, or not installed on this owner); public repos only, 60 requests/hour per IP
 *  - `null`: GitHub could not be asked right now (nothing to decide on)
 */
export async function installationAuth(env: Env, deps: AuthDeps, owner: string): Promise<{ token: string | null; installationId: number | null } | null> {
  if (!appConfigured(env)) return { token: null, installationId: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = await installationOf(env, deps, owner);
    if (id === "error") return null;
    if (id === null) return { token: null, installationId: null };
    const t = await tokenFor(env, deps, id);
    if (t === null) return null;
    if (t !== "gone") return { token: t, installationId: id };
    // the App was uninstalled (or reinstalled under a new id): forget it and look once more
    await env.DB.prepare(`DELETE FROM app_installations WHERE owner = ?1`).bind(owner).run();
    tokens.delete(id);
  }
  return null;
}
