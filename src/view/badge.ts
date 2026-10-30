import { esc } from "./html";
import { fmtPct, pct, type RunRow } from "./format";
import type { Env } from "../env";
import { branchHeads, findRepo, projectId } from "./data";

const COLORS = { ok: "#2e9d4f", warn: "#c9971c", bad: "#d1453b", grey: "#8a8f98" };

export function svgBadge(label: string, value: string, color: string): string {
  const w = (s: string) => Math.round(s.length * 6.4 + 12);
  const lw = w(label);
  const vw = w(value);
  const total = lw + vw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
<title>${esc(label)}: ${esc(value)}</title>
<rect width="${lw}" height="20" fill="#4a4f57"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
<text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

export const coverageColor = (p: number) => (p >= 80 ? COLORS.ok : p >= 60 ? COLORS.warn : COLORS.bad);

export async function badge(env: Env, owner: string, name: string, flag: string, branchParam: string | null): Promise<string> {
  const repo = await findRepo(env, owner, name);
  if (!repo) return svgBadge(flag, "unknown", COLORS.grey);
  if (repo.visibility !== "public") return svgBadge(flag, "private", COLORS.grey);
  const branch = branchParam ?? repo.default_branch ?? "main";
  const pid = await projectId(env, repo.repo_id, branch);
  if (pid === null) return svgBadge(flag, "unknown", COLORS.grey);
  const heads = await branchHeads(env, pid);
  if (flag === "tests") return testsBadge(heads.map((h) => h.run));
  const c = heads.find((x) => x.flag === flag)?.cov;
  const p = c ? pct(c.cov_lines_hit, c.cov_lines) : null;
  if (p === null) return svgBadge(`coverage ${flag}`, "unknown", COLORS.grey);
  return svgBadge(`coverage ${flag}`, fmtPct(p), coverageColor(p));
}

function testsBadge(heads: RunRow[]): string {
  const withTests = heads.filter((h) => h.t_total !== null);
  const bad = heads.filter((h) => ["tests_failed", "errored", "timed_out", "lost"].includes(h.state));
  if (bad.length) {
    const failed = bad.reduce((a, h) => a + (h.t_failed ?? 0) + (h.t_errored ?? 0), 0);
    return svgBadge("tests", failed > 0 ? `${failed} failing` : "failed", COLORS.bad);
  }
  if (!withTests.length) return svgBadge("tests", "unknown", COLORS.grey);
  const total = withTests.reduce((a, h) => a + (h.t_total ?? 0), 0);
  return svgBadge("tests", `${total} passing`, COLORS.ok);
}
