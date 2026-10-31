import { enc, html, icon, type Raw } from "./html";
import { effState, explain, fmtDuration, fmtPct, fmtTime, ghBlob, ghRun, parseJsonList, pct, short, stateInfo, type RunRow } from "./format";
import type { FailureRow } from "./data";
import type { SummaryDoc } from "./store";

export const repoUrl = (owner: string, name: string, branch?: string | null) =>
  `/${enc(owner)}/${enc(name)}${branch ? `?branch=${enc(branch)}` : ""}`;
export const commitUrl = (owner: string, name: string, sha: string) => `/${enc(owner)}/${enc(name)}/commit/${sha}`;
export const covUrl = (owner: string, name: string, sha: string, flag?: string) =>
  `${commitUrl(owner, name, sha)}/coverage${flag ? `?flag=${enc(flag)}` : ""}`;
export const fileUrl = (owner: string, name: string, sha: string, path: string, flag: string, line?: number) =>
  `${commitUrl(owner, name, sha)}/file?path=${enc(path)}&flag=${enc(flag)}${line ? `#L${line}` : ""}`;
export const prUrl = (owner: string, name: string, n: number) => `/${enc(owner)}/${enc(name)}/pull/${n}`;
export const runTestsUrl = (owner: string, name: string, runId: number) => `/${enc(owner)}/${enc(name)}/run/${runId}/tests`;
export const testUrl = (owner: string, name: string, id: string, branch: string) => `/${enc(owner)}/${enc(name)}/test/${enc(id)}?branch=${enc(branch)}`;

export const toneOfPct = (p: number | null) => (p === null ? "idle" : p >= 80 ? "ok" : p >= 60 ? "warn" : "bad");

/** status pill: dot + word, colour from the shared state tones */
export function chip(state: string, extra = ""): Raw {
  const s = stateInfo(state);
  return html`<span class="st tone-${s.tone}">${s.label}${extra}</span>`;
}

export function dot(tone: string, running = false): Raw {
  return html`<span class="dot tone-${tone}${running ? " run" : ""}"></span>`;
}

export function covBar(p: number | null, big = false): Raw {
  const w = p === null ? 0 : Math.max(0, Math.min(100, p));
  return html`<svg class="bar tone-${toneOfPct(p)}${big ? " lg" : ""}" viewBox="0 0 100 8" role="img" aria-label="${fmtPct(p)}" preserveAspectRatio="none"><rect class="bg" width="100" height="8"/><rect class="fg" width="${w.toFixed(1)}" height="8"/></svg>`;
}

/** coverage change in percentage points: green up, red down, grey when it did not move */
export function deltaPill(d: number | null): Raw | "" {
  if (d === null) return "";
  if (Math.abs(d) < 0.05) return html`<span class="delta zero">±0</span>`;
  return html`<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)}</span>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/** `<time>` with the exact UTC time on hover */
export function ago(ms: number | null, text: string): Raw | string {
  if (ms === null) return text;
  return html`<time datetime="${new Date(ms).toISOString()}" title="${fmtTime(ms)}">${text}</time>`;
}

/** tiny trend line (values are percentages, oldest first) */
export function spark(vals: number[]): Raw {
  if (vals.length < 2) return html`<svg class="spark flat" viewBox="0 0 112 32" width="112" height="32" aria-hidden="true"><path class="ln" d="M2 16H110"/></svg>`;
  const lo = Math.max(0, Math.min(...vals) - 2);
  const hi = Math.min(100, Math.max(...vals) + 2);
  const span = hi - lo || 1;
  const pts = vals.map((v, i) => [2 + (i / (vals.length - 1)) * 108, 29 - ((v - lo) / span) * 26] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  const last = pts[pts.length - 1]!;
  return html`<svg class="spark" viewBox="0 0 112 32" width="112" height="32" role="img" aria-label="coverage trend, last ${vals.length} runs"><path class="area" d="${d}L110 32L2 32Z"/><path class="ln" d="${d}"/><circle class="end" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5"/></svg>`;
}

/** coverage over time for one flag: server-rendered SVG, hover tooltips are native <title>s */
export function trendChart(id: string, pts: { p: number; sha: string; at: number }[]): Raw {
  const ys = pts.map((x) => x.p);
  let lo = Math.max(0, Math.floor((Math.min(...ys) - 4) / 5) * 5);
  let hi = Math.min(100, Math.ceil((Math.max(...ys) + 4) / 5) * 5);
  if (hi - lo < 10) {
    hi = Math.min(100, lo + 10);
    lo = Math.max(0, hi - 10);
  }
  const span = hi - lo || 1;
  const X = (i: number) => (pts.length === 1 ? 50 : (i / (pts.length - 1)) * 100);
  const Y = (v: number) => 38 - ((v - lo) / span) * 36;
  const line = pts.map((x, i) => `${i ? "L" : "M"}${X(i).toFixed(2)} ${Y(x.p).toFixed(2)}`).join("");
  const colW = 100 / pts.length;
  return html`<div class="chart">
    <div class="yl" aria-hidden="true"><span>${hi}%</span><span>${Math.round((hi + lo) / 2)}%</span><span>${lo}%</span></div>
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="coverage over the last ${pts.length} runs, from ${fmtPct(ys[0]!)} to ${fmtPct(ys[ys.length - 1]!)}">
      <defs><linearGradient id="cg${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-opacity=".3"/><stop offset="1" stop-opacity="0"/></linearGradient></defs>
      <path class="grid" d="M0 2H100M0 20H100M0 38H100"/>
      <path d="${line}L${X(pts.length - 1).toFixed(2)} 40L${X(0).toFixed(2)} 40Z" fill="url(#cg${id})"/>
      <path class="ln" d="${line}"/>
      ${pts.map((x, i) => html`<rect class="hov" x="${(X(i) - colW / 2).toFixed(2)}" y="0" width="${colW.toFixed(2)}" height="40"><title>${fmtPct(x.p)} · ${short(x.sha)} · ${fmtDay(x.at)}</title></rect>`)}
    </svg>
    <div class="x" aria-hidden="true"><span>${fmtDay(pts[0]!.at)}</span><span>${fmtDay(pts[pts.length - 1]!.at)}</span></div>
  </div>`;
}

/** hue (0-7) for an owner's letter badge: stable, no external avatar request */
export const hueOf = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 8;
};
export const monogram = (owner: string): Raw => html`<span class="mono-av hue-${hueOf(owner)}" aria-hidden="true">${owner.slice(0, 1)}</span>`;

export function branchChip(name: string): Raw {
  return html`<span class="branch">${icon("branch", 11)}${name}</span>`;
}

export function tile(label: string, value: string | Raw, sub: string | Raw = "", tone = "", href?: string): Raw {
  const inner = html`<div class="l">${label}</div><div class="v">${value}</div><div class="s">${sub}</div>`;
  const cls = `tile${tone ? ` mark tone-${tone}` : ""}`;
  return href ? html`<a class="${cls}" href="${href}">${inner}</a>` : html`<div class="${cls}">${inner}</div>`;
}

/**
 * Banner for runs that did not finish properly (crashed, timed out, lost, cancelled, no report, job failed after the
 * tests, still running). Failing TESTS are not run problems: they show up as failures under their flag.
 */
export function banner(runs: RunRow[]): Raw | "" {
  // inactive means "nothing to run": not a problem, so it stays out of the banner (its card says so, neutrally)
  const lines = runs
    .filter((r) => r.state !== "inactive" && r.state !== "tests_failed")
    .map((r) => ({ r, text: explain(r) }))
    .filter((x): x is { r: RunRow; text: string } => !!x.text);
  if (!lines.length) return "";
  const tones = lines.map((l) => stateInfo(effState(l.r)).tone);
  const tone = tones.includes("bad") ? "bad" : tones.includes("warn") ? "warn" : "idle";
  return html`<section class="banner tone-${tone}" role="status">
    <h2>${icon("alert", 18)}${tone === "idle" ? "Heads up" : "Run problems"}</h2>
    <ul>${lines.map((l) => html`<li><a href="#run-${l.r.id}">${l.text}</a></li>`)}</ul>
  </section>`;
}

function failureCard(f: FailureRow, owner: string, name: string, headSha: string, branchForTest: string | null): Raw {
  const ghl = ghBlob(owner, name, headSha, f.file, f.line);
  const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : null;
  const title = `${f.suite ? `${f.suite} › ` : ""}${f.name}`;
  return html`<article class="fail">
    <h4>
      ${f.is_new === 1 ? html`<span class="tag tag-new" title="Not failing on the base branch">NEW</span>` : ""}
      ${f.is_flaky ? html`<span class="tag tag-flaky" title="Passed and failed on the same code, or flips a lot">FLAKY</span>` : ""}
      ${f.status === "errored" ? html`<span class="tag tag-err">ERROR</span>` : ""}
      ${branchForTest ? html`<a href="${testUrl(owner, name, f.test_id, branchForTest)}">${title}</a>` : html`<span>${title}</span>`}
    </h4>
    ${where ? html`<p class="where">${ghl ? html`<a href="${ghl}" rel="noopener noreferrer">${where}</a>` : html`<span>${where}</span>`}${f.duration_ms !== null ? html`<span>${fmtDuration(f.duration_ms)}</span>` : ""}</p>` : ""}
    ${f.message ? html`<pre class="msg">${f.message}</pre>` : ""}
    ${f.stack ? html`<details class="stack"><summary>Stack trace</summary><pre>${f.stack}</pre></details>` : ""}
  </article>`;
}

export interface CardCtx {
  owner: string;
  name: string;
  failures: FailureRow[];
  summary: SummaryDoc | null;
  /** the project's branch, used for test-history links; null hides the links */
  testBranch: string | null;
  baseCov?: number | null;
  /** this card holds the first failures on the page: it gets the #failures anchor */
  firstFailures?: boolean;
}

export function runCard(r: RunRow, c: CardCtx): Raw {
  const state = effState(r);
  const info = stateInfo(state);
  const notes = parseJsonList(r.notes);
  const warnings = parseJsonList(r.warnings);
  const covP = pct(r.cov_lines_hit, r.cov_lines);
  const patchP = pct(r.patch_lines_hit, r.patch_lines);
  const why = explain(r);
  const hasTests = r.t_total !== null;
  const jobLabel = r.job !== r.flag ? ` (job ${r.job})` : "";
  const delta = c.baseCov !== undefined && c.baseCov !== null && covP !== null ? covP - c.baseCov : null;
  return html`<section class="panel flagsec tone-${info.tone}" id="run-${r.id}">
    <div class="ph">
      <h3 class="fn">${dot(info.tone, r.state === "started")}<span>${r.flag}</span>${jobLabel ? html`<span class="jobl">${jobLabel}</span>` : ""} ${chip(state, r.state === "errored" && r.sub_reason ? ` · ${r.sub_reason}` : "")}</h3>
      <div class="acts">
        ${hasTests && !r.over_cap ? html`<a class="btn" href="${runTestsUrl(c.owner, c.name, r.id)}">All tests</a>` : ""}
        ${covP !== null ? html`<a class="btn" href="${covUrl(c.owner, c.name, r.sha, r.flag)}">Coverage files</a>` : ""}
        <a class="btn" href="${ghRun(c.owner, c.name, r)}" rel="noopener noreferrer">GitHub job run ${icon("ext", 13)}</a>
        ${(c.summary?.raw ?? []).map((x) => html`<a class="btn" href="/${enc(c.owner)}/${enc(c.name)}/run/${r.id}/raw/${enc(x.name)}" download>${x.name}</a>`)}
      </div>
    </div>
    <div class="pb">
      ${why ? html`<p class="why">${why}</p>` : ""}
      <div class="facts">
        <div class="fact"><span class="k">Tests</span><span class="vv">${
          hasTests
            ? html`<span><strong>${r.t_total}</strong> total · ${r.t_passed} passed${r.t_failed ? html` · <b class="bad">${r.t_failed} failed</b>` : ""}${r.t_errored ? html` · <b class="bad">${r.t_errored} errored</b>` : ""}${r.t_skipped ? ` · ${r.t_skipped} skipped` : ""}</span>`
            : html`<span class="muted">no test results</span>`
        }</span></div>
        <div class="fact"><span class="k">Duration</span><span class="vv">${fmtDuration(r.duration_ms)}</span></div>
        <div class="fact"><span class="k">Coverage</span><span class="vv">${
          covP !== null
            ? html`${covBar(covP)}<strong>${fmtPct(covP)}</strong><span class="muted">${r.cov_lines_hit}/${r.cov_lines} lines</span>${r.cov_partial ? html`<b class="warn">partial</b>` : ""}${deltaPill(delta)}${delta !== null ? html`<span class="muted">vs base</span>` : ""}`
            : html`<span class="muted">no coverage</span>`
        }</span></div>
        ${patchP !== null ? html`<div class="fact"><span class="k">Patch coverage</span><span class="vv">${covBar(patchP)}<strong>${fmtPct(patchP)}</strong><span class="muted">${r.patch_lines_hit}/${r.patch_lines} changed lines</span></span></div>` : ""}
      </div>
      ${r.over_cap ? html`<p class="note">This run was over the size cap: counts are shown, full details were not uploaded.</p>` : ""}
      ${r.failures_truncated ? html`<p class="note">This list is capped at 200 failures${hasTests && !r.over_cap ? html`; <a href="${runTestsUrl(c.owner, c.name, r.id)}">the all-tests page</a> lists every test from the full report` : ""}.</p>` : ""}
      ${notes.length ? html`<ul class="notes">${notes.map((n) => html`<li>${n}</li>`)}</ul>` : ""}
      ${warnings.length ? html`<details class="warnings"><summary>${warnings.length} warning${warnings.length === 1 ? "" : "s"}</summary><ul>${warnings.map((n) => html`<li>${n}</li>`)}</ul></details>` : ""}
      ${c.failures.length ? html`<div class="fails"${c.firstFailures ? html` id="failures"` : ""}><div class="fh">${icon("alert", 14)}Failures (${c.failures.length}${r.failures_truncated ? "+" : ""})</div>${c.failures.map((f) => failureCard(f, c.owner, c.name, r.head_sha, c.testBranch))}</div>` : ""}
    </div>
  </section>`;
}
