import { DAY, type Env } from "./env";
import { sweepLost } from "./runs";

export const CRON_SWEEP = "*/15 * * * *";
export const CRON_GC = "17 3 * * *";

export const SRC_TTL_DAYS = 90;
export const ROW_TTL_DAYS = 180;

export async function gc(env: Env, now: number): Promise<{ blobs: number; runs: number }> {
  const db = env.DB;
  let blobs = 0;
  for (let i = 0; i < 20; i++) {
    // Delete the rows first (atomically re-checking staleness), then only the R2 objects of the rows that really went.
    const gone = await db
      .prepare(
        `DELETE FROM blobs WHERE (repo_id, blob_sha) IN (
           SELECT b.repo_id, b.blob_sha FROM blobs b
           WHERE b.last_ref_at < ?1
             AND NOT EXISTS (SELECT 1 FROM keep_blobs k WHERE k.repo_id = b.repo_id AND k.blob_sha = b.blob_sha)
           LIMIT 500)
         AND last_ref_at < ?1
         RETURNING repo_id, blob_sha`,
      )
      .bind(now - SRC_TTL_DAYS * DAY)
      .all<{ repo_id: number; blob_sha: string }>();
    if (gone.results.length === 0) break;
    await env.BUCKET.delete(gone.results.map((r) => `src/${r.repo_id}/${r.blob_sha}`));
    blobs += gone.results.length;
  }

  const cutoff = now - ROW_TTL_DAYS * DAY;
  const old = `SELECT id FROM runs WHERE created_at < ?1 AND id NOT IN (SELECT run_id FROM branch_head)
    AND id NOT IN (SELECT cov_run_id FROM branch_head WHERE cov_run_id IS NOT NULL)`;
  const counted = await db.prepare(`SELECT COUNT(*) AS n FROM (${old})`).bind(cutoff).first<{ n: number }>();
  await db.batch([
    db.prepare(`DELETE FROM failures WHERE run_id IN (${old})`).bind(cutoff),
    db.prepare(`DELETE FROM runs WHERE id IN (${old})`).bind(cutoff),
    db
      .prepare(
        `DELETE FROM commits WHERE created_at < ?1
           AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.repo_id = commits.repo_id AND r.sha = commits.sha)`,
      )
      .bind(cutoff),
    db.prepare(`DELETE FROM test_stats WHERE updated_at < ?1`).bind(cutoff),
    db.prepare(`DELETE FROM rate WHERE created_at < ?1`).bind(now - 2 * DAY),
  ]);
  return { blobs, runs: counted?.n ?? 0 };
}

export async function runCron(env: Env, cron: string, now = Date.now()): Promise<unknown> {
  if (cron === CRON_GC) return gc(env, now);
  return { lost: await sweepLost(env.DB, now) };
}
