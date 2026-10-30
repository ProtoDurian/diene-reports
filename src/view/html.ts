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

export const CSP =
  "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

export function page(title: string, body: Raw, opts: { nav?: Raw; script?: boolean } = {}): Raw {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} · diene reports</title>
<link rel="stylesheet" href="/assets/app.css">
${opts.script ? html`<script src="/assets/line.js" defer></script>` : ""}
</head>
<body>
<header class="top"><a class="brand" href="/">diene reports</a>${opts.nav ?? ""}</header>
<main>${body}</main>
</body>
</html>`;
}
