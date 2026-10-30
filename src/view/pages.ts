import type { Env } from "../env";
import {
  banner, chip, commitUrl, covBar, covUrl, fileUrl, prUrl, repoUrl, runCard, runTestsUrl,
} from "./components";
import {
  branchHeads, commitInfo, covTrend, failuresFor, homeRows, lastFailure, latestPerJob, prRuns, projectId, projectsOf,
  recentCommits, recentPrs, runById, runsForSha, testHistory, testStatsFor, type Repo,
} from "./data";
import { bySeverity, effState, fmtDuration, fmtPct, fmtTime, ghBase, ghBlob, ghRun, pct, short, stateInfo, worstState, type RunRow } from "./format";
import { enc, html, page, raw, type Raw } from "./html";
import { loadCovChunk, loadReportDiff, loadSource, loadSummary, loadTestList, type TestCase } from "./store";

export class NotFound extends Error {}

export type HomeRepo = Repo;

const crumbs = (repo: Pick<Repo, "owner" | "name">, branch?: string | null) =>
  html`<nav class="crumbs" aria-label="breadcrumb"><a href="${repoUrl(repo.owner, repo.name, branch)}">${repo.owner}/${repo.name}</a></nav>`;

function flagChips(runs: RunRow[]): Raw {
  return html`${runs.map((r) => {
    const p = pct(r.cov_lines_hit, r.cov_lines);
    return html`<span class="flagchip">${r.flag} ${chip(effState(r))}${p !== null ? html` <span class="cov">${fmtPct(p)}</span>` : ""}</span>`;
  })}`;
}

// ----------------------------------------------------------------------------- /

const MAX_GITHUB_CHECKS = 30;

/**
 * `free`: repos anyone may see without asking GitHub (public and checked recently). `check` asks GitHub about the
 * rest (private, or public-but-stale). At most MAX_GITHUB_CHECKS repos are checked per page view so GitHub is never
 * hammered; the others stay hidden (fail closed).
 */
export async function homePage(
  env: Env,
  access: { free: (r: HomeRepo) => boolean; check: (r: HomeRepo) => Promise<boolean> },
): Promise<Raw> {
  const all = await homeRows(env);
  const seen = new Map<number, HomeRepo>();
  for (const r of all) seen.set(r.repo_id, { repo_id: r.repo_id, owner: r.owner, name: r.name, visibility: r.visibility, vis_checked_at: r.vis_checked_at, default_branch: null });
  const open = new Set<number>([...seen.values()].filter(access.free).map((r) => r.repo_id));
  const toCheck = [...seen.values()].filter((r) => !open.has(r.repo_id)).slice(0, MAX_GITHUB_CHECKS);
  const allowed = new Set<number>(await Promise.all(toCheck.map(async (r) => ((await access.check(r)) ? r.repo_id : -1))));
  const rows = all.filter((r) => open.has(r.repo_id) || allowed.has(r.repo_id));
  const groups = new Map<string, { owner: string; name: string; branch: string; runs: RunRow[] }>();
  for (const r of rows) {
    const k = `${r.owner}/${r.name}\0${r.branch}`;
    (groups.get(k) ?? groups.set(k, { owner: r.owner, name: r.name, branch: r.branch, runs: [] }).get(k)!).runs.push(r);
  }
  const list = [...groups.values()];
  return page(
    "Projects",
    html`<h1>Projects</h1>
    ${list.length === 0 ? html`<p class="empty">No runs yet. Results appear here after the first <code>actions.test-report</code> run.</p>` : ""}
    <ul class="rows">${list.map((g) => html`<li class="row tone-${stateInfo(worstState(g.runs)).tone}">
      <a class="main" href="${repoUrl(g.owner, g.name, g.branch)}"><strong>${g.owner}/${g.name}</strong> <span class="branch">${g.branch}</span></a>
      <span class="flags">${flagChips(g.runs)}</span>
    </li>`)}</ul>`,
  );
}

// ----------------------------------------------------------------------------- repo

export async function repoPage(env: Env, repo: Repo, branchParam: string | null): Promise<Raw> {
  const branches = await projectsOf(env, repo.repo_id);
  const branch = branchParam ?? (repo.default_branch && branches.includes(repo.default_branch) ? repo.default_branch : (branches.find((b) => !b.startsWith("tag:") && !b.startsWith("ref:")) ?? branches[0] ?? null));
  if (!branch) {
    return page(`${repo.owner}/${repo.name}`, html`${crumbs(repo)}<h1>${repo.owner}/${repo.name}</h1><p class="empty">No runs yet.</p>`);
  }
  const pid = await projectId(env, repo.repo_id, branch);
  if (pid === null) throw new NotFound("unknown branch");
  const [heads, commits, prs] = await Promise.all([branchHeads(env, pid), recentCommits(env, pid), recentPrs(env, pid)]);
  const flags = heads.map((h) => h.flag);
  const trends = await Promise.all(flags.map(async (f) => ({ flag: f, pts: await covTrend(env, pid, f) })));
  return page(
    `${repo.owner}/${repo.name}`,
    html`${crumbs(repo, branch)}
    <h1>${repo.owner}/${repo.name} <span class="branch">${branch}</span></h1>
    ${branches.length > 1 ? html`<p class="branches" aria-label="branches">${branches.map((b) => html`<a class="pill${b === branch ? " on" : ""}" href="${repoUrl(repo.owner, repo.name, b)}">${b}</a>`)}</p>` : ""}
    <h2>Latest on this branch</h2>
    <div class="cards">${heads.map(({ run: h, cov: c }) => html`<section class="card tone-${stateInfo(effState(h)).tone}"><h3><span class="flag">${h.flag}</span> ${chip(effState(h))}</h3>
      <p><a href="${commitUrl(repo.owner, repo.name, h.sha)}">${short(h.sha)}</a> · ${fmtTime(h.finished_at ?? h.created_at)}</p>
      <p>${c && pct(c.cov_lines_hit, c.cov_lines) !== null ? html`${covBar(pct(c.cov_lines_hit, c.cov_lines))} ${fmtPct(pct(c.cov_lines_hit, c.cov_lines))} coverage${c.id !== h.id ? html` (from <a href="${commitUrl(repo.owner, repo.name, c.sha)}">${short(c.sha)}</a>)` : ""}` : "no coverage"}
      · ${h.t_total !== null ? `${h.t_failed! + h.t_errored!} failing of ${h.t_total}` : "no test results"}</p></section>`)}</div>
    ${trends.some((t) => t.pts.length > 1) ? html`<h2>Coverage trend</h2>${trends.filter((t) => t.pts.length > 1).map((t) => sparkline(t.flag, t.pts))}` : ""}
    <h2>Recent commits</h2>
    <ul class="rows">${commits.map((c) => html`<li class="row tone-${stateInfo(worstState(c.runs)).tone}">
      <a class="main" href="${commitUrl(repo.owner, repo.name, c.sha)}"><code>${short(c.sha)}</code> ${c.message ? c.message.split("\n")[0]!.slice(0, 80) : ""}</a>
      <span class="flags">${flagChips(c.runs)}</span></li>`)}</ul>
    ${prs.length ? html`<h2>Recent pull requests into ${branch}</h2><ul class="rows">${prs.map((p) => html`<li class="row tone-${stateInfo(worstState(p.runs)).tone}">
      <a class="main" href="${prUrl(repo.owner, repo.name, p.pr)}">#${p.pr} <code>${p.head ? short(p.head) : ""}</code></a>
      <span class="flags">${flagChips(p.runs)}</span></li>`)}</ul>` : ""}`,
  );
}

function sparkline(flag: string, pts: { cov_lines: number; cov_lines_hit: number; sha: string }[]): Raw {
  const ys = pts.map((p) => pct(p.cov_lines_hit, p.cov_lines) ?? 0);
  const lo = Math.max(0, Math.min(...ys) - 5);
  const hi = Math.min(100, Math.max(...ys) + 5);
  const span = hi - lo || 1;
  const path = ys.map((y, i) => `${i === 0 ? "M" : "L"}${((i / (ys.length - 1)) * 200).toFixed(1)} ${(38 - ((y - lo) / span) * 36).toFixed(1)}`).join(" ");
  return html`<figure class="spark"><figcaption>${flag}: ${fmtPct(ys[ys.length - 1]!)} (${ys.length} runs, ${fmtPct(Math.min(...ys))} to ${fmtPct(Math.max(...ys))})</figcaption>
    <svg viewBox="0 0 200 40" preserveAspectRatio="none" role="img" aria-label="${flag} coverage trend"><path d="${path}" fill="none"/></svg></figure>`;
}

// ----------------------------------------------------------------------------- commit / PR

async function cardsFor(env: Env, repo: Repo, runs: RunRow[], testBranch: string | null, baseCov: Map<string, number | null> = new Map()) {
  const [fails, sums] = await Promise.all([failuresFor(env, runs.map((r) => r.id)), Promise.all(runs.map((r) => loadSummary(env, r)))]);
  return runs.map((r, i) => runCard(r, { owner: repo.owner, name: repo.name, failures: fails.get(r.id) ?? [], summary: sums[i] ?? null, testBranch, baseCov: baseCov.get(r.flag) ?? null }));
}

export async function commitPage(env: Env, repo: Repo, sha: string): Promise<Raw> {
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new NotFound("bad sha");
  const all = await runsForSha(env, repo.repo_id, sha);
  const runs = bySeverity(latestPerJob(all));
  if (!runs.length) throw new NotFound("no runs for this commit");
  const info = await commitInfo(env, repo.repo_id, sha);
  const first = runs[0]!;
  const cards = await cardsFor(env, repo, runs, first.lane === "tag" || first.lane === "other" ? null : first.branch);
  const lane = first.lane === "pr" && first.pr ? html` · <a href="${prUrl(repo.owner, repo.name, first.pr)}">pull request #${first.pr}</a>` : html` · ${first.branch}`;
  return page(
    `${short(sha)} ${repo.owner}/${repo.name}`,
    html`${crumbs(repo, first.lane === "branch" ? first.branch : null)}
    <h1>Commit <code>${short(first.sha)}</code></h1>
    <p class="meta">${info?.message ? html`${info.message.split("\n")[0]} · ` : ""}<a href="${ghBase(repo.owner, repo.name)}/commit/${first.head_sha}" rel="noopener noreferrer">on GitHub</a>${lane}</p>
    ${banner(runs)}
    <div class="cards">${cards}</div>`,
  );
}

export async function prPage(env: Env, repo: Repo, n: number): Promise<Raw> {
  const all = await prRuns(env, repo.repo_id, n);
  if (!all.length) throw new NotFound("no runs for this pull request");
  const head = all[0]!.head_sha;
  const runs = bySeverity(latestPerJob(all.filter((r) => r.head_sha === head)));
  const base = runs[0]!.branch;
  const pid = await projectId(env, repo.repo_id, base);
  const heads = pid === null ? [] : await branchHeads(env, pid);
  const baseCov = new Map(heads.map((h) => [h.flag, h.cov ? pct(h.cov.cov_lines_hit, h.cov.cov_lines) : null] as const));
  const cards = await cardsFor(env, repo, runs, base, baseCov);
  const sums = await Promise.all(runs.map((r) => loadSummary(env, r)));
  const patchFiles = runs.flatMap((r, i) => (sums[i]?.patch?.files ?? []).filter((f) => f.uncovered.length).map((f) => ({ run: r, f })));
  const patchRuns = runs.filter((r) => r.patch_lines !== null);
  const older = [...new Set(all.map((r) => r.head_sha))].filter((s) => s !== head);
  return page(
    `PR #${n} ${repo.owner}/${repo.name}`,
    html`${crumbs(repo, base)}
    <h1>Pull request #${n}</h1>
    <p class="meta">into <a href="${repoUrl(repo.owner, repo.name, base)}">${base}</a> · head <a href="${commitUrl(repo.owner, repo.name, head)}"><code>${short(head)}</code></a> ·
      <a href="${ghBase(repo.owner, repo.name)}/pull/${n}" rel="noopener noreferrer">on GitHub</a></p>
    ${banner(runs)}
    ${patchRuns.length ? html`<section class="card"><h3>Patch coverage</h3>
      <p class="meta">Per flag: the same changed line can be counted by more than one flag, so the flags are not added together.</p>
      <ul class="rows">${patchRuns.map((r) => html`<li class="row"><span class="main"><span class="flag">${r.flag}${r.job !== r.flag ? ` (job ${r.job})` : ""}</span></span>
        <span class="flags">${covBar(pct(r.patch_lines_hit, r.patch_lines))} <strong>${fmtPct(pct(r.patch_lines_hit, r.patch_lines))}</strong> · ${r.patch_lines_hit}/${r.patch_lines} changed lines covered</span></li>`)}</ul>
      ${patchFiles.length ? html`<h4 class="sec">Changed files with uncovered lines</h4><ul class="rows">${patchFiles.map(({ run, f }) => html`<li class="row">
        <a class="main" href="${fileUrl(repo.owner, repo.name, run.sha, f.path, run.flag, f.uncovered[0])}">${f.path}</a>
        <span class="flags">${f.hit}/${f.lines} · uncovered: ${f.uncovered.slice(0, 12).join(", ")}${f.uncovered.length > 12 ? ", …" : ""}</span></li>`)}</ul>` : html`<p>No uncovered changed lines.</p>`}</section>` : ""}
    <div class="cards">${cards}</div>
    ${older.length ? html`<p class="meta">Earlier pushes: ${older.map((s) => html`<a href="${commitUrl(repo.owner, repo.name, s)}"><code>${short(s)}</code></a> `)}</p>` : ""}`,
  );
}

// ----------------------------------------------------------------------------- coverage tree

interface Node {
  name: string;
  path: string;
  lines: number;
  hit: number;
  children: Map<string, Node>;
  file: boolean;
}

function buildTree(files: { path: string; lines: number; hit: number }[]): Node {
  const root: Node = { name: "", path: "", lines: 0, hit: 0, children: new Map(), file: false };
  for (const f of files) {
    let cur = root;
    cur.lines += f.lines;
    cur.hit += f.hit;
    const parts = f.path.split("/");
    parts.forEach((p, i) => {
      let nx = cur.children.get(p);
      if (!nx) cur.children.set(p, (nx = { name: p, path: parts.slice(0, i + 1).join("/"), lines: 0, hit: 0, children: new Map(), file: i === parts.length - 1 }));
      nx.lines += f.lines;
      nx.hit += f.hit;
      cur = nx;
    });
  }
  return root;
}

function renderNode(n: Node, ctx: { repo: Repo; sha: string; flag: string; sort: string }, depth: number): Raw {
  const kids = [...n.children.values()].sort((a, b) =>
    ctx.sort === "pct" ? (pct(a.hit, a.lines) ?? 101) - (pct(b.hit, b.lines) ?? 101) || a.name.localeCompare(b.name)
    : ctx.sort === "size" ? b.lines - a.lines : Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
  return html`${kids.map((k) => {
    const p = pct(k.hit, k.lines);
    if (k.file) {
      return html`<li class="node file"><a class="line" href="${fileUrl(ctx.repo.owner, ctx.repo.name, ctx.sha, k.path, ctx.flag)}"><span class="nm">${k.name}</span>${covBar(p)}<span class="pc">${fmtPct(p)}</span></a></li>`;
    }
    return html`<li class="node dir"><details${depth < 1 ? raw(" open") : ""}><summary><span class="nm">${k.name}/</span>${covBar(p)}<span class="pc">${fmtPct(p)}</span></summary>
      <ul>${renderNode(k, ctx, depth + 1)}</ul></details></li>`;
  })}`;
}

function bestRunWithCoverage(runs: RunRow[], flag: string): RunRow | undefined {
  return runs.find((r) => r.flag === flag && r.cov_lines !== null) ?? runs.find((r) => r.flag === flag);
}

export async function coveragePage(env: Env, repo: Repo, sha: string, flagParam: string | null, sortParam: string | null): Promise<Raw> {
  const runs = latestPerJob(await runsForSha(env, repo.repo_id, sha));
  if (!runs.length) throw new NotFound("no runs for this commit");
  const withCov = runs.filter((r) => r.cov_lines !== null);
  const flags = [...new Set(withCov.map((r) => r.flag))];
  const sort = ["pct", "size"].includes(sortParam ?? "") ? sortParam! : "name";
  const flag = flagParam ?? (flags.length === 1 ? flags[0]! : null);
  const title = `Coverage ${short(sha)} ${repo.owner}/${repo.name}`;
  if (!flag) {
    return page(title, html`${crumbs(repo)}<h1>Coverage <code>${short(sha)}</code></h1>
      ${flags.length ? html`<p>Pick a flag.</p><ul class="rows">${flags.map((f) => { const r = bestRunWithCoverage(runs, f)!; return html`<li class="row"><a class="main" href="${covUrl(repo.owner, repo.name, sha, f)}">${f}</a><span class="flags">${chip(r.state)} ${fmtPct(pct(r.cov_lines_hit, r.cov_lines))}</span></li>`; })}</ul>` : html`<p class="empty">No coverage was reported for this commit.</p>`}`);
  }
  const run = bestRunWithCoverage(runs, flag);
  if (!run) throw new NotFound("unknown flag");
  const sum = await loadSummary(env, run);
  const files = sum?.coverage?.files ?? null;
  const total = pct(run.cov_lines_hit, run.cov_lines);
  const sortLink = (s: string, label: string) => html`<a class="pill${sort === s ? " on" : ""}" href="${covUrl(repo.owner, repo.name, sha, flag)}&sort=${s}">${label}</a>`;
  return page(
    title,
    html`${crumbs(repo, run.lane === "branch" ? run.branch : null)}
    <h1>Coverage <code>${short(sha)}</code> <span class="branch">${flag}</span></h1>
    <p class="meta">${chip(run.state)} <a href="${commitUrl(repo.owner, repo.name, run.sha)}">commit results</a>${flags.length > 1 ? html` · other flags: ${flags.filter((f) => f !== flag).map((f) => html`<a href="${covUrl(repo.owner, repo.name, sha, f)}">${f}</a> `)}` : ""}</p>
    <p>${covBar(total)} <strong>${fmtPct(total)}</strong> · ${run.cov_lines_hit}/${run.cov_lines} lines${run.cov_partial ? html` · <b class="warn">partial coverage (a test binary failed)</b>` : ""}</p>
    ${files
      ? html`<p class="sorts">Sort: ${sortLink("name", "name")} ${sortLink("pct", "lowest first")} ${sortLink("size", "largest")}</p>
        <ul class="tree">${renderNode(buildTree(files), { repo, sha: run.sha, flag, sort }, 0)}</ul>`
      : html`<p class="empty">${run.over_cap ? "This run was over the size cap, so per-file coverage was not uploaded." : "The per-file detail has expired (non-head runs are kept 90 days). Totals above come from the database."}</p>`}`,
  );
}

// ----------------------------------------------------------------------------- file / line view

export async function filePage(env: Env, repo: Repo, sha: string, path: string | null, flagParam: string | null): Promise<Raw> {
  if (!path) throw new NotFound("missing path");
  const runs = latestPerJob(await runsForSha(env, repo.repo_id, sha));
  const run = flagParam ? bestRunWithCoverage(runs, flagParam) : runs.find((r) => r.cov_lines !== null);
  if (!run) throw new NotFound("no coverage run for this commit and flag");
  const sum = await loadSummary(env, run);
  const entry = sum?.coverage?.files?.find((f) => f.path === path);
  const blob = sum?.sources?.find((s) => s.path === path)?.blob ?? null;
  const [chunk, source, diff] = await Promise.all([
    entry ? loadCovChunk(env, run, entry.chunk) : null,
    blob ? loadSource(env, repo.repo_id, blob) : null,
    run.lane === "pr" ? loadReportDiff(env, run) : null,
  ]);
  const hits = new Map<number, number>((chunk?.files?.[path]?.lines ?? []) as [number, number][]);
  const patchFile = sum?.patch?.files?.find((f) => f.path === path);
  const changed = new Set<number>(diff?.[path] ?? []);
  const uncoveredChanged = new Set<number>(patchFile?.uncovered ?? []);
  for (const l of uncoveredChanged) changed.add(l);
  const gh = ghBlob(repo.owner, repo.name, run.head_sha, path);
  const covP = entry ? pct(entry.hit, entry.lines) : null;
  const lines = source === null ? null : source.replace(/\r\n/g, "\n").split("\n");
  if (lines && lines.length && lines[lines.length - 1] === "") lines.pop();
  return page(
    `${path} ${short(sha)}`,
    html`${crumbs(repo, run.lane === "branch" ? run.branch : null)}
    <p class="crumbs"><a href="${covUrl(repo.owner, repo.name, sha, run.flag)}">← coverage tree</a></p>
    <h1 class="path">${path}</h1>
    <p class="meta"><code>${short(run.sha)}</code> · ${run.flag} · ${covP !== null ? html`${fmtPct(covP)} (${entry!.hit}/${entry!.lines} lines)` : "no coverage data for this file"}${gh ? html` · <a href="${gh}" rel="noopener noreferrer">open on GitHub</a>` : ""}${run.lane === "pr" ? " · changed lines are marked" : ""}</p>
    ${lines === null
      ? html`<p class="empty">The source was not stored (file over 1 MB, not uploaded, or expired after 90 days).${gh ? html` <a href="${gh}" rel="noopener noreferrer">View it on GitHub</a>.` : ""}</p>`
      : html`<div class="src" data-lines="${lines.length}"><table class="code" aria-label="source with line coverage">
        ${lines.map((t, i) => {
          const n = i + 1;
          const h = hits.get(n);
          const cls = `${h === undefined ? "none" : h > 0 ? "hit" : "miss"}${changed.has(n) ? " chg" : ""}`;
          return html`<tr id="L${n}" class="${cls}"><td class="n"><a href="#L${n}">${n}</a></td><td class="h">${h === undefined ? "" : h}</td><td class="t"><code>${t}</code></td></tr>`;
        })}
        </table></div>`}`,
    { script: lines !== null },
  );
}

// ----------------------------------------------------------------------------- test history

export async function testPage(env: Env, repo: Repo, testId: string, branchParam: string | null): Promise<Raw> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(testId)) throw new NotFound("bad test id");
  const branches = await projectsOf(env, repo.repo_id);
  const branch = branchParam ?? repo.default_branch ?? branches[0] ?? null;
  const pid = branch ? await projectId(env, repo.repo_id, branch) : null;
  if (pid === null || !branch) throw new NotFound("unknown branch");
  const [stats, last] = await Promise.all([testStatsFor(env, pid, testId), lastFailure(env, pid, testId)]);
  const flag = stats?.flag ?? last?.flag;
  if (!flag) throw new NotFound("this test has no recorded failures on this branch");
  const hist = await testHistory(env, pid, flag, testId);
  const label = stats?.name ?? last?.name ?? testId;
  return page(
    `${label} ${repo.owner}/${repo.name}`,
    html`${crumbs(repo, branch)}
    <h1>${last?.suite ? `${last.suite} › ` : ""}${label}</h1>
    <p class="meta"><code>${testId}</code> · ${flag} · branch <a href="${repoUrl(repo.owner, repo.name, branch)}">${branch}</a>${stats?.file ? html` · ${stats.file}` : ""}</p>
    ${stats ? html`<p>${stats.last_status === "failed" ? chip("tests_failed") : chip("passed")} ${stats.fails_30d} failure${stats.fails_30d === 1 ? "" : "s"} and ${stats.flips_30d} pass/fail flip${stats.flips_30d === 1 ? "" : "s"} in the last 30 days${stats.flaky_since ? html` · <span class="tag tag-flaky">FLAKY</span> since ${fmtTime(stats.flaky_since)}` : ""}</p>` : ""}
    <h2>History (newest first)</h2>
    <p class="meta">Only failures are stored, so a run without a failure is shown as "no failure reported", not as a confirmed pass (the test may have been skipped). The list stops at the oldest recorded failure.</p>
    <p class="strip" aria-label="history strip">${hist.map((h) => html`<a class="cell ${h.failed ? (h.is_flaky ? "flaky" : "fail") : "pass"}" href="${commitUrl(repo.owner, repo.name, h.sha)}" title="${short(h.sha)} ${h.failed ? "failed" : "no failure reported"}"><span class="sr">${short(h.sha)} ${h.failed ? "failed" : "no failure reported"}</span></a>`)}</p>
    <ul class="rows">${hist.map((h) => html`<li class="row tone-${h.failed ? "bad" : "ok"}"><a class="main" href="${commitUrl(repo.owner, repo.name, h.sha)}"><code>${short(h.sha)}</code> ${h.failed ? "failed" : "no failure reported"}</a><span class="flags">${fmtTime(h.at)}</span></li>`)}</ul>
    ${last ? html`<h2>Last failure</h2><p class="meta"><a href="${commitUrl(repo.owner, repo.name, last.sha)}"><code>${short(last.sha)}</code></a> · ${fmtTime(last.finished_at)}</p>
      ${last.message ? html`<pre class="msg">${last.message}</pre>` : ""}${last.stack ? html`<details class="stack"><summary>Stack trace</summary><pre>${last.stack}</pre></details>` : ""}` : ""}`,
  );
}

// ----------------------------------------------------------------------------- all tests of one run

const GROUPS: { status: TestCase["status"]; title: string; open: boolean }[] = [
  { status: "failed", title: "Failed", open: true },
  { status: "errored", title: "Errored", open: true },
  { status: "skipped", title: "Skipped", open: false },
  { status: "passed", title: "Passed", open: false },
];
const SHOW_MAX = 2000;

export async function runTestsPage(env: Env, repo: Repo, runId: number): Promise<Raw> {
  const run = await runById(env, repo.repo_id, runId);
  if (!run) throw new NotFound("unknown run");
  const list = await loadTestList(env, run);
  const jobLabel = run.job !== run.flag ? ` (job ${run.job})` : "";
  const head = html`${crumbs(repo, run.lane === "branch" ? run.branch : null)}
    <h1>All tests <span class="branch">${run.flag}${jobLabel}</span></h1>
    <p class="meta"><a href="${commitUrl(repo.owner, repo.name, run.sha)}#run-${run.id}"><code>${short(run.sha)}</code> run results</a> · ${chip(effState(run))}${run.t_total !== null ? html` · ${run.t_total} total · ${run.t_passed} passed · ${run.t_failed} failed · ${run.t_errored} errored · ${run.t_skipped} skipped` : ""}</p>`;
  const title = `Tests ${run.flag} ${short(run.sha)} ${repo.owner}/${repo.name}`;
  if (list.kind !== "ok") {
    const why =
      list.kind === "too_large"
        ? `The full report is ${(list.bytes / 1048576).toFixed(1)} MB compressed, too large to list here. The counts above and the failures on the commit page are still correct.`
        : list.kind === "unreadable"
          ? "The full report could not be read. The counts above and the failures on the commit page are still correct."
          : run.over_cap
            ? "This run was over the size cap, so the full report was not uploaded."
            : "The full report is not available: it was never uploaded, or it expired (kept 90 days).";
    return page(title, html`${head}<p class="empty">${why}</p>`);
  }
  const by = new Map<string, TestCase[]>();
  for (const c of list.cases) (by.get(c.status) ?? by.set(c.status, []).get(c.status)!).push(c);
  return page(
    title,
    html`${head}${list.cases.length === 0 ? html`<p class="empty">The report contains no test cases.</p>` : ""}
    ${GROUPS.map((g) => {
      const items = by.get(g.status) ?? [];
      if (!items.length) return "";
      return html`<details class="tests"${g.open ? raw(" open") : ""}><summary><span class="chip tone-${g.status === "passed" ? "ok" : g.status === "skipped" ? "idle" : "bad"}">${g.title}</span> ${items.length}</summary>
        <ul class="rows">${items.slice(0, SHOW_MAX).map((c) => html`<li class="row"><span class="main">${c.suite ? `${c.suite} › ` : ""}${c.name}${c.file ? html` <span class="where">${c.file}${c.line ? `:${c.line}` : ""}</span>` : ""}</span><span class="flags">${c.durationMs !== null ? fmtDuration(c.durationMs) : ""}</span></li>`)}</ul>
        ${items.length > SHOW_MAX ? html`<p class="note">Showing the first ${SHOW_MAX} of ${items.length}.</p>` : ""}</details>`;
    })}`,
  );
}
