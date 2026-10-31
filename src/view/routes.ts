import type { Context, Hono } from "hono";
import { HttpError } from "../http";
import { SESSION_COOKIE, loadSession, readCookie, userCanSee, type AuthDeps, type Session } from "../session";
import { checkRepoVisibility, visStale } from "../visibility";
import { ACCESS_CACHE_MS } from "../session";
import { CSS, FONT_MONO_URL, FONT_SANS_URL, LINE_JS, UI_JS, fontMono, fontSans } from "./assets";
import { badge } from "./badge";
import { allowedRepoIds, findRepo, homeRows, runById, type Repo } from "./data";
import { authHtml, mountAuth, type NavRepo, type V } from "./login";
import { page, CSP, enc, html, type Raw } from "./html";
import { NotFound, commitPage, coveragePage, filePage, homePage, navOf, prPage, repoPage, runTestsPage, sidebar, summarize, testPage } from "./pages";

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

/**
 * The left nav lists the projects the viewer may open without asking GitHub: public (recently confirmed) ones, plus the
 * ones the signed-in user was allowed to see within the access cache window. Never makes a GitHub call.
 */
async function navFor(c: Context, now: number): Promise<NavRepo[]> {
  try {
    const viewer = viewerOf(c);
    const [rows, allowed] = await Promise.all([
      homeRows(c.env),
      viewer ? allowedRepoIds(c.env, viewer.userId, now - ACCESS_CACHE_MS) : Promise.resolve(new Set<number>()),
    ]);
    return navOf(summarize(rows).filter((s) => (s.visibility === "public" && !visStale(s, now)) || allowed.has(s.repo_id)));
  } catch (e) {
    console.error("nav", e);
    return [];
  }
}

interface SendOpts {
  status?: number;
  /** the nav list when the page already computed it (home) */
  nav?: NavRepo[];
  current?: { owner: string; name: string } | "home" | null;
  now: number;
}

async function sendHtml(c: Context, body: Raw, o: SendOpts) {
  secure(c);
  c.header("Cache-Control", "private, no-cache");
  const text = body.toString();
  // page() leaves two markers: the sign-in button / user menu and the project list depend on the request, so they are filled in here
  const side = text.includes("<!--sidebar-->") ? sidebar(o.nav ?? (await navFor(c, o.now)), o.current ?? null).toString() : "";
  return c.html(text.replace("<!--auth-->", () => authHtml(viewerOf(c), here(c)).toString()).replace("<!--sidebar-->", () => side), (o.status ?? 200) as 200);
}

const TITLES: Record<number, string> = { 400: "Sign-in problem", 403: "Not allowed", 404: "Not found", 503: "Not available" };

export function errorPage(status: number, msg: string, signIn: Raw | null = null): Raw {
  const title = TITLES[status] ?? "Something went wrong";
  return page(title, html`<div class="err"><div class="code">${String(status)}</div><h1>${title}</h1><p class="muted">${msg}</p><p class="acts">${signIn ?? ""}<a class="btn" href="/">All projects</a></p></div>`);
}

export function viewerErrors(c: Context, err: unknown, now: number = Date.now()) {
  if (err instanceof NotFound) return sendHtml(c, errorPage(404, err.message || "That page does not exist.", viewerOf(c) ? null : html`<a class="btn signin" href="/login?next=${enc(here(c))}">Sign in with GitHub</a>`), { status: 404, now });
  if (err instanceof HttpError) {
    const known = err.status in TITLES;
    return sendHtml(c, errorPage(known ? err.status : 500, known ? err.message : "Something went wrong. Try again in a moment."), { status: known ? err.status : err.status >= 500 ? 502 : 500, now });
  }
  console.error("unhandled", err);
  return sendHtml(c, errorPage(500, "The page could not be built. Try again in a moment."), { status: 500, now });
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

  /** a public repo is only trusted while GitHub confirmed it recently; an older mark is re-checked first (and the cron does it too) */
  const fresh = (c: Context<V>, repo: Repo) => repo.visibility !== "public" || !visStale(repo, deps.now());

  /**
   * "yes": public (and recently confirmed), or the signed-in user's own GitHub token gets in. "no": looks exactly like
   * an unknown repo. "retry": GitHub is rate limiting us or cannot confirm a stale public mark right now.
   */
  const access = async (c: Context<V>, repo: Repo): Promise<"yes" | "no" | "retry"> => {
    let unverified = false;
    if (!fresh(c, repo)) unverified = (await checkRepoVisibility(c.env, deps, repo)) === null;
    if (repo.visibility === "public" && !unverified) return "yes";
    const s = viewerOf(c);
    if (s !== null) return userCanSee(c.env, deps, s, repo.repo_id);
    return unverified ? "retry" : "no";
  };
  const gate = async (c: Context<V>, owner: string, name: string): Promise<Repo> => {
    const repo = await findRepo(c.env, owner, name);
    if (!repo) throw new NotFound(HIDDEN);
    const a = await access(c, repo);
    if (a === "retry") throw new HttpError(503, "GitHub is busy and could not confirm who may see this project. Please try again in a minute.");
    if (a === "no") throw new NotFound(HIDDEN);
    return repo;
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
  v.get("/assets/ui.js", (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "public, max-age=300");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(UI_JS);
  });
  // the file names carry the font version, so these never change under one URL
  for (const [url, bytes] of [[FONT_SANS_URL, fontSans], [FONT_MONO_URL, fontMono]] as const) {
    v.get(url, (c) => {
      c.header("Content-Type", "font/woff2");
      c.header("Cache-Control", "public, max-age=31536000, immutable");
      c.header("X-Content-Type-Options", "nosniff");
      return c.body(bytes().slice().buffer as ArrayBuffer);
    });
  }

  v.get("/badge/:owner/:repo/:file", async (c) => {
    const m = /^([A-Za-z0-9._-]{1,100})\.svg$/.exec(c.req.param("file"));
    if (!m) return c.text("not found", 404);
    const svg = await badge(c.env, c.req.param("owner"), c.req.param("repo"), m[1]!, c.req.query("branch") ?? null);
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    c.header("Cache-Control", "public, max-age=120");
    secure(c, "default-src 'none'; style-src 'unsafe-inline'");
    return c.body(svg);
  });

  v.get("/", async (c) => {
    const now = deps.now();
    const h = await homePage(c.env, await homeRows(c.env), { free: (r) => r.visibility === "public" && fresh(c, r), check: async (r) => (await access(c, r)) === "yes" }, now);
    return sendHtml(c, h.page, { nav: h.nav, current: "home", now });
  });

  v.get("/:owner/:repo/run/:id/raw/:name", async (c) => {
    const { owner, repo, id, name } = c.req.param();
    if (!NAME_RE.test(name) || !/^\d{1,15}$/.test(id)) throw new NotFound("No such file.");
    const r = await gate(c, owner, repo);
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
    const repo = await gate(c, c.req.param("owner"), c.req.param("repo"));
    if (!/^\d{1,15}$/.test(id)) throw new NotFound("No such run.");
    return sendHtml(c, await runTestsPage(c.env, repo, Number(id), c.req.query("status") ?? null), { current: repo, now: deps.now() });
  });

  v.get("/:owner/:repo/commit/:sha/coverage", async (c) => {
    const repo = await gate(c, c.req.param("owner"), c.req.param("repo"));
    const sha = guardSha(c.req.param("sha"));
    return sendHtml(c, await coveragePage(c.env, repo, sha, c.req.query("flag") ?? null, c.req.query("sort") ?? null), { current: repo, now: deps.now() });
  });
  v.get("/:owner/:repo/commit/:sha/file", async (c) => {
    const repo = await gate(c, c.req.param("owner"), c.req.param("repo"));
    const sha = guardSha(c.req.param("sha"));
    return sendHtml(c, await filePage(c.env, repo, sha, c.req.query("path") ?? null, c.req.query("flag") ?? null), { current: repo, now: deps.now() });
  });
  v.get("/:owner/:repo/commit/:sha", async (c) => {
    const repo = await gate(c, c.req.param("owner"), c.req.param("repo"));
    const sha = guardSha(c.req.param("sha"));
    const now = deps.now();
    return sendHtml(c, await commitPage(c.env, repo, sha, now), { current: repo, now });
  });
  v.get("/:owner/:repo/pull/:n", async (c) => {
    const repo = await gate(c, c.req.param("owner"), c.req.param("repo"));
    const n = c.req.param("n");
    if (!/^\d{1,9}$/.test(n)) throw new NotFound("That pull request number does not look right.");
    const now = deps.now();
    return sendHtml(c, await prPage(c.env, repo, Number(n), now), { current: repo, now });
  });
  v.get("/:owner/:repo/test/:id", async (c) => {
    const repo = await gate(c, c.req.param("owner"), c.req.param("repo"));
    return sendHtml(c, await testPage(c.env, repo, c.req.param("id"), c.req.query("branch") ?? null), { current: repo, now: deps.now() });
  });
  v.get("/:owner/:repo", async (c) => {
    const repo = await gate(c, c.req.param("owner"), c.req.param("repo"));
    const now = deps.now();
    return sendHtml(c, await repoPage(c.env, repo, c.req.query("branch") ?? null, now), { current: repo, now });
  });
}

