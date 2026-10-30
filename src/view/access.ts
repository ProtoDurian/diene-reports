import type { Context, Next } from "hono";
import { JwksCache, SKEW_S, b64u, parseJsonPart, type Jwk, type JwksProvider } from "../auth";
import type { Env } from "../env";

export const ACCESS_HEADER = "cf-access-jwt-assertion";

const caches = new Map<string, JwksProvider>();

/** Cloudflare Access signing keys for a team domain, cached in memory like the GitHub keys. */
export function accessJwksFor(env: Pick<Env, "ACCESS_TEAM_DOMAIN">, now: () => number): JwksProvider {
  const team = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, "");
  let c = caches.get(team);
  if (!c) {
    c = new JwksCache(async () => {
      const res = await fetch(`${team}/cdn-cgi/access/certs`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`access certs http ${res.status}`);
      return (await res.json()) as { keys: Jwk[] };
    }, now);
    caches.set(team, c);
  }
  return c;
}

/** true when the Access JWT is valid for this team and application; never throws */
export async function accessAllowed(
  token: string | undefined,
  env: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">,
  jwks: JwksProvider,
  now: () => number,
): Promise<boolean> {
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const header = parseJsonPart(parts[0]!);
    const claims = parseJsonPart(parts[1]!);
    const sig = b64u(parts[2]!);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return false;
    const key = await jwks.getKey(header.kid);
    if (!key) return false;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return false;
    const team = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, "");
    if (typeof claims.iss !== "string" || claims.iss.replace(/\/+$/, "") !== team) return false;
    const aud = claims.aud;
    if (!(aud === env.ACCESS_AUD || (Array.isArray(aud) && aud.includes(env.ACCESS_AUD)))) return false;
    const nowS = Math.floor(now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp + SKEW_S < nowS) return false;
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - SKEW_S > nowS)) return false;
    return true;
  } catch {
    return false;
  }
}

// Routes the Worker authenticates itself (GitHub OIDC) or that are public by design.
// Kept strict: an owner called "api" or "badge" must not slip through.
export const isAccessExempt = (path: string): boolean =>
  path === "/healthz" || path.startsWith("/api/v1/") || /^\/badge\/[^/]+\/[^/]+\/[^/]+$/.test(path);

export function accessGuard(getJwks: (env: Env) => JwksProvider, now: () => number) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (isAccessExempt(c.req.path)) return next();
    if (await accessAllowed(c.req.header(ACCESS_HEADER), c.env, getJwks(c.env), now)) return next();
    return c.text("Forbidden: sign in through Cloudflare Access.", 403, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
  };
}
