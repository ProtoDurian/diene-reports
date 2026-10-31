export class Raw {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]!);
}

type Part = unknown;

function render(v: Part): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(v);
}

/** Tagged template: every interpolated value is escaped unless it is `Raw` (output of another `html`). */
export function html(strings: TemplateStringsArray, ...vals: Part[]): Raw {
  let out = strings[0]!;
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1]!;
  return new Raw(out);
}

export const raw = (s: string) => new Raw(s);

/** Encode a URL path segment / query value. */
export const enc = encodeURIComponent;

import { FONT_SANS_URL } from "./assets";

export const CSP =
  "default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

export interface Crumb {
  label: string;
  href?: string;
}

/** Inline icons (stroke = currentColor). Fixed markup, never built from untrusted text. */
const ICONS: Record<string, string> = {
  menu: "<path d=\"M3 6h18M3 12h18M3 18h18\"/>",
  branch: "<circle cx=\"6\" cy=\"5\" r=\"2\"/><circle cx=\"6\" cy=\"19\" r=\"2\"/><circle cx=\"18\" cy=\"8\" r=\"2\"/><path d=\"M6 7v10M18 10c0 4-6 3-12 7\"/>",
  commit: "<circle cx=\"12\" cy=\"12\" r=\"3.5\"/><path d=\"M2 12h6.5M15.5 12H22\"/>",
  pr: "<circle cx=\"6\" cy=\"5\" r=\"2\"/><circle cx=\"6\" cy=\"19\" r=\"2\"/><circle cx=\"18\" cy=\"19\" r=\"2\"/><path d=\"M6 7v10M18 17V9a3 3 0 0 0-3-3h-3m2-3-2 3 2 3\"/>",
  alert: "<path d=\"M12 3 2 20h20L12 3zM12 10v4.5M12 17.2v.1\"/>",
  github: "<path d=\"M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22\"/>",
  ext: "<path d=\"M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5\"/>",
  search: "<circle cx=\"11\" cy=\"11\" r=\"6.5\"/><path d=\"m20 20-4.2-4.2\"/>",
  file: "<path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5zM14 3v5h5\"/>",
  folder: "<path d=\"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z\"/>",
  grid: "<rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\" rx=\"1.5\"/>",
  chevron: "<path d=\"m6 9 6 6 6-6\"/>",
};

export const icon = (name: keyof typeof ICONS | string, size = 16): Raw =>
  new Raw(`<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`);

const LOGO = new Raw(
  `<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6.5" fill="currentColor"/><g class="bars" fill="currentColor"><rect x="5" y="12" width="3" height="7" rx="1" fill="#fff" opacity=".55"/><rect x="10.5" y="8" width="3" height="11" rx="1" fill="#fff" opacity=".8"/><rect x="16" y="5" width="3" height="14" rx="1" fill="#fff"/></g></svg>`,
);

export interface PageOpts {
  crumbs?: Crumb[];
  /** the line-view script (file page) */
  script?: boolean;
}

/**
 * The app shell. Two markers are left for the request-dependent parts (the user menu and the repo list in the left
 * nav) and are filled in by the route layer; page() itself never touches the database.
 */
export function page(title: string, body: Raw, opts: PageOpts = {}): Raw {
  const crumbs = opts.crumbs ?? [];
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · diene reports</title>
<link rel="preload" href="${FONT_SANS_URL}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/ui.js" defer></script>
${opts.script ? html`<script src="/assets/line.js" defer></script>` : ""}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<input type="checkbox" id="navchk" class="navchk" aria-label="Show the project list">
<header class="topbar">
<label class="navbtn" for="navchk" title="Projects"><span class="sr">Projects</span>${icon("menu", 20)}</label>
<a class="logo" href="/">${LOGO}<span>diene reports</span></a>
${crumbs.length ? html`<nav class="crumbs" aria-label="breadcrumb"><ol>${crumbs.map((c) => html`<li>${c.href ? html`<a href="${c.href}">${c.label}</a>` : html`<span>${c.label}</span>`}</li>`)}</ol></nav>` : html`<span class="crumbs"></span>`}
<!--auth-->
</header>
<div class="shell">
<aside class="side" aria-label="Projects"><!--sidebar--></aside>
<main class="main" id="main"><div class="page">${body}</div></main>
</div>
</body>
</html>`;
}
