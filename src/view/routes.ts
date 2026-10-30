import type { Context, Hono } from "hono";
import { HttpError } from "../http";
import { SESSION_COOKIE, loadSession, readCookie, userCanSee, type AuthDeps, type Session } from "../session";
import { CSS, LINE_JS } from "./assets";
import { badge } from "./badge";
import { findRepo, runById, type Repo } from "./data";
import { authHtml, mountAuth, type V } from "./login";
import { page, CSP, enc, html, type Raw } from "./html";
import { NotFound, commitPage, coveragePage, filePage, homePage, prPage, repoPage, runTestsPage, testPage } from "./pages";

const SHA_RE = /^[0-9a-f]{40}$/i;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

const secure = (c: Context, csp = CSP) => {
  c.header("Content-Security-Policy", csp);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
};

const viewerOf = (c: Context): Session | null => (c as Context<V>).var?.viewer ?? null;

const here = (c: Context) => {
  const u = new URL(c.req.url);
  return u.pathname + u.search;
};

function sendHtml(c: Context, body: Raw, status: number = 200) {
  secure(c);
  c.header("Cache-Control", "private, no-cache");
  // page() leaves a marker in the header; the sign-in button / user menu depends on the request, so it is filled in here
  return c.html(body.toString().replace("<!--auth-->", () => authHtml(viewerOf(c), here(c)).toString()), status as 200);
}

const TITLES: Record<number, string> = { 400: "Sign-in problem", 403: "Not allowed", 404: "Not found", 503: "Not available" };

export function errorPage(status: number, msg: string, signIn: Raw | null = null): Raw {
  const title = TITLES[status] ?? "Something went wrong";
  return page(title, html`<h1>${title}</h1><p class="empty">${msg}</p><p>${signIn ?? ""} <a class="btn" href="/">All projects</a></p>`);
}

export function viewerErrors(c: Context, err: unknown) {
  if (err instanceof NotFound) return sendHtml(c, errorPage(404, err.message || "That page does not exist.", viewerOf(c) ? null : html`<a class="btn signin" href="/login?next=${enc(here(c))}">Sign in with GitHub</a>`), 404);
  if (err instanceof HttpError) {
    const known = err.status in TITLES;
    return sendHtml(c, errorPage(known ? err.status : 500, known ? err.message : "Something went wrong. Try again in a moment."), known ? err.status : err.status >= 500 ? 502 : 500);
  }
  console.error("unhandled", err);
  return sendHtml(c, errorPage(500, "The page could not be built. Try again in a moment."), 500);
}

const guardSha = (sha: string) => {
  if (!SHA_RE.test(sha)) throw new NotFound("That commit id does not look right (use the full 40-character id).");
  return sha.toLowerCase();
};

// Not a viewer page: API (own auth), health check, static files and badges (public by design).
const noViewer = (path: string) => path === "/healthz" || path.startsWith("/api/") || path.startsWith("/assets/") || /^\/badge\/[^/]+\/[^/]+\/[^/]+$/.test(path);

const HIDDEN = "We could not find that project. If it is private, sign in with a GitHub account that can see it.";

export function mountViewer(app: Hono<any>, deps: AuthDeps) {
  const v = app as unknown as Hono<V>;

  v.use("*", async (c, next) => {
    if (!noViewer(c.req.path)) c.set("viewer", await loadSession(c.env, deps, readCookie(c.req.header("cookie"), SESSION_COOKIE)));
    await next();
  });

  /** public repo: anyone. Private: only a signed-in user GitHub lets in. Everything else looks exactly like an unknown repo. */
  const canSee = (c: Context<V>) => async (repo: Pick<Repo, "repo_id" | "visibility">) => {
    if (repo.visibility === "public") return true;
    const s = viewerOf(c);
    return s !== null && (await userCanSee(c.env, deps, s, repo.repo_id));
  };
  const gate = async (c: Context<V>, owner: string, name: string): Promise<void> => {
    const repo = await findRepo(c.env, owner, name);
    if (!repo || !(await canSee(c)(repo))) throw new NotFound(HIDDEN);
  };

  mountAuth(v, deps);

  v.get("/assets/app.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    c.header("Cache-Control", "public, max-age=300");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(CSS);
  });
  v.get("/assets/line.js", (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "public, max-age=300");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(LINE_JS);
  });

  v.get("/badge/:owner/:repo/:file", async (c) => {
    const m = /^([A-Za-z0-9._-]{1,100})\.svg$/.exec(c.req.param("file"));
    if (!m) return c.text("not found", 404);
    const svg = await badge(c.env, c.req.param("owner"), c.req.param("repo"), m[1]!, c.req.query("branch") ?? null);
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    c.header("Cache-Control", "public, max-age=120");
    secure(c, "default-src 'none'; style-src 'unsafe-inline'");
    return c.body(svg);
  });

  v.get("/", async (c) => sendHtml(c, await homePage(c.env, canSee(c))));

  v.get("/:owner/:repo/run/:id/raw/:name", async (c) => {
    const { owner, repo, id, name } = c.req.param();
    if (!NAME_RE.test(name) || !/^\d{1,15}$/.test(id)) throw new NotFound("No such file.");
    await gate(c, owner, repo);
    const r = (await findRepo(c.env, owner, repo))!;
    const run = await runById(c.env, r.repo_id, Number(id));
    if (!run) throw new NotFound("Unknown run.");
    const obj = await c.env.BUCKET.get(`raw/${run.repo_id}/${run.sha}/${run.gh_run_id}-${run.gh_run_attempt}/${run.flag}/${name}.gz`);
    if (!obj) throw new NotFound("That file has expired or was never uploaded.");
    const bytes = new Uint8Array(await obj.arrayBuffer());
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new NotFound("That file is not readable (it was not uploaded as gzip).");
    secure(c, "default-src 'none'; sandbox");
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${name}"`);
    c.header("Cache-Control", "private, no-cache");
    return c.body(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")) as ReadableStream);
  });

  v.get("/:owner/:repo/run/:id/tests", async (c) => {
    const id = c.req.param("id");
    await gate(c, c.req.param("owner"), c.req.param("repo"));
    if (!/^\d{1,15}$/.test(id)) throw new NotFound("No such run.");
    return sendHtml(c, await runTestsPage(c.env, c.req.param("owner"), c.req.param("repo"), Number(id)));
  });

  v.get("/:owner/:repo/commit/:sha/coverage", async (c) => {
    await gate(c, c.req.param("owner"), c.req.param("repo"));
    const sha = guardSha(c.req.param("sha"));
    return sendHtml(c, await coveragePage(c.env, c.req.param("owner"), c.req.param("repo"), sha, c.req.query("flag") ?? null, c.req.query("sort") ?? null));
  });
  v.get("/:owner/:repo/commit/:sha/file", async (c) => {
    await gate(c, c.req.param("owner"), c.req.param("repo"));
    const sha = guardSha(c.req.param("sha"));
    return sendHtml(c, await filePage(c.env, c.req.param("owner"), c.req.param("repo"), sha, c.req.query("path") ?? null, c.req.query("flag") ?? null));
  });
  v.get("/:owner/:repo/commit/:sha", async (c) => {
    await gate(c, c.req.param("owner"), c.req.param("repo"));
    const sha = guardSha(c.req.param("sha"));
    return sendHtml(c, await commitPage(c.env, c.req.param("owner"), c.req.param("repo"), sha));
  });
  v.get("/:owner/:repo/pull/:n", async (c) => {
    await gate(c, c.req.param("owner"), c.req.param("repo"));
    const n = c.req.param("n");
    if (!/^\d{1,9}$/.test(n)) throw new NotFound("That pull request number does not look right.");
    return sendHtml(c, await prPage(c.env, c.req.param("owner"), c.req.param("repo"), Number(n)));
  });
  v.get("/:owner/:repo/test/:id", async (c) => (await gate(c, c.req.param("owner"), c.req.param("repo")), sendHtml(c, await testPage(c.env, c.req.param("owner"), c.req.param("repo"), c.req.param("id"), c.req.query("branch") ?? null))));
  v.get("/:owner/:repo", async (c) => {
    await gate(c, c.req.param("owner"), c.req.param("repo"));
    return sendHtml(c, await repoPage(c.env, c.req.param("owner"), c.req.param("repo"), c.req.query("branch") ?? null));
  });
}

