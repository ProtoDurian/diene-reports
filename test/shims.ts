import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Params = unknown[];

function check(params: Params): void {
  for (const p of params) {
    if (p === undefined) throw new Error("D1: undefined bind value");
    if (typeof p === "boolean") throw new Error("D1: boolean bind value");
  }
}

class Stmt {
  constructor(
    private db: Database,
    readonly sql: string,
    private params: Params = [],
  ) {}
  bind(...params: Params): Stmt {
    check(params);
    return new Stmt(this.db, this.sql, params);
  }
  exec(): { results: any[]; meta: { changes: number; last_row_id: number } } {
    const q = this.db.prepare(this.sql);
    const results = q.columnNames.length ? (q.all(...(this.params as any[])) as any[]) : (q.run(...(this.params as any[])), []);
    const m = this.db.query("SELECT changes() AS c, last_insert_rowid() AS r").get() as { c: number; r: number };
    return { results, meta: { changes: m.c, last_row_id: m.r } };
  }
  async first(col?: string): Promise<any> {
    const { results } = this.exec();
    const row = results[0] ?? null;
    return row && col ? row[col] : row;
  }
  async all(): Promise<any> {
    return { success: true, ...this.exec() };
  }
  async run(): Promise<any> {
    return { success: true, ...this.exec() };
  }
  async raw(): Promise<any[]> {
    return this.exec().results.map((r) => Object.values(r));
  }
}

export class D1Shim {
  readonly sqlite = new Database(":memory:");
  statements = 0;
  constructor() {
    const dir = join(import.meta.dir, "..", "migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) this.sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  prepare(sql: string): Stmt {
    return new Stmt(this.sqlite, sql);
  }
  async batch(stmts: Stmt[]): Promise<any[]> {
    this.sqlite.exec("BEGIN");
    try {
      const out = stmts.map((s) => {
        this.statements++;
        return { success: true, ...s.exec() };
      });
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  /** test helper */
  rows<T = any>(sql: string, ...params: Params): T[] {
    return this.sqlite.prepare(sql).all(...(params as any[])) as T[];
  }
  row<T = any>(sql: string, ...params: Params): T | undefined {
    return this.rows<T>(sql, ...params)[0];
  }
}

interface Obj {
  bytes: Uint8Array;
  contentType?: string;
}

export class R2Shim {
  objects = new Map<string, Obj>();
  puts: string[] = [];
  async put(key: string, value: unknown, opts?: { httpMetadata?: { contentType?: string } }): Promise<any> {
    let bytes: Uint8Array;
    if (value instanceof ReadableStream) bytes = new Uint8Array(await new Response(value).arrayBuffer());
    else if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof Uint8Array) bytes = value.slice();
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
    else throw new Error("R2Shim: unsupported value");
    this.objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
    this.puts.push(key);
    return { key, size: bytes.byteLength };
  }
  async get(key: string): Promise<any> {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      key,
      size: o.bytes.byteLength,
      httpMetadata: { contentType: o.contentType },
      body: new Blob([o.bytes as Uint8Array<ArrayBuffer>]).stream(),
      arrayBuffer: async () => o.bytes.slice().buffer,
      text: async () => new TextDecoder().decode(o.bytes),
    };
  }
  async head(key: string): Promise<any> {
    const o = this.objects.get(key);
    return o ? { key, size: o.bytes.byteLength } : null;
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list(opts?: { prefix?: string }): Promise<any> {
    const objects = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(opts?.prefix ?? ""))
      .map(([key, o]) => ({ key, size: o.bytes.byteLength }));
    return { objects, truncated: false };
  }
  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
