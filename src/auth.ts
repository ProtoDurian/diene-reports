import { HttpError } from "./http";
import { ISSUER, JWKS_URL, MINUTE, type Env } from "./env";

export interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}
export type JwksFetcher = () => Promise<{ keys: Jwk[] }>;

export const fetchGithubJwks: JwksFetcher = async () => {
  const res = await fetch(JWKS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`jwks http ${res.status}`);
  return (await res.json()) as { keys: Jwk[] };
};

export interface JwksProvider {
  getKey(kid: string): Promise<CryptoKey | null>;
}

export interface JwksOptions {
  ttlMs?: number;
  /** minimum gap between refetches triggered by an unknown kid (anti-amplification) */
  minRefetchMs?: number;
}

/** JWKS cached 1 h in memory; one forced re-fetch when the kid is unknown. */
export class JwksCache implements JwksProvider {
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = -Infinity;
  private inflight: Promise<void> | null = null;
  private ttl: number;
  private minRefetch: number;

  constructor(
    private fetcher: JwksFetcher,
    private now: () => number,
    opts: JwksOptions = {},
  ) {
    this.ttl = opts.ttlMs ?? 60 * MINUTE;
    this.minRefetch = opts.minRefetchMs ?? 30_000;
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const doc = await this.fetcher();
        const next = new Map<string, CryptoKey>();
        for (const jwk of doc.keys ?? []) {
          if (jwk.kty !== "RSA" || !jwk.kid || (jwk.use && jwk.use !== "sig")) continue;
          try {
            next.set(
              jwk.kid,
              await crypto.subtle.importKey(
                "jwk",
                { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
                { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
                false,
                ["verify"],
              ),
            );
          } catch {
            /* skip unusable key */
          }
        }
        this.keys = next;
        this.fetchedAt = this.now();
      } catch {
        if (this.keys.size === 0) throw new HttpError(503, "jwks unavailable");
        // keep serving stale keys; retry on the next stale check
        this.fetchedAt = this.now() - this.ttl + this.minRefetch;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async getKey(kid: string): Promise<CryptoKey | null> {
    if (this.now() - this.fetchedAt >= this.ttl) await this.refresh();
    const hit = this.keys.get(kid);
    if (hit) return hit;
    if (this.now() - this.fetchedAt >= this.minRefetch) {
      await this.refresh();
      return this.keys.get(kid) ?? null;
    }
    return null;
  }
}

export interface Identity {
  repository: string; // owner/name
  owner: string;
  name: string;
  repoId: number;
  ownerId: number;
  visibility: string;
  sha: string;
  ref: string;
  event: string;
  runId: number;
  runAttempt: number;
  actor: string;
  workflowRef: string;
  workflow: string;
  lane: "branch" | "pr" | "tag" | "other";
  /** project branch; null for lane `pr` until the body's baseRef is applied */
  branch: string | null;
  pr: number | null;
}

const b64u = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const parseJsonPart = (s: string): Record<string, unknown> => {
  const v = JSON.parse(new TextDecoder().decode(b64u(s)));
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
  return v as Record<string, unknown>;
};

const SKEW_S = 60;

export async function verifyToken(
  token: string,
  deps: { jwks: JwksProvider; now: () => number },
  env: Pick<Env, "ALLOWED_OWNER_IDS" | "OIDC_AUDIENCE">,
): Promise<Identity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "malformed token");
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    header = parseJsonPart(parts[0]!);
    claims = parseJsonPart(parts[1]!);
    sig = b64u(parts[2]!);
  } catch {
    throw new HttpError(401, "malformed token");
  }
  if (header.alg !== "RS256") throw new HttpError(401, "unsupported alg");
  if (typeof header.kid !== "string" || !header.kid) throw new HttpError(401, "missing kid");
  const key = await deps.jwks.getKey(header.kid);
  if (!key) throw new HttpError(401, "unknown kid");
  const ok = await crypto.subtle
    .verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
    .catch(() => false);
  if (!ok) throw new HttpError(401, "bad signature");

  if (claims.iss !== ISSUER) throw new HttpError(401, "bad issuer");
  const aud = claims.aud;
  if (!(aud === env.OIDC_AUDIENCE || (Array.isArray(aud) && aud.includes(env.OIDC_AUDIENCE)))) {
    throw new HttpError(401, "bad audience");
  }
  const nowS = Math.floor(deps.now() / 1000);
  if (typeof claims.exp !== "number") throw new HttpError(401, "missing exp");
  if (claims.exp + SKEW_S < nowS) throw new HttpError(401, "token expired");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - SKEW_S > nowS)) {
    throw new HttpError(401, "token not yet valid");
  }
  if (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat - SKEW_S > nowS)) {
    throw new HttpError(401, "token not yet valid");
  }

  const str = (k: string): string => {
    const v = claims[k];
    if (typeof v !== "string" || !v) throw new HttpError(401, `missing claim: ${k}`);
    return v;
  };
  const int = (k: string): number => {
    const v = claims[k];
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(401, `bad claim: ${k}`);
    return n;
  };

  const ownerId = int("repository_owner_id");
  const allowed = env.ALLOWED_OWNER_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.includes(String(ownerId))) throw new HttpError(403, "owner not allowed");

  const repository = str("repository");
  const slash = repository.indexOf("/");
  if (slash < 1) throw new HttpError(401, "bad claim: repository");
  const ref = str("ref");
  let lane: Identity["lane"] = "other";
  let branch: string | null = `ref:${ref}`;
  let pr: number | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^refs\/heads\/(.+)$/.exec(ref))) {
    lane = "branch";
    branch = m[1]!;
  } else if ((m = /^refs\/pull\/(\d+)\/merge$/.exec(ref))) {
    lane = "pr";
    branch = null;
    pr = Number(m[1]);
  } else if ((m = /^refs\/tags\/(.+)$/.exec(ref))) {
    lane = "tag";
    branch = `tag:${m[1]}`;
  }

  return {
    repository,
    owner: repository.slice(0, slash),
    name: repository.slice(slash + 1),
    repoId: int("repository_id"),
    ownerId,
    visibility: typeof claims.repository_visibility === "string" ? claims.repository_visibility : "private",
    sha: str("sha"),
    ref,
    event: str("event_name"),
    runId: int("run_id"),
    runAttempt: int("run_attempt"),
    actor: typeof claims.actor === "string" ? claims.actor : "",
    workflowRef: typeof claims.job_workflow_ref === "string" ? claims.job_workflow_ref : "",
    workflow: typeof claims.workflow === "string" ? claims.workflow : "",
    lane,
    branch,
    pr,
  };
}
