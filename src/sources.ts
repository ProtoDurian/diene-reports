import type { Identity } from "./auth";
import { LIMITS, type Env } from "./env";
import { HttpError, gitBlobSha, gunzipCapped, readCapped } from "./http";
import { guard } from "./db";
import { SHA_RE } from "./summary";

export async function checkSources(env: Env, id: Identity, body: unknown, now: number): Promise<{ missing: string[] }> {
  const blobs = (body as { blobs?: unknown } | null)?.blobs;
  if (!Array.isArray(blobs)) throw new HttpError(400, "blobs: expected array");
  if (blobs.length > LIMITS.sourceCheck) throw new HttpError(400, `blobs: max ${LIMITS.sourceCheck}`);
  for (const b of blobs) if (typeof b !== "string" || !SHA_RE.test(b)) throw new HttpError(400, "blobs: expected git blob sha1 strings");
  await guard(env.DB, id, "s", now);
  const list = [...new Set(blobs as string[])];
  if (list.length === 0) return { missing: [] };
  const json = JSON.stringify(list);
  const [have] = await env.DB.batch([
    env.DB
      .prepare(`SELECT blob_sha FROM blobs WHERE repo_id = ?1 AND blob_sha IN (SELECT value FROM json_each(?2))`)
      .bind(id.repoId, json),
    env.DB
      .prepare(`UPDATE blobs SET last_ref_at = ?3 WHERE repo_id = ?1 AND blob_sha IN (SELECT value FROM json_each(?2))`)
      .bind(id.repoId, json, now),
  ]);
  const present = new Set((have!.results as { blob_sha: string }[]).map((r) => r.blob_sha));
  return { missing: list.filter((b) => !present.has(b)) };
}

/** returns true when stored, false when it already existed */
export async function putSource(env: Env, id: Identity, req: Request, blobSha: string, now: number): Promise<boolean> {
  if (!SHA_RE.test(blobSha)) throw new HttpError(400, "invalid blob sha");
  await guard(env.DB, id, "s", now);
  const known = await env.DB
    .prepare(`UPDATE blobs SET last_ref_at = ?3 WHERE repo_id = ?1 AND blob_sha = ?2 RETURNING blob_sha`)
    .bind(id.repoId, blobSha, now)
    .first();
  if (known) return false;
  const gz = await readCapped(req, LIMITS.sourceGzip);
  if (gz.byteLength === 0) throw new HttpError(400, "empty body");
  const raw = await gunzipCapped(gz, LIMITS.sourceBytes);
  if ((await gitBlobSha(raw)) !== blobSha) throw new HttpError(400, "blob sha does not match content");
  await env.BUCKET.put(`src/${id.repoId}/${blobSha}`, gz, { httpMetadata: { contentType: "application/gzip" } });
  await env.DB
    .prepare(
      `INSERT INTO blobs (repo_id, blob_sha, bytes, last_ref_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (repo_id, blob_sha) DO UPDATE SET last_ref_at = excluded.last_ref_at`,
    )
    .bind(id.repoId, blobSha, raw.byteLength, now)
    .run();
  return true;
}

