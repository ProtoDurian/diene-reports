import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { HttpError } from "../http";
import { CSS, LINE_JS } from "./assets";
import { badge } from "./badge";
import { findRepo, runById } from "./data";
import { page, CSP, html, type Raw } from "./html";
import { NotFound, commitPage, coveragePage, filePage, homePage, prPage, repoPage, runTestsPage, testPage } from "./pages";

type V = { Bindings: Env };

const SHA_RE = /^[0-9a-f]{40}$/i;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

const secure = (c: Context, csp = CSP) => {
  c.header("Content-Security-Policy", csp);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
};

function sendHtml(c: Context, body: Raw, status: 200 | 404 | 500 = 200) {
  secure(c);
  c.header("Cache-Control", "private, no-cache");
  return c.html(body.toString(), status);
}

export function errorPage(status: 404 | 500, msg: string): Raw {
  return page(status === 404 ? "Not found" : "Error", html`<h1>${status === 404 ? "Not found" : "Something went wrong"}</h1><p class="empty">${msg}</p><p><a class="btn" href="/">All projects</a></p>`);
}

export function viewerErrors(c: Context, err: unknown) {
  if (err instanceof NotFound) return sendHtml(c, errorPage(404, err.message || "That page does not exist."), 404);
  if (err instanceof HttpError) return sendHtml(c, errorPage(err.status === 404 ? 404 : 500, err.message), err.status === 404 ? 404 : 500);
  console.error("unhandled", err);
  return sendHtml(c, errorPage(500, "The page could not be built. Try again in a moment."), 500);
}

const guardSha = (sha: string) => {
  if (!SHA_RE.test(sha)) throw new NotFound("That commit id does not look right (use the full 40-character id).");
  return sha.toLowerCase();
};

export function mountViewer(app: Hono<any>, guard: MiddlewareHandler<V>) {
  const v = app as unknown as Hono<V>;
  v.use("*", guard);

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

  v.get("/", async (c) => sendHtml(c, await homePage(c.env)));

  v.get("/:owner/:repo/run/:id/raw/:name", async (c) => {
    const { owner, repo, id, name } = c.req.param();
    if (!NAME_RE.test(name) || !/^\d{1,15}$/.test(id)) throw new NotFound("No such file.");
    const r = await findRepo(c.env, owner, repo);
    if (!r) throw new NotFound("Unknown project.");
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
    if (!/^\d{1,15}$/.test(id)) throw new NotFound("No such run.");
    return sendHtml(c, await runTestsPage(c.env, c.req.param("owner"), c.req.param("repo"), Number(id)));
  });

  v.get("/:owner/:repo/commit/:sha/coverage", async (c) => {
    const sha = guardSha(c.req.param("sha"));
    return sendHtml(c, await coveragePage(c.env, c.req.param("owner"), c.req.param("repo"), sha, c.req.query("flag") ?? null, c.req.query("sort") ?? null));
  });
  v.get("/:owner/:repo/commit/:sha/file", async (c) => {
    const sha = guardSha(c.req.param("sha"));
    return sendHtml(c, await filePage(c.env, c.req.param("owner"), c.req.param("repo"), sha, c.req.query("path") ?? null, c.req.query("flag") ?? null));
  });
  v.get("/:owner/:repo/commit/:sha", async (c) => {
    const sha = guardSha(c.req.param("sha"));
    return sendHtml(c, await commitPage(c.env, c.req.param("owner"), c.req.param("repo"), sha));
  });
  v.get("/:owner/:repo/pull/:n", async (c) => {
    const n = c.req.param("n");
    if (!/^\d{1,9}$/.test(n)) throw new NotFound("That pull request number does not look right.");
    return sendHtml(c, await prPage(c.env, c.req.param("owner"), c.req.param("repo"), Number(n)));
  });
  v.get("/:owner/:repo/test/:id", async (c) => sendHtml(c, await testPage(c.env, c.req.param("owner"), c.req.param("repo"), c.req.param("id"), c.req.query("branch") ?? null)));
  v.get("/:owner/:repo", async (c) => sendHtml(c, await repoPage(c.env, c.req.param("owner"), c.req.param("repo"), c.req.query("branch") ?? null)));
}

