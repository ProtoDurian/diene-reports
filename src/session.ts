import { DAY, MINUTE, type Env } from "./env";

/** `fetch` for GitHub; tests inject a fake */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export interface AuthDeps {
  fetch: Fetcher;
  now: () => number;
}

export const SESSION_COOKIE = "__Host-diene_session";
export const STATE_COOKIE = "__Host-diene_state";
export const SESSION_TTL_MS = 30 * DAY;
export const STATE_TTL_MS = 10 * MINUTE;
export const ACCESS_CACHE_MS = 10 * MINUTE;
const REFRESH_SKEW_MS = MINUTE;
const TOUCH_EVERY_MS = 60 * MINUTE;
const UA = "diene-reports";

export interface Session {
  idHash: string;
  userId: number;
  login: string;
  avatarUrl: string | null;
  accessToken: string;
}

// ----------------------------------------------------------------------------- encoding + keys

const te = new TextEncoder();
const td = new TextDecoder();

export const enc64 = (b: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const dec64 = (s: string): Uint8Array<ArrayBuffer> => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

const randomB64 = (n: number): string => enc64(crypto.getRandomValues(new Uint8Array(n)));

export const sha256Hex = async (s: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

export class ConfigError extends Error {}

async function masterKey(env: Pick<Env, "SESSION_KEY">): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = dec64(env.SESSION_KEY ?? "");
  } catch {
    throw new ConfigError("SESSION_KEY is not base64");
  }
  if (raw.length !== 32) throw new ConfigError("SESSION_KEY must be 32 random bytes, base64 encoded");
  return crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
}

// Separate keys per purpose, derived from SESSION_KEY.
const info = (label: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(`diene-reports/${label}`) });
const aesKey = async (env: Pick<Env, "SESSION_KEY">) =>
  crypto.subtle.deriveKey(info("tokens"), await masterKey(env), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const macKey = async (env: Pick<Env, "SESSION_KEY">) =>
  crypto.subtle.deriveKey(info("state"), await masterKey(env), { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);

/** AES-GCM; `aad` ties the ciphertext to its row so it cannot be moved to another session */
export async function encrypt(env: Pick<Env, "SESSION_KEY">, plain: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, await aesKey(env), te.encode(plain));
  return `v1.${enc64(iv)}.${enc64(ct)}`;
}

export async function decrypt(env: Pick<Env, "SESSION_KEY">, blob: string, aad: string): Promise<string | null> {
  const p = blob.split(".");
  if (p.length !== 3 || p[0] !== "v1") return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: dec64(p[1]!), additionalData: te.encode(aad) }, await aesKey(env), dec64(p[2]!));
    return td.decode(plain);
  } catch {
    return null;
  }
}

export function timingEqual(a: string, b: string): boolean {
  const x = te.encode(a);
  const y = te.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

// ----------------------------------------------------------------------------- config, cookies, next

export const authConfigured = (env: Pick<Env, "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET" | "SESSION_KEY">): boolean =>
  !!env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_ID !== "TBD" && !!env.GITHUB_CLIENT_SECRET && !!env.SESSION_KEY;

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

export const setCookie = (name: string, value: string, maxAgeS: number): string =>
  `${name}=${value}; Path=/; Max-Age=${maxAgeS}; HttpOnly; Secure; SameSite=Lax`;

/** A same-site path only: starts with a single "/", no backslashes or control characters. Anything else becomes "/". */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(next)) return "/";
  try {
    const u = new URL(next, "http://same.site");
    if (u.origin !== "http://same.site") return "/";
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

// ----------------------------------------------------------------------------- login state

/** random state for GitHub plus a signed cookie that remembers it (and where to go afterwards) */
export async function makeState(env: Env, next: string, now: number): Promise<{ state: string; cookie: string }> {
  const state = randomB64(32);
  const payload = enc64(te.encode(JSON.stringify({ n: next, e: now + STATE_TTL_MS })));
  const mac = enc64(await crypto.subtle.sign("HMAC", await macKey(env), te.encode(`${state}.${payload}`)));
  return { state, cookie: `${state}.${payload}.${mac}` };
}

export async function readState(env: Env, cookie: string | null, now: number): Promise<{ state: string; next: string } | null> {
  const p = cookie?.split(".") ?? [];
  if (p.length !== 3) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await macKey(env), dec64(p[2]!), te.encode(`${p[0]}.${p[1]}`)))) return null;
    const v = JSON.parse(td.decode(dec64(p[1]!))) as { n?: unknown; e?: unknown };
    if (typeof v.e !== "number" || v.e < now || typeof v.n !== "string") return null;
    return { state: p[0]!, next: safeNext(v.n) };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------- GitHub calls

interface TokenSet {
  access: string;
  refresh: string | null;
  accessExp: number | null;
  refreshExp: number | null;
}

/** null = GitHub said no; throws on network errors */
async function tokenRequest(env: Env, deps: AuthDeps, params: Record<string, string>): Promise<TokenSet | null> {
  const res = await deps.fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
  });
  if (!res.ok) return null;
  const b = (await res.json()) as Record<string, unknown>;
  if (typeof b.access_token !== "string" || !b.access_token) return null;
  const now = deps.now();
  const secs = (v: unknown) => (typeof v === "number" && v > 0 ? now + v * 1000 : null);
  return {
    access: b.access_token,
    refresh: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : null,
    accessExp: secs(b.expires_in),
    refreshExp: secs(b.refresh_token_expires_in),
  };
}

export const exchangeCode = (env: Env, deps: AuthDeps, code: string) =>
  tokenRequest(env, deps, { code, redirect_uri: `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/auth/callback` });

export async function fetchGithubUser(deps: AuthDeps, token: string): Promise<{ id: number; login: string; avatar: string | null } | null> {
  const res = await deps.fetch("https://api.github.com/user", { headers: ghHeaders(token) });
  if (!res.ok) return null;
  const u = (await res.json()) as Record<string, unknown>;
  if (typeof u.id !== "number" || typeof u.login !== "string" || !u.login) return null;
  const avatar = typeof u.avatar_url === "string" && /^https:\/\/avatars\.githubusercontent\.com\//.test(u.avatar_url) ? u.avatar_url : null;
  return { id: u.id, login: u.login, avatar };
}

const ghHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": UA,
  "x-github-api-version": "2022-11-28",
});

// ----------------------------------------------------------------------------- sessions

interface Row {
  id_hash: string;
  user_id: number;
  login: string;
  avatar_url: string | null;
  access_enc: string;
  refresh_enc: string | null;
  access_exp: number | null;
  refresh_exp: number | null;
  expires_at: number;
  last_seen: number;
}

export async function createSession(env: Env, deps: AuthDeps, user: { id: number; login: string; avatar: string | null }, t: TokenSet): Promise<string> {
  const id = randomB64(32);
  const idHash = await sha256Hex(id);
  const now = deps.now();
  await env.DB
    .prepare(
      `INSERT INTO sessions (id_hash, user_id, login, avatar_url, access_enc, refresh_enc, access_exp, refresh_exp, expires_at, created_at, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
    )
    .bind(
      idHash,
      user.id,
      user.login,
      user.avatar,
      await encrypt(env, t.access, `${idHash}:access`),
      t.refresh ? await encrypt(env, t.refresh, `${idHash}:refresh`) : null,
      t.accessExp,
      t.refreshExp,
      now + SESSION_TTL_MS,
      now,
    )
    .run();
  return id;
}

export async function deleteSession(env: Env, cookieValue: string | null): Promise<void> {
  if (!cookieValue || !SESSION_ID_RE.test(cookieValue)) return;
  await env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?1`).bind(await sha256Hex(cookieValue)).run();
}

const readRow = (env: Env, idHash: string) => env.DB.prepare(`SELECT * FROM sessions WHERE id_hash = ?1`).bind(idHash).first<Row>();
const dropRow = (env: Env, idHash: string) => env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?1`).bind(idHash).run();

/** The signed-in user for this cookie, refreshing an expired GitHub token on the way; null = signed out. */
export async function loadSession(env: Env, deps: AuthDeps, cookieValue: string | null): Promise<Session | null> {
  if (!cookieValue || !SESSION_ID_RE.test(cookieValue) || !env.SESSION_KEY) return null;
  const idHash = await sha256Hex(cookieValue);
  let row = await readRow(env, idHash);
  if (!row) return null;
  const now = deps.now();
  if (row.expires_at <= now) {
    await dropRow(env, idHash);
    return null;
  }
  let access: string | null;
  if (row.access_exp !== null && row.access_exp - REFRESH_SKEW_MS <= now) {
    const refreshed = await refresh(env, deps, row);
    if (!refreshed) return null;
    [row, access] = refreshed;
  } else {
    access = await decrypt(env, row.access_enc, `${idHash}:access`);
  }
  if (access === null) {
    await dropRow(env, idHash);
    return null;
  }
  if (now - row.last_seen > TOUCH_EVERY_MS) await env.DB.prepare(`UPDATE sessions SET last_seen = ?2 WHERE id_hash = ?1`).bind(idHash, now).run();
  return { idHash, userId: row.user_id, login: row.login, avatarUrl: row.avatar_url, accessToken: access };
}

/** [updated row, access token]; null = signed out (the row is deleted unless GitHub was just unreachable) */
async function refresh(env: Env, deps: AuthDeps, row: Row): Promise<[Row, string] | null> {
  const now = deps.now();
  const idHash = row.id_hash;
  const old = row.refresh_enc ? await decrypt(env, row.refresh_enc, `${idHash}:refresh`) : null;
  if (old === null || (row.refresh_exp !== null && row.refresh_exp <= now)) {
    await dropRow(env, idHash);
    return null;
  }
  let t: TokenSet | null;
  try {
    t = await tokenRequest(env, deps, { grant_type: "refresh_token", refresh_token: old });
  } catch {
    return null;
  }
  if (!t) {
    // Refresh tokens are single use: a parallel request may have won the race. Use its result if it is there.
    const again = await readRow(env, idHash);
    if (again && again.refresh_enc !== row.refresh_enc && (again.access_exp === null || again.access_exp - REFRESH_SKEW_MS > now)) {
      const a = await decrypt(env, again.access_enc, `${idHash}:access`);
      if (a !== null) return [again, a];
    }
    await dropRow(env, idHash);
    return null;
  }
  const accessEnc = await encrypt(env, t.access, `${idHash}:access`);
  const refreshEnc = t.refresh ? await encrypt(env, t.refresh, `${idHash}:refresh`) : null;
  await env.DB
    .prepare(`UPDATE sessions SET access_enc = ?2, refresh_enc = ?3, access_exp = ?4, refresh_exp = ?5, last_seen = ?6 WHERE id_hash = ?1`)
    .bind(idHash, accessEnc, refreshEnc, t.accessExp, t.refreshExp, now)
    .run();
  return [{ ...row, access_enc: accessEnc, refresh_enc: refreshEnc, access_exp: t.accessExp, refresh_exp: t.refreshExp, last_seen: now }, t.access];
}

// ----------------------------------------------------------------------------- repo access

/**
 * May this signed-in user see the repo? Asks GitHub with the USER's token (by repo id, so renames do not matter)
 * and caches the yes/no for 10 minutes. GitHub being unreachable counts as no and is not cached.
 */
export async function userCanSee(env: Env, deps: AuthDeps, s: Session, repoId: number): Promise<boolean> {
  const now = deps.now();
  const hit = await env.DB
    .prepare(`SELECT allowed, checked_at FROM repo_access WHERE user_id = ?1 AND repo_id = ?2`)
    .bind(s.userId, repoId)
    .first<{ allowed: number; checked_at: number }>();
  if (hit && now - hit.checked_at < ACCESS_CACHE_MS && now >= hit.checked_at) return hit.allowed === 1;
  let allowed: boolean;
  try {
    const res = await deps.fetch(`https://api.github.com/repositories/${repoId}`, { headers: ghHeaders(s.accessToken) });
    if (res.status === 200) allowed = true;
    else if (res.status === 404 || res.status === 403 || res.status === 401) allowed = false;
    else return false;
  } catch {
    return false;
  }
  await env.DB
    .prepare(
      `INSERT INTO repo_access (user_id, repo_id, allowed, checked_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (user_id, repo_id) DO UPDATE SET allowed = excluded.allowed, checked_at = excluded.checked_at`,
    )
    .bind(s.userId, repoId, allowed ? 1 : 0, now)
    .run();
  return allowed;
}

export async function gcSessions(env: Env, now: number): Promise<number> {
  const r = await env.DB
    .prepare(
      `DELETE FROM sessions WHERE expires_at < ?1 OR (refresh_exp IS NOT NULL AND refresh_exp < ?1)
         OR (refresh_enc IS NULL AND access_exp IS NOT NULL AND access_exp < ?1) RETURNING id_hash`,
    )
    .bind(now)
    .all();
  await env.DB.prepare(`DELETE FROM repo_access WHERE checked_at < ?1`).bind(now - DAY).run();
  return r.results.length;
}
