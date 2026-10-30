// Fills the LOCAL wrangler D1 + R2 with demo data covering every outcome class.
// Usage: bun run seed   (then: wrangler dev --local)
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeHarness } from "../test/harness";
import { seedDemo } from "../test/fixtures";

const root = join(import.meta.dir, "..");
const tmp = join(root, ".seed");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const h = await makeHarness();
await seedDemo(h);

const q = (v: unknown): string => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const tables = (h.db.rows(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%'`) as { name: string }[]).map((t) => t.name);
let sql = "";
for (const t of tables) sql += `DELETE FROM "${t}";\n`;
for (const t of tables) for (const r of h.db.rows(`SELECT * FROM "${t}"`) as Record<string, unknown>[]) {
  const cols = Object.keys(r);
  sql += `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map((c) => q(r[c])).join(",")});\n`;
}
writeFileSync(join(tmp, "seed.sql"), sql);

const objects: string[] = [];
for (const [key, o] of h.r2.objects) {
  const f = join(tmp, "r2", key);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, o.bytes);
  objects.push(key);
}

const run = (args: string[]) => {
  const p = Bun.spawnSync(["wrangler", ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`wrangler ${args.join(" ")} failed`);
};
run(["d1", "migrations", "apply", "diene_reports", "--local"]);
run(["d1", "execute", "diene_reports", "--local", "--file", join(tmp, "seed.sql")]);
for (const key of objects) run(["r2", "object", "put", `diene-reports/${key}`, "--local", "--file", join(tmp, "r2", key)]);
console.log(`seeded ${tables.length} tables and ${objects.length} R2 objects. Next: see docs/DEPLOY.md "Local" (bun run dev)`);
