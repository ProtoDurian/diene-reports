import { enc, html, type Raw } from "./html";
import { effState, explain, fmtDuration, fmtPct, ghBlob, ghRun, parseJsonList, pct, stateInfo, type RunRow } from "./format";
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

export function chip(state: string, extra = ""): Raw {
  const s = stateInfo(state);
  return html`<span class="chip tone-${s.tone}">${s.label}${extra}</span>`;
}

export function covBar(p: number | null): Raw {
  const tone = p === null ? "idle" : p >= 80 ? "ok" : p >= 60 ? "warn" : "bad";
  const w = p === null ? 0 : Math.max(0, Math.min(100, p));
  return html`<svg class="bar tone-${tone}" viewBox="0 0 100 8" role="img" aria-label="${fmtPct(p)}" preserveAspectRatio="none"><rect class="bg" width="100" height="8"/><rect class="fg" width="${w.toFixed(1)}" height="8"/></svg>`;
}

export function banner(runs: RunRow[]): Raw | "" {
  // inactive means "nothing to run": not a problem, so it stays out of the banner (its card says so, neutrally)
  const lines = runs
    .filter((r) => r.state !== "inactive")
    .map((r) => ({ r, text: explain(r) }))
    .filter((x): x is { r: RunRow; text: string } => !!x.text);
  if (!lines.length) return "";
  const bad = lines.some((l) => ["bad", "warn"].includes(stateInfo(effState(l.r)).tone));
  return html`<section class="banner tone-${bad ? "bad" : "idle"}" role="status">
    <h2>${bad ? "Not everything went well" : "Heads up"}</h2>
    <ul>${lines.map((l) => html`<li><a href="#run-${l.r.id}">${l.text}</a></li>`)}</ul>
  </section>`;
}

function failureCard(f: FailureRow, owner: string, name: string, headSha: string, branchForTest: string | null): Raw {
  const ghl = ghBlob(owner, name, headSha, f.file, f.line);
  const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : null;
  return html`<article class="fail">
    <h4>
      ${f.is_new === 1 ? html`<span class="tag tag-new" title="Not failing on the base branch">NEW</span>` : ""}
      ${f.is_flaky ? html`<span class="tag tag-flaky" title="Passed and failed on the same code, or flips a lot">FLAKY</span>` : ""}
      ${f.status === "errored" ? html`<span class="tag tag-err">ERROR</span>` : ""}
      ${branchForTest ? html`<a href="${testUrl(owner, name, f.test_id, branchForTest)}">${f.suite ? `${f.suite} › ` : ""}${f.name}</a>` : html`<span>${f.suite ? `${f.suite} › ` : ""}${f.name}</span>`}
    </h4>
    ${where ? html`<p class="where">${ghl ? html`<a href="${ghl}" rel="noopener noreferrer">${where}</a>` : where}${f.duration_ms !== null ? ` · ${fmtDuration(f.duration_ms)}` : ""}</p>` : ""}
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
  showSha?: boolean;
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
  return html`<section class="card tone-${info.tone}" id="run-${r.id}">
    <h3><span class="flag">${r.flag}${jobLabel}</span> ${chip(state, r.state === "errored" && r.sub_reason ? ` · ${r.sub_reason}` : "")}</h3>
    ${why ? html`<p class="why">${why}</p>` : ""}
    <dl class="stats">
      <div><dt>Tests</dt><dd>${
        hasTests
          ? html`<strong>${r.t_total}</strong> total · ${r.t_passed} passed${r.t_failed ? html` · <b class="bad">${r.t_failed} failed</b>` : ""}${r.t_errored ? html` · <b class="bad">${r.t_errored} errored</b>` : ""}${r.t_skipped ? ` · ${r.t_skipped} skipped` : ""}`
          : "no test results"
      }</dd></div>
      <div><dt>Duration</dt><dd>${fmtDuration(r.duration_ms)}</dd></div>
      <div><dt>Coverage</dt><dd>${
        covP !== null
          ? html`${covBar(covP)} <strong>${fmtPct(covP)}</strong> · ${r.cov_lines_hit}/${r.cov_lines} lines${r.cov_partial ? html` · <b class="warn">partial</b>` : ""}${delta !== null ? html` · <span class="${delta < 0 ? "bad" : "ok"}">${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pp vs ${"base"}</span>` : ""}`
          : "no coverage"
      }</dd></div>
      ${patchP !== null ? html`<div><dt>Patch coverage</dt><dd>${covBar(patchP)} <strong>${fmtPct(patchP)}</strong> · ${r.patch_lines_hit}/${r.patch_lines} changed lines</dd></div>` : ""}
    </dl>
    ${r.over_cap ? html`<p class="note">This run was over the size cap: counts are shown, full details were not uploaded.</p>` : ""}
    ${r.failures_truncated ? html`<p class="note">This list is capped at 200 failures${hasTests && !r.over_cap ? html`; <a href="${runTestsUrl(c.owner, c.name, r.id)}">the all-tests page</a> lists every test from the full report` : ""}.</p>` : ""}
    ${notes.length ? html`<ul class="notes">${notes.map((n) => html`<li>${n}</li>`)}</ul>` : ""}
    ${warnings.length ? html`<details class="warnings"><summary>${warnings.length} warning${warnings.length === 1 ? "" : "s"}</summary><ul>${warnings.map((n) => html`<li>${n}</li>`)}</ul></details>` : ""}
    ${c.failures.length ? html`<div class="fails"><h4 class="sec">Failures (${c.failures.length}${r.failures_truncated ? "+" : ""})</h4>${c.failures.map((f) => failureCard(f, c.owner, c.name, r.head_sha, c.testBranch))}</div>` : ""}
    <p class="links">
      <a class="btn" href="${ghRun(c.owner, c.name, r)}" rel="noopener noreferrer">GitHub job run</a>
      ${hasTests && !r.over_cap ? html`<a class="btn" href="${runTestsUrl(c.owner, c.name, r.id)}">All tests</a>` : ""}
      ${covP !== null ? html`<a class="btn" href="${covUrl(c.owner, c.name, r.sha, r.flag)}">Coverage files</a>` : ""}
      ${(c.summary?.raw ?? []).map((x) => html`<a class="btn" href="/${enc(c.owner)}/${enc(c.name)}/run/${r.id}/raw/${enc(x.name)}" download>${x.name}</a>`)}
    </p>
  </section>`;
}
