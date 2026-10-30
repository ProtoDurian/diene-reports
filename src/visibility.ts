import { HOUR, type Env } from "./env";
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
