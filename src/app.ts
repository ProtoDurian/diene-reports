import { Hono } from "hono";
import { JwksCache, fetchGithubJwks, verifyToken, type Identity, type JwksProvider } from "./auth";
import { runCron } from "./cron";
import { LIMITS, type Env } from "./env";
import { HttpError, putBody, readCapped, readJson } from "./http";
import { guard } from "./db";
import { finishRun, knownFailing, ownedRun, startRun } from "./runs";
import { attribution, checkSources, putSource } from "./sources";
import { parseFlag, parseStart, parseSummary } from "./summary";

export interface Deps {
  jwks: JwksProvider;
  now: () => number;
}

type App = { Bindings: Env; Variables: { id: Identity } };

let sharedJwks: JwksCache | null = null;
function defaultJwks(): JwksProvider {
  return (sharedJwks ??= new JwksCache(fetchGithubJwks, () => Date.now()));
}

export function buildApp(overrides: Partial<Deps> = {}) {
  const deps: Deps = { jwks: overrides.jwks ?? defaultJwks(), now: overrides.now ?? (() => Date.now()) };
  const app = new Hono<App>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    console.error("unhandled", err);
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.get("/healthz", (c) => c.json({ ok: true }));

  const api = new Hono<App>();
  api.use("*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!m) throw new HttpError(401, "missing bearer token");
    c.set("id", await verifyToken(m[1]!, deps, c.env));
    await next();
  });

  api.post("/runs/start", async (c) => {
    const body = parseStart(await readJson(c.req.raw, LIMITS.startBody));
    return c.json(await startRun(c.env, c.get("id"), body, deps.now()));
  });

  api.get("/runs/known-failing", async (c) => {
    const flag = parseFlag(c.req.query("flag"), "flag");
    return c.json({ ids: await knownFailing(c.env, c.get("id"), flag) });
  });

  api.post("/runs/finish", async (c) => {
    const bytes = await readCapped(c.req.raw, LIMITS.finishBody);
    let text: string;
    let doc: unknown;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      doc = JSON.parse(text);
    } catch {
      throw new HttpError(400, "body is not valid UTF-8 JSON");
    }
    const summary = parseSummary(doc);
    return c.json(await finishRun(c.env, c.get("id"), summary, text, deps.now()));
  });

  const runIdParam = (v: string): number => {
    if (!/^\d{1,15}$/.test(v)) throw new HttpError(400, "invalid run id");
    return Number(v);
  };

  api.put("/runs/:runId/report", async (c) => {
    const id = c.get("id");
    const run = await ownedRun(c.env, id, runIdParam(c.req.param("runId")));
    await guard(c.env.DB, id, run.flag, run.job, deps.now());
    const key = `rep/${run.repo_id}/${run.sha}/${run.flag}/${run.gh_run_id}-${run.gh_run_attempt}.json.gz`;
    await putBody(c.req.raw, c.env.BUCKET, key, LIMITS.report, "application/gzip");
    await c.env.DB.prepare(`UPDATE runs SET report_key = ?1 WHERE id = ?2`).bind(key, run.id).run();
    return c.json({ ok: true, key });
  });

  api.put("/runs/:runId/cov/:n", async (c) => {
    const id = c.get("id");
    const n = c.req.param("n");
    if (!/^\d{1,5}$/.test(n)) throw new HttpError(400, "invalid chunk index");
    const run = await ownedRun(c.env, id, runIdParam(c.req.param("runId")));
    await guard(c.env.DB, id, run.flag, run.job, deps.now());
    const key = `cov/${run.repo_id}/${run.sha}/${run.flag}/${run.gh_run_id}-${run.gh_run_attempt}/${Number(n)}.json.gz`;
    await putBody(c.req.raw, c.env.BUCKET, key, LIMITS.covChunk, "application/gzip");
    return c.json({ ok: true, key });
  });

  api.put("/runs/:runId/raw/:name", async (c) => {
    const id = c.get("id");
    const name = c.req.param("name");
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new HttpError(400, "invalid raw name");
    const run = await ownedRun(c.env, id, runIdParam(c.req.param("runId")));
    await guard(c.env.DB, id, run.flag, run.job, deps.now());
    const key = `raw/${run.repo_id}/${run.sha}/${run.gh_run_id}-${run.gh_run_attempt}/${run.flag}/${name}.gz`;
    await putBody(c.req.raw, c.env.BUCKET, key, LIMITS.raw, "application/gzip");
    return c.json({ ok: true, key });
  });

  api.post("/sources/check", async (c) => {
    const body = await readJson(c.req.raw, 2 * 1024 * 1024);
    return c.json(await checkSources(c.env, c.get("id"), body, attribution(c.req.query("flag"), c.req.query("job")), deps.now()));
  });

  api.put("/sources/:blobSha", async (c) => {
    const stored = await putSource(c.env, c.get("id"), c.req.raw, c.req.param("blobSha"), attribution(c.req.query("flag"), c.req.query("job")), deps.now());
    return stored ? c.json({ ok: true }) : c.body(null, 204);
  });

  app.route("/api/v1", api);
  return app;
}

export function scheduled(env: Env, cron: string, now = Date.now()) {
  return runCron(env, cron, now);
}
