import type { Env } from "../env";
import {
  ago, banner, branchChip, chip, commitUrl, covBar, covUrl, deltaPill, dot, fileUrl, monogram, prUrl, repoUrl, runCard, runTestsUrl, spark, tile,
  toneOfPct, trendChart,
} from "./components";
import {
  branchHeads, commitInfo, covSeries, covTrend, failuresFor, homeRows, lastFailure, latestPerJob, prRuns, projectId, projectsOf,
  recentCommits, recentPrs, runById, runsForSha, testHistory, testStatsFor, type Repo,
} from "./data";
import {
  bySeverity, effState, fmtAgo, fmtDuration, fmtPct, fmtTime, ghBase, ghBlob, pct, short, stateInfo, worstState, type RunRow,
} from "./format";
import { enc, html, icon, page, raw, type Crumb, type Raw } from "./html";
import type { NavRepo } from "./login";
import { loadCovChunk, loadReportDiff, loadSource, loadSummary, loadTestList, type TestCase } from "./store";

export class NotFound extends Error {}

export type HomeRepo = Repo;
export type HomeRows = Awaited<ReturnType<typeof homeRows>>;

const crumbsFor = (repo: Pick<Repo, "owner" | "name">, ...rest: Crumb[]): Crumb[] => [
  { label: repo.owner, href: `/#org-${enc(repo.owner)}` },
  { label: repo.name, href: repoUrl(repo.owner, repo.name) },
  ...rest,
];

const repoLink = (repo: Pick<Repo, "owner" | "name">, branch?: string | null) =>
  html`<a class="rl" href="${repoUrl(repo.owner, repo.name, branch)}">${repo.owner}/${repo.name}</a>`;

const firstLine = (s: string | null | undefined) => (s ? s.split("\n")[0]!.trim() : "");

const flagPill = (r: RunRow): Raw => {
  const s = stateInfo(effState(r));
  const p = pct(r.cov_lines_hit, r.cov_lines);
  return html`<span class="fl tone-${s.tone}" title="${r.flag}: ${s.label}${p !== null ? ` · ${fmtPct(p)}` : ""}">${dot(s.tone, r.state === "started")}${r.flag}</span>`;
};

/** the run whose coverage represents the commit: "unit" if it has coverage, else the biggest coverage report */
function primaryCov(runs: RunRow[]): RunRow | undefined {
  const withCov = runs.filter((r) => r.cov_lines !== null);
  return withCov.find((r) => r.flag === "unit") ?? [...withCov].sort((a, b) => (b.cov_lines ?? 0) - (a.cov_lines ?? 0))[0];
}

const lastTouched = (runs: RunRow[]) => runs.reduce<number | null>((m, r) => Math.max(m ?? 0, r.finished_at ?? r.created_at) || m, null);

// ----------------------------------------------------------------------------- repo summaries (home + left nav)

export interface RepoSummary extends Repo {
  branch: string;
  branches: string[];
  runs: RunRow[];
  tone: string;
  at: number | null;
}

/** one summary per repo: its main branch (the default branch when it has runs) and the heads of that branch */
export function summarize(rows: HomeRows): RepoSummary[] {
  const byRepo = new Map<number, { repo: Repo; by: Map<string, RunRow[]> }>();
  for (const r of rows) {
    const e =
      byRepo.get(r.repo_id) ??
      byRepo
        .set(r.repo_id, { repo: { repo_id: r.repo_id, owner: r.owner, name: r.name, visibility: r.visibility, default_branch: r.default_branch, vis_checked_at: r.vis_checked_at }, by: new Map() })
        .get(r.repo_id)!;
    (e.by.get(r.branch) ?? e.by.set(r.branch, []).get(r.branch)!).push(r);
  }
  return [...byRepo.values()].map(({ repo, by }) => {
    const branches = [...by.keys()];
    const plain = branches.filter((b) => !b.startsWith("tag:") && !b.startsWith("ref:"));
    const branch =
      (repo.default_branch && by.has(repo.default_branch) ? repo.default_branch : null) ??
      plain.find((b) => b === "main" || b === "master") ??
      plain[0] ??
      branches[0]!;
    const runs = by.get(branch)!;
    return { ...repo, branch, branches, runs, tone: stateInfo(worstState(runs)).tone, at: lastTouched(runs) };
  });
}

export const navOf = (list: RepoSummary[]): NavRepo[] => list.map((s) => ({ owner: s.owner, name: s.name, tone: s.tone }));

/** left navigation: projects grouped by owner. `current` marks the open project (or the overview). */
export function sidebar(nav: NavRepo[], current: { owner: string; name: string } | "home" | null): Raw {
  const owners = new Map<string, NavRepo[]>();
  for (const r of [...nav].sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name))) (owners.get(r.owner) ?? owners.set(r.owner, []).get(r.owner)!).push(r);
  const isCur = (r: NavRepo) => typeof current === "object" && current !== null && current.owner.toLowerCase() === r.owner.toLowerCase() && current.name.toLowerCase() === r.name.toLowerCase();
  return html`<a class="nav" href="/"${current === "home" ? raw(' aria-current="page"') : ""}>${icon("grid", 16)}<span class="nm">All projects</span></a>
    ${owners.size === 0 ? html`<p class="none">No projects yet.</p>` : ""}
    ${[...owners].map(([owner, repos]) => html`<div class="org">${monogram(owner)}<a href="/#org-${enc(owner)}">${owner}</a></div>
      <ul>${repos.map((r) => html`<li><a class="nav tone-${r.tone}" href="${repoUrl(r.owner, r.name)}"${isCur(r) ? raw(' aria-current="page"') : ""}>${dot(r.tone)}<span class="nm">${r.name}</span></a></li>`)}</ul>`)}`;
}

// ----------------------------------------------------------------------------- /

const MAX_GITHUB_CHECKS = 30;

const WORKFLOW_EXAMPLE = [
  "permissions:",
  "  id-token: write",
  "  contents: read",
  "steps:",
  "  - uses: actions/checkout@v4",
  "  - uses: ProtoDurian/actions.test-report@v1",
  "    with: { mode: start, flag: unit, language: bun }",
  "  - id: tests",
  "    run: bun test --coverage",
  "  - uses: ProtoDurian/actions.test-report@v1",
  "    if: always()",
  "    with:",
  "      mode: finish",
  "      flag: unit",
  "      test-outcome: ${{ steps.tests.outcome }}",
  "      job-status: ${{ job.status }}",
].join("\n");

/**
 * `free`: repos anyone may see without asking GitHub (public and checked recently). `check` asks GitHub about the
 * rest (private, or public-but-stale). At most MAX_GITHUB_CHECKS repos are checked per page view so GitHub is never
 * hammered; the others stay hidden (fail closed).
 */
export async function homePage(
  env: Env,
  all: HomeRows,
  access: { free: (r: HomeRepo) => boolean; check: (r: HomeRepo) => Promise<boolean> },
  now: number,
): Promise<{ page: Raw; nav: NavRepo[] }> {
  const every = summarize(all);
  const open = new Set<number>(every.filter(access.free).map((r) => r.repo_id));
  const toCheck = every.filter((r) => !open.has(r.repo_id)).slice(0, MAX_GITHUB_CHECKS);
  const allowed = new Set<number>(await Promise.all(toCheck.map(async (r) => ((await access.check(r)) ? r.repo_id : -1))));
  const list = every.filter((r) => open.has(r.repo_id) || allowed.has(r.repo_id));
  const series = await covSeries(env, list.map((s) => s.runs[0]!.project_id));

  const owners = new Map<string, RepoSummary[]>();
  for (const r of list) (owners.get(r.owner) ?? owners.set(r.owner, []).get(r.owner)!).push(r);
  const count = (tone: string) => list.filter((s) => s.tone === tone).length;
  const body = html`<div class="phead"><h1>Projects</h1><p class="muted">Latest result on each project's main branch.</p></div>
    ${list.length === 0
      ? html`<div class="empty"><h2>No runs yet</h2>
          <p>Results appear here after the first <code>actions.test-report</code> run. Add the action to a workflow:</p>
          <div class="howto"><pre>${WORKFLOW_EXAMPLE}</pre></div></div>`
      : html`<div class="stats">
          ${tile("Projects", String(list.length))}
          ${tile("Passing", String(count("ok")), "all flags green", count("ok") ? "ok" : "")}
          ${tile("Failing", String(count("bad")), "tests failed or run broke", count("bad") ? "bad" : "")}
          ${tile("Needs a look", String(count("warn")), "cancelled, no report, job failed", count("warn") ? "warn" : "")}
        </div>
        ${[...owners].map(([owner, repos]) => html`<div class="orgh" id="org-${owner}">${monogram(owner)}<h2>${owner}</h2><span class="c">${repos.length} project${repos.length === 1 ? "" : "s"}</span></div>
          <ul class="repos">${repos.map((g) => repoRow(g, series, now))}</ul>`)}`}`;
  return { page: page("Projects", body), nav: navOf(list) };
}

function repoRow(g: RepoSummary, series: Map<string, number[]>, now: number): Raw {
  const pr = primaryCov(g.runs);
  const p = pr ? pct(pr.cov_lines_hit, pr.cov_lines) : null;
  const vals = pr ? (series.get(`${pr.project_id}\0${pr.flag}`) ?? []) : [];
  const more = g.branches.length - 1;
  return html`<li class="row tone-${g.tone}">
    <div class="id">${dot(g.tone)}<div>
      <a class="name" href="${repoUrl(g.owner, g.name, g.branch)}">${g.name}</a>
      <div class="sub">${branchChip(g.branch)}${more > 0 ? html`<a class="more" href="${repoUrl(g.owner, g.name)}">+${more} more</a>` : ""}<span>${ago(g.at, fmtAgo(g.at, now))}</span></div>
    </div></div>
    <div class="fls">${g.runs.map((r) => flagPill(r))}</div>
    <div class="cov">${p !== null ? html`<span class="pc num">${fmtPct(p)}</span>${spark(vals)}` : html`<span class="na">no coverage</span>`}</div>
  </li>`;
}

// ----------------------------------------------------------------------------- repo

export async function repoPage(env: Env, repo: Repo, branchParam: string | null, now: number): Promise<Raw> {
  const branches = await projectsOf(env, repo.repo_id);
  const branch = branchParam ?? (repo.default_branch && branches.includes(repo.default_branch) ? repo.default_branch : (branches.find((b) => !b.startsWith("tag:") && !b.startsWith("ref:")) ?? branches[0] ?? null));
  const gh = html`<a class="btn" href="${ghBase(repo.owner, repo.name)}" rel="noopener noreferrer">${icon("github", 15)}GitHub</a>`;
  if (!branch) {
    return page(
      `${repo.owner}/${repo.name}`,
      html`<div class="phead"><div class="eyebrow">${monogram(repo.owner)}<a href="/#org-${enc(repo.owner)}">${repo.owner}</a></div><div class="row-end"><h1>${repo.name}</h1><div class="acts">${gh}</div></div></div>
        <div class="empty"><h2>No runs yet</h2><p>Results appear here after the first <code>actions.test-report</code> run for this project.</p></div>`,
      { crumbs: crumbsFor(repo) },
    );
  }
  const pid = await projectId(env, repo.repo_id, branch);
  if (pid === null) throw new NotFound("unknown branch");
  const [heads, commits, prs] = await Promise.all([branchHeads(env, pid), recentCommits(env, pid), recentPrs(env, pid)]);
  const flags = heads.map((h) => h.flag);
  const trends = (await Promise.all(flags.map(async (f) => ({ flag: f, pts: await covTrend(env, pid, f) })))).filter((t) => t.pts.length > 1);

  const switcher = html`<details class="menu"><summary class="btn" aria-label="Switch branch">${icon("branch", 15)}<span class="mono">${branch}</span>${icon("chevron", 14)}</summary>
    <div class="pop">${branches.slice(0, 60).map((b) => html`<a${b === branch ? raw(' class="on" aria-current="true"') : ""} href="${repoUrl(repo.owner, repo.name, b)}">${b}</a>`)}</div></details>`;

  // coverage change vs the next older commit that has coverage for the same flag
  const covOf = commits.map((c) => primaryCov(c.runs));
  const deltaAt = (i: number): number | null => {
    const cur = covOf[i];
    if (!cur) return null;
    for (let j = i + 1; j < commits.length; j++) {
      const old = covOf[j];
      if (old && old.flag === cur.flag) return (pct(cur.cov_lines_hit, cur.cov_lines) ?? 0) - (pct(old.cov_lines_hit, old.cov_lines) ?? 0);
    }
    return null;
  };

  return page(
    `${repo.owner}/${repo.name}`,
    html`<div class="phead">
      <div class="eyebrow">${monogram(repo.owner)}<a href="/#org-${enc(repo.owner)}">${repo.owner}</a></div>
      <div class="row-end"><h1>${repo.name}</h1><div class="acts">${branches.length > 1 ? switcher : branchChip(branch)}${gh}</div></div>
    </div>

    <div class="sect"><h2>Latest on ${branch}</h2></div>
    <div class="heads">${heads.map(({ run: h, cov: c }) => {
      const tone = stateInfo(effState(h)).tone;
      const p = c ? pct(c.cov_lines_hit, c.cov_lines) : null;
      return html`<section class="panel head tone-${tone}">
        <div class="top"><span class="fname">${dot(tone, h.state === "started")}${h.flag}</span>${chip(effState(h))}</div>
        ${p !== null ? html`<div class="big">${fmtPct(p)}</div>${covBar(p, true)}` : html`<div class="big muted">–</div><span class="muted">no coverage</span>`}
        <div class="sub">
          <span>${p !== null && c && c.id !== h.id ? html`coverage from <a href="${commitUrl(repo.owner, repo.name, c.sha)}">${short(c.sha)}</a>` : html`<a href="${commitUrl(repo.owner, repo.name, h.sha)}">${short(h.sha)}</a>`}</span>
          <span>${h.t_total !== null ? `${h.t_failed! + h.t_errored!} failing of ${h.t_total} tests` : "no test results"}</span>
          <span>${ago(h.finished_at ?? h.created_at, fmtAgo(h.finished_at ?? h.created_at, now))}</span>
        </div>
      </section>`;
    })}</div>

    ${trends.length
      ? html`<div class="sect"><h2>Coverage trend</h2><span class="aside">last ${Math.max(...trends.map((t) => t.pts.length))} runs on ${branch}</span></div>
        <div class="trends">${trends.map((t, i) => {
          const pts = t.pts.map((x) => ({ p: pct(x.cov_lines_hit, x.cov_lines) ?? 0, sha: x.sha, at: x.at }));
          const d = pts[pts.length - 1]!.p - pts[0]!.p;
          return html`<section class="panel trend"><div class="th"><b>${t.flag}</b><span><span class="big">${fmtPct(pts[pts.length - 1]!.p)}</span> ${deltaPill(d)}</span></div>${trendChart(String(i), pts)}</section>`;
        })}</div>`
      : ""}

    <div class="sect"><h2>Recent commits</h2></div>
    ${commits.length
      ? html`<div class="tblw"><table class="tbl"><thead><tr><th>Commit</th><th>Status</th><th>Flags</th><th class="r">Coverage</th></tr></thead><tbody>
      ${commits.map((c, i) => {
        const w = worstState(c.runs);
        const cp = covOf[i];
        const p = cp ? pct(cp.cov_lines_hit, cp.cov_lines) : null;
        const actor = c.runs.find((r) => r.actor)?.actor;
        return html`<tr class="row tone-${stateInfo(w).tone}">
          <td class="c-main"><a class="msg1" href="${commitUrl(repo.owner, repo.name, c.sha)}">${firstLine(c.message).slice(0, 120) || short(c.sha)}</a>
            <div class="shaline"><code>${short(c.sha)}</code>${actor ? html`<span>${actor}</span>` : ""}<span>${ago(c.at, fmtAgo(c.at, now))}</span></div></td>
          <td class="c-status">${chip(w)}</td>
          <td class="c-flags"><div class="fls">${c.runs.map((r) => flagPill(r))}</div></td>
          <td class="r c-cov">${p !== null ? html`<span class="pcnum">${fmtPct(p)}</span> ${deltaPill(deltaAt(i))}` : html`<span class="muted">–</span>`}</td>
        </tr>`;
      })}</tbody></table></div>`
      : html`<p class="empty">No commits on this branch yet.</p>`}

    ${prs.length
      ? html`<div class="sect"><h2>Recent pull requests into ${branch}</h2></div>
        <div class="tblw"><table class="tbl"><thead><tr><th>Pull request</th><th>Status</th><th>Flags</th><th class="r">Patch coverage</th></tr></thead><tbody>
        ${prs.map((p) => {
          const w = worstState(p.runs);
          const pr = p.runs.find((r) => r.patch_lines !== null);
          const pp = pr ? pct(pr.patch_lines_hit, pr.patch_lines) : null;
          return html`<tr class="row tone-${stateInfo(w).tone}">
            <td class="c-main"><a class="msg1" href="${prUrl(repo.owner, repo.name, p.pr)}">#${p.pr}</a>
              <div class="shaline">${p.head ? html`<code>${short(p.head)}</code>` : ""}<span>${ago(p.at, fmtAgo(p.at, now))}</span></div></td>
            <td class="c-status">${chip(w)}</td>
            <td class="c-flags"><div class="fls">${p.runs.map((r) => flagPill(r))}</div></td>
            <td class="r c-cov">${pp !== null ? html`<span class="pcnum">${fmtPct(pp)}</span>` : html`<span class="muted">–</span>`}</td>
          </tr>`;
        })}</tbody></table></div>`
      : ""}`,
    { crumbs: crumbsFor(repo, { label: branch }) },
  );
}

// ----------------------------------------------------------------------------- commit / PR

async function cardsFor(env: Env, repo: Repo, runs: RunRow[], testBranch: string | null, baseCov: Map<string, number | null> = new Map()) {
  const [fails, sums] = await Promise.all([failuresFor(env, runs.map((r) => r.id)), Promise.all(runs.map((r) => loadSummary(env, r)))]);
  const firstWith = runs.findIndex((r) => (fails.get(r.id) ?? []).length > 0);
  return runs.map((r, i) => runCard(r, { owner: repo.owner, name: repo.name, failures: fails.get(r.id) ?? [], summary: sums[i] ?? null, testBranch, baseCov: baseCov.get(r.flag) ?? null, firstFailures: i === firstWith }));
}

function testTotals(runs: RunRow[]) {
  const t = runs.filter((r) => r.t_total !== null);
  const sum = (f: (r: RunRow) => number | null) => t.reduce((a, r) => a + (f(r) ?? 0), 0);
  return { any: t.length > 0, total: sum((r) => r.t_total), passed: sum((r) => r.t_passed), failed: sum((r) => (r.t_failed ?? 0) + (r.t_errored ?? 0)), skipped: sum((r) => r.t_skipped) };
}

function statStrip(runs: RunRow[], hasFailures: boolean): Raw {
  const t = testTotals(runs);
  const cov = primaryCov(runs);
  const cp = cov ? pct(cov.cov_lines_hit, cov.cov_lines) : null;
  const longest = runs.reduce<number | null>((m, r) => (r.duration_ms === null ? m : Math.max(m ?? 0, r.duration_ms)), null);
  return html`<div class="stats">
    ${tile("Tests passed", t.any ? String(t.passed) : "–", t.any ? `of ${t.total} tests` : "no test results", t.any && t.failed === 0 && t.passed > 0 ? "ok" : "")}
    ${tile("Tests failed", t.any ? String(t.failed) : "–", t.failed ? "see the failures below" : t.any ? "none" : "", t.failed ? "bad" : "", t.failed && hasFailures ? "#failures" : undefined)}
    ${tile("Skipped", t.any ? String(t.skipped) : "–", "")}
    ${tile("Coverage", cp !== null ? fmtPct(cp) : "–", cov ? `${cov.flag}${cov.cov_partial ? " · partial" : ""}` : "no coverage")}
    ${tile("Duration", fmtDuration(longest), "longest job")}
  </div>`;
}

const actorOf = (runs: RunRow[]): Raw | "" => {
  const a = runs.find((r) => r.actor)?.actor;
  return a ? html`<span>${a}</span>` : "";
};

export async function commitPage(env: Env, repo: Repo, sha: string, now: number): Promise<Raw> {
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new NotFound("bad sha");
  const all = await runsForSha(env, repo.repo_id, sha);
  const runs = bySeverity(latestPerJob(all));
  if (!runs.length) throw new NotFound("no runs for this commit");
  const info = await commitInfo(env, repo.repo_id, sha);
  const first = runs[0]!;
  const cards = await cardsFor(env, repo, runs, first.lane === "tag" || first.lane === "other" ? null : first.branch);
  const vInfo = stateInfo(worstState(runs));
  const at = lastTouched(runs);
  const message = firstLine(info?.message);
  const lane = first.lane === "pr" && first.pr
    ? html`<a class="branch" href="${prUrl(repo.owner, repo.name, first.pr)}">${icon("pr", 11)}pull request #${first.pr}</a>`
    : html`<a class="branch" href="${repoUrl(repo.owner, repo.name, first.lane === "branch" ? first.branch : null)}">${icon("branch", 11)}${first.branch}</a>`;
  const hasFailures = runs.some((r) => (r.t_failed ?? 0) + (r.t_errored ?? 0) > 0);
  return page(
    `${short(sha)} ${repo.owner}/${repo.name}`,
    html`<div class="phead">
      <div class="eyebrow"><span class="st big tone-${vInfo.tone}">${vInfo.label}</span>${lane}${repoLink(repo, first.lane === "branch" ? first.branch : null)}</div>
      <h1 class="cmsg">${message || html`Commit <code>${short(first.sha)}</code>`}</h1>
      <div class="meta"><span class="mono">${icon("commit", 14)}${short(first.sha)}</span>${actorOf(runs)}${at !== null ? html`<span>${ago(at, fmtAgo(at, now))}</span>` : ""}<a href="${ghBase(repo.owner, repo.name)}/commit/${first.head_sha}" rel="noopener noreferrer">on GitHub</a></div>
    </div>
    ${statStrip(runs, hasFailures)}
    ${banner(runs)}
    <div class="sect"><h2>Results by flag</h2></div>
    ${cards}`,
    { crumbs: crumbsFor(repo, ...(first.lane === "branch" ? [{ label: first.branch, href: repoUrl(repo.owner, repo.name, first.branch) }] : []), { label: short(sha) }) },
  );
}

export async function prPage(env: Env, repo: Repo, n: number, now: number): Promise<Raw> {
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
  const v = stateInfo(worstState(runs));
  const at = lastTouched(runs);
  const hasFailures = runs.some((r) => (r.t_failed ?? 0) + (r.t_errored ?? 0) > 0);
  return page(
    `PR #${n} ${repo.owner}/${repo.name}`,
    html`<div class="phead">
      <div class="eyebrow"><span class="st big tone-${v.tone}">${v.label}</span><span class="branch">${icon("pr", 11)}into ${base}</span>${repoLink(repo, base)}</div>
      <div class="row-end"><h1>Pull request #${n}</h1><div class="acts"><a class="btn" href="${ghBase(repo.owner, repo.name)}/pull/${n}" rel="noopener noreferrer">${icon("github", 15)}On GitHub</a></div></div>
      <div class="meta"><span>head <a href="${commitUrl(repo.owner, repo.name, head)}"><code>${short(head)}</code></a></span>${actorOf(runs)}${at !== null ? html`<span>${ago(at, fmtAgo(at, now))}</span>` : ""}</div>
    </div>
    ${patchRuns.length
      ? html`<div class="sect"><h2>Patch coverage</h2><span class="aside">of the lines this pull request changes</span></div>
        <div class="prhero">${patchRuns.map((r) => {
          const p = pct(r.patch_lines_hit, r.patch_lines);
          const bp = baseCov.get(r.flag);
          return html`<section class="panel patch tone-${toneOfPct(p)}"><div class="lab">${dot(toneOfPct(p))}${r.flag}${r.job !== r.flag ? html`<span class="muted"> (job ${r.job})</span>` : ""}</div>
            <div class="huge">${fmtPct(p)}</div>${covBar(p, true)}
            <div class="of">${r.patch_lines_hit}/${r.patch_lines} changed lines covered${bp !== undefined && bp !== null ? html` · branch is at ${fmtPct(bp)}` : ""}</div></section>`;
        })}</div>
        <p class="note">Per flag: the same changed line can be counted by more than one flag, so the flags are not added together.</p>
        <div class="sect"><h2>Changed files with uncovered lines</h2></div>
        ${patchFiles.length
          ? html`<section class="panel clip"><ul class="files">${patchFiles.map(({ run, f }) => html`<li>
              <a class="fp" href="${fileUrl(repo.owner, repo.name, run.sha, f.path, run.flag, f.uncovered[0])}">${f.path}</a>
              <span class="lines"><span class="branch">${run.flag}</span><span class="num">${f.hit}/${f.lines}</span>${f.uncovered.slice(0, 12).map((l) => html`<a href="${fileUrl(repo.owner, repo.name, run.sha, f.path, run.flag, l)}">L${l}</a>`)}${f.uncovered.length > 12 ? html`<span>+${f.uncovered.length - 12} more</span>` : ""}</span></li>`)}</ul></section>`
          : html`<p class="empty">No uncovered changed lines.</p>`}`
      : ""}
    ${statStrip(runs, hasFailures)}
    ${banner(runs)}
    <div class="sect"><h2>Results by flag</h2></div>
    ${cards}
    ${older.length ? html`<p class="note">Earlier pushes: ${older.map((s) => html`<a href="${commitUrl(repo.owner, repo.name, s)}"><code>${short(s)}</code></a> `)}</p>` : ""}`,
    { crumbs: crumbsFor(repo, { label: `PR #${n}` }) },
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
    const cells = html`${covBar(p)}<span class="pc ${toneOfPct(p)}">${fmtPct(p)}</span><span class="ln2">${k.hit}/${k.lines}</span>`;
    if (k.file) {
      return html`<li class="node file"><a class="line" href="${fileUrl(ctx.repo.owner, ctx.repo.name, ctx.sha, k.path, ctx.flag)}"><span class="nm">${icon("file", 15)}${k.name}</span>${cells}</a></li>`;
    }
    return html`<li class="node dir"><details${depth < 2 ? raw(" open") : ""}><summary><span class="nm">${icon("folder", 15)}${k.name}/</span>${cells}</summary>
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
  const crumbs = crumbsFor(repo, { label: short(sha), href: commitUrl(repo.owner, repo.name, sha) }, { label: "Coverage" });
  if (!flag) {
    return page(
      title,
      html`<div class="phead"><div class="eyebrow">${repoLink(repo)}</div><h1>Coverage <code>${short(sha)}</code></h1><p class="muted">Pick a flag.</p></div>
      ${flags.length
        ? html`<section class="panel clip"><ul class="files">${flags.map((f) => {
            const r = bestRunWithCoverage(runs, f)!;
            return html`<li><a class="fp" href="${covUrl(repo.owner, repo.name, sha, f)}">${f}</a><span class="lines">${chip(r.state)}<b class="num">${fmtPct(pct(r.cov_lines_hit, r.cov_lines))}</b></span></li>`;
          })}</ul></section>`
        : html`<p class="empty">No coverage was reported for this commit.</p>`}`,
      { crumbs },
    );
  }
  const run = bestRunWithCoverage(runs, flag);
  if (!run) throw new NotFound("unknown flag");
  const sum = await loadSummary(env, run);
  const files = sum?.coverage?.files ?? null;
  const total = pct(run.cov_lines_hit, run.cov_lines);
  const sortLink = (s: string, label: string) => html`<a${sort === s ? raw(' class="on" aria-current="true"') : ""} href="${covUrl(repo.owner, repo.name, sha, flag)}&sort=${s}">${label}</a>`;
  return page(
    title,
    html`<div class="phead">
      <div class="eyebrow">${chip(run.state)}<span class="branch">${flag}</span>${repoLink(repo, run.lane === "branch" ? run.branch : null)}</div>
      <div class="row-end"><h1>Coverage <code>${short(sha)}</code></h1><div class="acts"><a class="btn" href="${commitUrl(repo.owner, repo.name, run.sha)}">Commit results</a></div></div>
      ${flags.length > 1 ? html`<div class="meta"><span>other flags:</span>${flags.filter((f) => f !== flag).map((f) => html`<a href="${covUrl(repo.owner, repo.name, sha, f)}">${f}</a>`)}</div>` : ""}
    </div>
    <section class="panel covhero tone-${toneOfPct(total)}">
      <div class="bigp">${fmtPct(total)}</div>
      <div><div class="of">${run.cov_lines_hit}/${run.cov_lines} lines covered${run.cov_partial ? html` · <b class="warn">partial coverage (a test binary failed)</b>` : ""}</div>${covBar(total, true)}</div>
    </section>
    ${files
      ? html`<div class="sect"><h2>Files</h2><div class="seg" role="group" aria-label="Sort files">${sortLink("name", "Name")}${sortLink("pct", "Lowest first")}${sortLink("size", "Largest")}</div></div>
        <section class="panel clip"><div class="thead"><span>File</span><span>Coverage</span><span>%</span><span>Lines</span></div>
        <ul class="tree">${renderNode(buildTree(files), { repo, sha: run.sha, flag, sort }, 0)}</ul></section>`
      : html`<p class="empty">${run.over_cap ? "This run was over the size cap, so per-file coverage was not uploaded." : "The per-file detail has expired (non-head runs are kept 90 days). Totals above come from the database."}</p>`}`,
    { crumbs },
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
  for (const l of patchFile?.uncovered ?? []) changed.add(l);
  const gh = ghBlob(repo.owner, repo.name, run.head_sha, path);
  const covP = entry ? pct(entry.hit, entry.lines) : null;
  const lines = source === null ? null : source.replace(/\r\n/g, "\n").split("\n");
  if (lines && lines.length && lines[lines.length - 1] === "") lines.pop();
  const cut = path.lastIndexOf("/");
  const dir = cut >= 0 ? path.slice(0, cut + 1) : "";
  const file = path.slice(cut + 1);
  const covLink = covUrl(repo.owner, repo.name, sha, run.flag);
  return page(
    `${path} ${short(sha)}`,
    html`<div class="phead">
      <div class="eyebrow"><a class="rl" href="${covLink}">← Coverage tree</a><span class="branch">${run.flag}</span><span class="branch">${icon("commit", 11)}${short(run.sha)}</span></div>
      <h1 class="path"><span class="d">${dir}</span>${file}</h1>
    </div>
    ${lines === null
      ? html`<p class="empty">The source was not stored (file over 1 MB, not uploaded, or expired after 90 days).${gh ? html` <a href="${gh}" rel="noopener noreferrer">View it on GitHub</a>.` : ""}${covP !== null ? html`<br>This file is ${fmtPct(covP)} covered (${entry!.hit}/${entry!.lines} lines).` : ""}</p>`
      : html`<div class="fileh">
          ${covP !== null ? html`<span class="cov"><b class="pc num">${fmtPct(covP)}</b>${covBar(covP)}<span class="muted">${entry!.hit}/${entry!.lines} lines</span></span>` : html`<span class="muted">no coverage data for this file</span>`}
          <span class="legend-k"><span><i class="k-hit"></i>covered</span><span><i class="k-miss"></i>not covered</span>${run.lane === "pr" ? html`<span><i class="k-chg"></i>changed in this PR</span>` : ""}</span>
          <span class="grow"></span>
          ${gh ? html`<a class="btn" href="${gh}" rel="noopener noreferrer">${icon("github", 15)}Open on GitHub</a>` : ""}
        </div>
        <div class="src" data-lines="${lines.length}"><table class="code" aria-label="source with line coverage">
        ${lines.map((t, i) => {
          const n = i + 1;
          const h = hits.get(n);
          const cls = `${h === undefined ? "none" : h > 0 ? "hit" : "miss"}${changed.has(n) ? " chg" : ""}`;
          return html`<tr id="L${n}" class="${cls}"><td class="n"><a href="#L${n}">${n}</a></td><td class="h">${h === undefined ? "" : h}</td><td class="t"><code>${t}</code></td></tr>`;
        })}
        </table></div>`}`,
    { script: lines !== null, crumbs: crumbsFor(repo, { label: short(sha), href: commitUrl(repo.owner, repo.name, sha) }, { label: "Coverage", href: covLink }, { label: file }) },
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
  const kind = (h: (typeof hist)[number]) => (h.failed ? (h.is_flaky ? "flaky" : "fail") : "pass");
  const word = (h: (typeof hist)[number]) => (h.failed ? "failed" : "no failure reported");
  return page(
    `${label} ${repo.owner}/${repo.name}`,
    html`<div class="phead">
      <div class="eyebrow">${stats ? chip(stats.last_status === "failed" ? "tests_failed" : "passed") : ""}${stats?.flaky_since ? html`<span class="tag tag-flaky">FLAKY</span>` : ""}<span class="branch">${flag}</span>${repoLink(repo, branch)}</div>
      <h1>${last?.suite ? `${last.suite} › ` : ""}${label}</h1>
      <div class="meta"><span class="mono">${testId}</span>${stats?.file ? html`<span class="mono">${stats.file}</span>` : ""}<span>branch <a href="${repoUrl(repo.owner, repo.name, branch)}">${branch}</a></span></div>
    </div>
    ${stats
      ? html`<div class="stats">
          ${tile("Failures · 30 days", String(stats.fails_30d), `failure${stats.fails_30d === 1 ? "" : "s"}`, stats.fails_30d ? "bad" : "")}
          ${tile("Flips · 30 days", String(stats.flips_30d), `pass/fail flip${stats.flips_30d === 1 ? "" : "s"}`, stats.flips_30d >= 3 ? "warn" : "")}
          ${tile("Last result", stats.last_status === "failed" ? "failed" : "passed", "", stats.last_status === "failed" ? "bad" : "ok")}
          ${tile("Flaky since", stats.flaky_since ? fmtTime(stats.flaky_since).replace(" UTC", "") : "–", stats.flaky_since ? "UTC" : "not flagged flaky")}
        </div>`
      : ""}
    <div class="sect"><h2>History (newest first)</h2></div>
    <div class="strip" aria-label="history strip">${hist.map((h) => html`<a class="${kind(h)}" href="${commitUrl(repo.owner, repo.name, h.sha)}" title="${short(h.sha)} ${word(h)}"><span class="sr">${short(h.sha)} ${word(h)}</span></a>`)}</div>
    <p class="note">Only failures are stored, so a run without a failure is shown as "no failure reported", not as a confirmed pass (the test may have been skipped). The list stops at the oldest recorded failure.</p>
    <section class="panel clip"><ul class="rows">${hist.map((h) => html`<li class="row tone-${h.failed ? "bad" : "ok"}"><a class="main" href="${commitUrl(repo.owner, repo.name, h.sha)}">${dot(h.failed ? "bad" : "ok")} <code>${short(h.sha)}</code> ${word(h)}</a><span class="dur">${fmtTime(h.at)}</span></li>`)}</ul></section>
    ${last
      ? html`<div class="sect"><h2>Last failure</h2><span class="aside"><a href="${commitUrl(repo.owner, repo.name, last.sha)}"><code>${short(last.sha)}</code></a> · ${fmtTime(last.finished_at)}</span></div>
        <section class="panel"><div class="pb">${last.message ? html`<pre class="msg">${last.message}</pre>` : html`<span class="muted">no message</span>`}${last.stack ? html`<details class="stack"><summary>Stack trace</summary><pre>${last.stack}</pre></details>` : ""}</div></section>`
      : ""}`,
    { crumbs: crumbsFor(repo, { label: branch, href: repoUrl(repo.owner, repo.name, branch) }, { label: "Test" }) },
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
const FILTERS = ["all", "failed", "skipped", "passed"] as const;

export async function runTestsPage(env: Env, repo: Repo, runId: number, statusParam: string | null = null): Promise<Raw> {
  const run = await runById(env, repo.repo_id, runId);
  if (!run) throw new NotFound("unknown run");
  const list = await loadTestList(env, run);
  const filter = (FILTERS as readonly string[]).includes(statusParam ?? "") ? statusParam! : "all";
  const jobLabel = run.job !== run.flag ? ` (job ${run.job})` : "";
  const crumbs = crumbsFor(repo, { label: short(run.sha), href: commitUrl(repo.owner, repo.name, run.sha) }, { label: "All tests" });
  const head = html`<div class="phead">
      <div class="eyebrow">${chip(effState(run))}<span class="branch">${run.flag}${jobLabel}</span>${repoLink(repo, run.lane === "branch" ? run.branch : null)}</div>
      <div class="row-end"><h1>All tests</h1><div class="acts"><a class="btn" href="${commitUrl(repo.owner, repo.name, run.sha)}#run-${run.id}">Run results <code>${short(run.sha)}</code></a></div></div>
      ${run.t_total !== null ? html`<div class="meta"><span>${run.t_total} total</span><span>${run.t_passed} passed</span><span>${run.t_failed} failed</span><span>${run.t_errored} errored</span><span>${run.t_skipped} skipped</span></div>` : ""}
    </div>`;
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
    return page(title, html`${head}<p class="empty">${why}</p>`, { crumbs });
  }
  const by = new Map<string, TestCase[]>();
  for (const c of list.cases) (by.get(c.status) ?? by.set(c.status, []).get(c.status)!).push(c);
  const n = (...s: string[]) => s.reduce((a, k) => a + (by.get(k)?.length ?? 0), 0);
  const counts: Record<string, number> = { all: list.cases.length, failed: n("failed", "errored"), skipped: n("skipped"), passed: n("passed") };
  const shown = GROUPS.filter((g) => filter === "all" || (filter === "failed" ? g.status === "failed" || g.status === "errored" : g.status === filter));
  const runUrl = runTestsUrl(repo.owner, repo.name, run.id);
  return page(
    title,
    html`${head}
    <div class="tools"><div class="seg" role="group" aria-label="Show">${FILTERS.map((f) => html`<a${filter === f ? raw(' class="on" aria-current="true"') : ""} href="${f === "all" ? runUrl : `${runUrl}?status=${f}`}">${f[0]!.toUpperCase() + f.slice(1)} <span class="n">${counts[f]}</span></a>`)}</div></div>
    <div class="tools" hidden><label class="field">${icon("search", 15)}<input type="search" data-search placeholder="Filter by name or file" aria-label="Filter tests by name or file"></label></div>
    ${list.cases.length === 0 ? html`<p class="empty">The report contains no test cases.</p>` : ""}
    ${shown.map((g) => {
      const items = by.get(g.status) ?? [];
      if (!items.length) return "";
      const tone = g.status === "passed" ? "ok" : g.status === "skipped" ? "idle" : "bad";
      return html`<details class="tests"${g.open || filter !== "all" ? raw(" open") : ""}><summary><span class="chip tone-${tone}">${g.title}</span><span class="cnt">${items.length}</span></summary>
        <ul class="rows">${items.slice(0, SHOW_MAX).map((c) => html`<li class="row"><span class="main">${c.suite ? `${c.suite} › ` : ""}${c.name}${c.file ? html`<span class="where">${c.file}${c.line ? `:${c.line}` : ""}</span>` : ""}</span><span class="dur">${c.durationMs !== null ? fmtDuration(c.durationMs) : ""}</span></li>`)}</ul>
        ${items.length > SHOW_MAX ? html`<p class="note">Showing the first ${SHOW_MAX} of ${items.length}.</p>` : ""}</details>`;
    })}
    <p class="tests-empty">No tests match.</p>`,
    { crumbs },
  );
}
