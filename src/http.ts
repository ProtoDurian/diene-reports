
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function declaredLength(req: Request): number | null {
  const h = req.headers.get("content-length");
  if (h === null || !/^\d+$/.test(h)) return null;
  return Number(h);
}

export async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const len = declaredLength(req);
  if (len !== null && len > max) throw new HttpError(413, "body too large");
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "body too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function readJson(req: Request, max: number): Promise<unknown> {
  const bytes = await readCapped(req, max);
  if (bytes.byteLength === 0) throw new HttpError(400, "empty body");
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new HttpError(400, "body is not valid UTF-8 JSON");
  }
}

/** Stream a (gzip) request body to R2 without touching its contents. */
export async function putBody(req: Request, bucket: R2Bucket, key: string, max: number, contentType: string): Promise<number> {
  const len = declaredLength(req);
  if (len !== null) {
    if (len > max) throw new HttpError(413, "body too large");
    if (len === 0 || !req.body) throw new HttpError(400, "empty body");
    await bucket.put(key, req.body, { httpMetadata: { contentType } });
    return len;
  }
  const bytes = await readCapped(req, max);
  if (bytes.byteLength === 0) throw new HttpError(400, "empty body");
  await bucket.put(key, bytes, { httpMetadata: { contentType } });
  return bytes.byteLength;
}

export async function gzipText(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipCapped(bytes: Uint8Array<ArrayBuffer>, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, "source too large");
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "body is not valid gzip");
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const all = new Uint8Array(header.byteLength + bytes.byteLength);
  all.set(header, 0);
  all.set(bytes, header.byteLength);
  return hex(await crypto.subtle.digest("SHA-1", all));
}

