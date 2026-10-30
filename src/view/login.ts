import type { Context, Hono } from "hono";
import type { Env } from "../env";
import { HttpError } from "../http";
import {
  SESSION_COOKIE, SESSION_TTL_MS, STATE_COOKIE, authConfigured, createSession, deleteSession, exchangeCode, fetchGithubUser, makeState, revokeToken,
  readCookie, readState, safeNext, setCookie, timingEqual, type AuthDeps, type Session,
} from "../session";
import { enc, html, type Raw } from "./html";

export type V = { Bindings: Env; Variables: { viewer: Session | null } };

/** "Sign in with GitHub", or the avatar, name and a sign-out button. `here` is the page to come back to. */
export function authHtml(viewer: Session | null, here: string): Raw {
  if (!viewer) return html`<span class="auth"><a class="btn signin" href="/login?next=${enc(here)}">Sign in with GitHub</a></span>`;
  return html`<span class="auth">${viewer.avatarUrl ? html`<img class="avatar" src="${viewer.avatarUrl}" alt="" width="24" height="24">` : ""}<span class="who">${viewer.login}</span>
<form method="post" action="/logout"><button class="linkbtn" type="submit">Sign out</button></form></span>`;
}

const noStore = (c: Context) => c.header("Cache-Control", "no-store");

export function mountAuth(v: Hono<V>, deps: AuthDeps) {
  v.get("/login", async (c) => {
    noStore(c);
    if (!authConfigured(c.env)) throw new HttpError(503, "Sign-in is not set up on this server yet.");
    const next = safeNext(c.req.query("next"));
    const { state, cookie } = await makeState(c.env, next, deps.now());
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
    url.searchParams.set("redirect_uri", `${c.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/auth/callback`);
    url.searchParams.set("state", state);
    c.header("Set-Cookie", setCookie(STATE_COOKIE, cookie, 600));
    return c.redirect(url.toString(), 302);
  });

  v.get("/auth/callback", async (c) => {
    noStore(c);
    // the state cookie is single use, whatever happens next
    c.header("Set-Cookie", setCookie(STATE_COOKIE, "", 0), { append: true });
    if (!authConfigured(c.env)) throw new HttpError(503, "Sign-in is not set up on this server yet.");
    const st = await readState(c.env, readCookie(c.req.header("cookie"), STATE_COOKIE), deps.now());
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!st || !state || !code || !timingEqual(state, st.state)) {
      throw new HttpError(400, "The sign-in link is invalid or has expired, or sign-in was cancelled. Please start again.");
    }
    let session: string;
    try {
      const tokens = await exchangeCode(c.env, deps, code);
      const user = tokens && (await fetchGithubUser(deps, tokens.access));
      if (!tokens || !user) throw new HttpError(400, "GitHub did not accept the sign-in. Please try again.");
      // signing in again replaces the old session instead of leaving its row (and token) behind
      await deleteSession(c.env, readCookie(c.req.header("cookie"), SESSION_COOKIE));
      session = await createSession(c.env, deps, user, tokens);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      console.error("sign-in failed", e);
      throw new HttpError(502, "Could not reach GitHub. Please try again in a moment.");
    }
    c.header("Set-Cookie", setCookie(SESSION_COOKIE, session, Math.floor(SESSION_TTL_MS / 1000)), { append: true });
    return c.redirect(st.next, 302);
  });

  v.post("/logout", async (c) => {
    noStore(c);
    // SameSite=Lax already keeps other sites' forms out; the Origin check is the second lock.
    if (c.req.header("origin") !== new URL(c.env.PUBLIC_BASE_URL).origin) throw new HttpError(403, "Sign-out must be started from this site.");
    const token = c.get("viewer")?.accessToken;
    await deleteSession(c.env, readCookie(c.req.header("cookie"), SESSION_COOKIE));
    if (token && authConfigured(c.env)) await revokeToken(c.env, deps, token);
    c.header("Set-Cookie", setCookie(SESSION_COOKIE, "", 0));
    return c.redirect("/", 303);
  });
}
