import { HttpError } from "./http";
import { HOUR, LIMITS, type Env } from "./env";
import type { Identity } from "./auth";
import { dropToken, installationAuth } from "./githubapp";
import type { AuthDeps } from "./session";

/** a public-marked repo whose visibility was confirmed longer ago than this is re-checked before it is served */
export const VIS_FRESH_MS = 6 * HOUR;
/** repos re-checked per cron run (oldest first); each costs one subrequest (plus a few per owner for the installation and its token) */
export const VIS_BATCH = 200;

export interface RepoVis {
  repo_id: number;
  owner: string;
  name: string;
  visibility: string;
  vis_checked_at: number;
}

export const visStale = (r: Pick<RepoVis, "vis_checked_at">, now: number) => now - r.vis_checked_at > VIS_FRESH_MS;

/**
 * Ask GitHub what the repo is now: as the App's installation on the owner (an installation token, see githubapp.ts), or
 * unauthenticated when the App is not configured / not installed on that owner (public repos only; 60 requests/hour per IP).
 * 200: store its visibility (and a new owner/name after a rename). 404: store 'private' (fail closed).
 * Anything else (401, 403, 429, 5xx, network): null, nothing stored; the viewer then fails closed for stale public repos.
 */
export async function checkRepoVisibility(env: Env, deps: AuthDeps, repo: RepoVis): Promise<"public" | "private" | "internal" | null> {
  const auth = await installationAuth(env, deps, repo.owner);
  if (!auth) return null;
  const now = deps.now();
  let visibility: "public" | "private" | "internal";
  let owner = repo.owner;
  let name = repo.name;
  try {
    const res = await deps.fetch(`https://api.github.com/repositories/${repo.repo_id}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "diene-reports",
        "x-github-api-version": "2022-11-28",
        ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
      },
    });
    if (res.status === 200) {
      const b = (await res.json()) as { visibility?: unknown; private?: unknown; full_name?: unknown };
      visibility = b.visibility === "public" || b.visibility === "private" || b.visibility === "internal" ? b.visibility : b.private === false ? "public" : "private";
      const m = typeof b.full_name === "string" ? /^([^/]+)\/([^/]+)$/.exec(b.full_name) : null;
      if (m) [, owner, name] = m as unknown as [string, string, string];
    } else if (res.status === 404) {
      visibility = "private";
    } else {
      if (res.status === 401 && auth.installationId !== null) dropToken(auth.installationId); // revoked early: mint a new one next time
      console.warn("visibility check: unexpected status", repo.repo_id, res.status, auth.token ? "(installation token)" : "(unauthenticated)");
      return null;
    }
  } catch (e) {
    console.warn("visibility check failed", repo.repo_id, String(e));
    return null;
  }
  await env.DB
    .prepare(`UPDATE repos SET visibility = ?2, owner = ?3, name = ?4, vis_checked_at = ?5 WHERE repo_id = ?1`)
    .bind(repo.repo_id, visibility, owner, name, now)
    .run();
  repo.visibility = visibility;
  repo.owner = owner;
  repo.name = name;
  repo.vis_checked_at = now;
  return visibility;
}

/** cron: re-check the repos whose visibility was confirmed longest ago */
export async function sweepVisibility(env: Env, deps: AuthDeps): Promise<{ checked: number; changed: number; skipped: number }> {
  const rows = await env.DB
    .prepare(`SELECT repo_id, owner, name, visibility, vis_checked_at FROM repos ORDER BY vis_checked_at ASC LIMIT ?1`)
    .bind(VIS_BATCH)
    .all<RepoVis>();
  let checked = 0;
  let changed = 0;
  let skipped = 0;
  const queue = [...rows.results];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const before = `${r.visibility}/${r.owner}/${r.name}`;
      const v = await checkRepoVisibility(env, deps, r);
      if (v === null) skipped++;
      else {
        checked++;
        if (before !== `${r.visibility}/${r.owner}/${r.name}`) changed++;
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { checked, changed, skipped };
}

export const VIS_REPORT_SCHEMA = "diene-visibility/v1";
export const VIS_REPORTERS_DEFAULT = "ProtoDurian/diene-reports";
export const VIS_REPORT_EVENTS = ["schedule", "workflow_dispatch"];

export interface VisibilityReport {
  owner: string;
  complete: boolean;
  /** [repo_id, name] */
  pub: [number, string][];
}

/** The relay workflow lists the owner's public repos with its own GITHUB_TOKEN and posts them; no Worker-side GitHub call, no App key. */
export function parseVisibilityReport(doc: unknown): VisibilityReport {
  const bad = (m: string) => new HttpError(400, `invalid visibility report: ${m}`);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw bad("not an object");
  const d = doc as Record<string, unknown>;
  if (d.schema !== VIS_REPORT_SCHEMA) throw bad("schema");
  if (typeof d.owner !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(d.owner)) throw bad("owner");
  if (typeof d.complete !== "boolean") throw bad("complete");
  if (!Array.isArray(d.public)) throw bad("public");
  if (d.public.length > LIMITS.visibilityRepos) throw bad("too many entries");
  const seen = new Set<number>();
  const pub: [number, string][] = [];
  for (const e of d.public) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) throw bad("entry");
    const { id, full_name } = e as Record<string, unknown>;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw bad("entry id");
    const m = typeof full_name === "string" ? /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(full_name) : null;
    if (!m || m[1]!.toLowerCase() !== d.owner.toLowerCase()) throw bad("entry full_name");
    if (seen.has(id)) continue;
    seen.add(id);
    pub.push([id, m[2]!]);
  }
  return { owner: d.owner, complete: d.complete, pub };
}

/** repository allowed to report: listed in VISIBILITY_REPORTERS (default VIS_REPORTERS_DEFAULT), on main, from a scheduled or manual run */
export function mayReportVisibility(env: Pick<Env, "VISIBILITY_REPORTERS">, id: Identity): boolean {
  const list = (env.VISIBILITY_REPORTERS?.trim() ? env.VISIBILITY_REPORTERS : VIS_REPORTERS_DEFAULT)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(id.repository.toLowerCase()) && id.ref === "refs/heads/main" && VIS_REPORT_EVENTS.includes(id.event);
}

/**
 * Apply a relay report to every repo of `report.owner`: listed → public (+ the new name after a rename); not listed and complete → private.
 * Rows only get vis_checked_at = now when the report decided them. One atomic D1 batch of four statements.
 */
export async function applyVisibilityReport(env: Env, report: VisibilityReport, now: number): Promise<{ updated: number; madePublic: number; madePrivate: number }> {
  const list = JSON.stringify(report.pub);
  const mine = `lower(owner) = lower(?1)`;
  const listed = `repo_id IN (SELECT json_extract(value, '$[0]') FROM json_each(?2))`;
  const db = env.DB;
  const [pubCount, privCount, setPublic, setPrivate] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM repos WHERE ${mine} AND visibility != 'public' AND ${listed}`).bind(report.owner, list),
    db.prepare(`SELECT COUNT(*) AS n FROM repos WHERE ${mine} AND visibility != 'private' AND NOT ${listed} AND ?3 = 1`).bind(report.owner, list, report.complete ? 1 : 0),
    db
      .prepare(
        `UPDATE repos SET visibility = 'public', owner = ?1, name = j.name, vis_checked_at = ?3
         FROM (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS name FROM json_each(?2)) AS j
         WHERE repos.repo_id = j.id AND lower(repos.owner) = lower(?1)`,
      )
      .bind(report.owner, list, now),
    db
      .prepare(`UPDATE repos SET visibility = 'private', vis_checked_at = ?3 WHERE ${mine} AND NOT ${listed} AND ?4 = 1`)
      .bind(report.owner, list, now, report.complete ? 1 : 0),
  ]);
  const n = (r: D1Result) => (r.results[0] as { n: number }).n;
  return { updated: setPublic!.meta.changes + setPrivate!.meta.changes, madePublic: n(pubCount!), madePrivate: n(privCount!) };
}
