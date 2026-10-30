import type { Identity } from "./auth";
import { HttpError } from "./http";
import { LIMITS } from "./env";

/** Count one write for a test job (repo, gh run, attempt, flag, job); throws 429 past the cap. */
export async function guard(db: D1Database, id: Identity, flag: string, job: string, now: number): Promise<void> {
  const row = await db
    .prepare(
      `INSERT INTO rate (repo_id, gh_run_id, attempt, flag, job, n, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
       ON CONFLICT (repo_id, gh_run_id, attempt, flag, job) DO UPDATE SET n = n + 1
       RETURNING n`,
    )
    .bind(id.repoId, id.runId, id.runAttempt, flag, job, now)
    .first<{ n: number }>();
  if (!row || row.n > LIMITS.writesPerJob) throw new HttpError(429, "rate limit exceeded for this job");
}

export function upsertRepo(db: D1Database, id: Identity, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO repos (repo_id, owner, name, visibility, created_at, updated_at, vis_checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5)
       ON CONFLICT (repo_id) DO UPDATE SET owner = excluded.owner, name = excluded.name,
         visibility = excluded.visibility, updated_at = excluded.updated_at, vis_checked_at = excluded.vis_checked_at`,
    )
    .bind(id.repoId, id.owner, id.name, id.visibility, now);
}

export function ensureProject(db: D1Database, repoId: number, branch: string, now: number): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO projects (repo_id, branch, created_at) VALUES (?1, ?2, ?3)`).bind(repoId, branch, now);
}

export function selectProject(db: D1Database, repoId: number, branch: string): D1PreparedStatement {
  return db.prepare(`SELECT project_id FROM projects WHERE repo_id = ?1 AND branch = ?2`).bind(repoId, branch);
}

export function upsertCommit(
  db: D1Database,
  id: Identity,
  c: { headSha: string; branch: string; pr: number | null; baseSha: string | null; baseRef: string | null },
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO commits (repo_id, sha, head_sha, branch, pr, base_sha, base_ref, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (repo_id, sha) DO UPDATE SET head_sha = excluded.head_sha,
         pr = COALESCE(excluded.pr, commits.pr),
         base_sha = COALESCE(excluded.base_sha, commits.base_sha),
         base_ref = COALESCE(excluded.base_ref, commits.base_ref)`,
    )
    .bind(id.repoId, id.sha, c.headSha, c.branch, c.pr, c.baseSha, c.baseRef, now);
}

export interface RunKey {
  repoId: number;
  ghRunId: number;
  attempt: number;
  flag: string;
  job: string;
}
