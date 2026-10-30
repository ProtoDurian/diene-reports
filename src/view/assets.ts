export const CSS = `
:root{--bg:#fafafa;--fg:#1b1f24;--muted:#5d6672;--card:#fff;--line:#d8dde3;--ok:#1a7f37;--okbg:#e6f4ea;--bad:#c62828;--badbg:#fdecea;--warn:#8a6100;--warnbg:#fff4d6;--idle:#4a5560;--idlebg:#eceff2;--link:#0b5fd1;--code:#f1f3f5;--hit:#d9f2de;--miss:#fbd9d6;--chg:#2f6fed}
@media (prefers-color-scheme:dark){:root{--bg:#0f1318;--fg:#e6e9ee;--muted:#9aa4b0;--card:#171c22;--line:#2b333c;--ok:#5bd17a;--okbg:#14301e;--bad:#ff8a80;--badbg:#3a1a18;--warn:#f2c14e;--warnbg:#38300f;--idle:#aab4bf;--idlebg:#222a32;--link:#7ab0ff;--code:#1d242c;--hit:#14301e;--miss:#3e1c1a;--chg:#7ab0ff}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow-wrap:anywhere}
a{color:var(--link)}
code,pre{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{background:var(--code);padding:1px 4px;border-radius:4px}
pre{background:var(--code);padding:10px;border-radius:6px;overflow:auto;max-width:100%;white-space:pre-wrap;word-break:break-word;margin:6px 0}
.top{display:flex;gap:16px;align-items:center;border-bottom:1px solid var(--line);padding:0 16px;min-height:48px;background:var(--card)}
.brand{font-weight:700;color:var(--fg);text-decoration:none;display:inline-flex;align-items:center;min-height:44px}
main{max-width:980px;margin:0 auto;padding:12px 16px 48px}
h1{font-size:1.4rem;margin:12px 0 4px}h2{font-size:1.1rem;margin:24px 0 8px}h3{font-size:1rem;margin:0 0 6px}h4{margin:0;font-size:.95rem}
.sec{margin:12px 0 6px;color:var(--muted);font-weight:600}
.meta,.crumbs,.sorts{color:var(--muted);margin:4px 0 12px}
.crumbs a,.meta a{display:inline-flex;align-items:center;min-height:32px}
.branch{font-weight:400;font-size:.9rem;color:var(--muted);background:var(--idlebg);padding:2px 8px;border-radius:99px}
.empty{color:var(--muted);padding:16px;border:1px dashed var(--line);border-radius:8px}
.chip{display:inline-block;font-size:.8rem;font-weight:600;padding:1px 8px;border-radius:99px;border:1px solid currentColor;white-space:nowrap}
.tone-ok .chip,.chip.tone-ok{color:var(--ok);background:var(--okbg)}.chip.tone-bad{color:var(--bad);background:var(--badbg)}.chip.tone-warn{color:var(--warn);background:var(--warnbg)}.chip.tone-idle{color:var(--idle);background:var(--idlebg)}
.banner{border:1px solid;border-left-width:6px;border-radius:8px;padding:8px 16px;margin:12px 0}
.banner h2{margin:4px 0}.banner ul{margin:4px 0;padding-left:20px}.banner li a{display:block;padding:8px 0;min-height:44px}
details.tests{margin:12px 0}details.tests .where{color:var(--muted);font-size:.85rem;word-break:break-all}
.banner.tone-bad{border-color:var(--bad);background:var(--badbg)}.banner.tone-idle{border-color:var(--idle);background:var(--idlebg)}
.cards{display:grid;gap:12px;grid-template-columns:1fr}
@media(min-width:860px){.cards{grid-template-columns:1fr 1fr}}
.card{background:var(--card);border:1px solid var(--line);border-left:6px solid var(--idle);border-radius:8px;padding:12px 16px;min-width:0}
.card.tone-ok{border-left-color:var(--ok)}.card.tone-bad{border-left-color:var(--bad)}.card.tone-warn{border-left-color:var(--warn)}
.flag{font-weight:700}
.why{margin:2px 0 8px;font-weight:600}
.stats{margin:8px 0}.stats div{display:flex;flex-wrap:wrap;gap:4px 12px;padding:3px 0}.stats dt{color:var(--muted);min-width:110px}.stats dd{margin:0;min-width:0}
b.bad,.bad{color:var(--bad)}b.warn,.warn{color:var(--warn)}.ok{color:var(--ok)}
.note{color:var(--muted);font-style:italic;margin:4px 0}
.notes,.warnings ul{margin:4px 0;padding-left:20px;color:var(--muted)}
summary{cursor:pointer;min-height:44px;display:flex;align-items:center}
.fail{border-top:1px solid var(--line);padding:8px 0}
.fail h4{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.fail h4 a{display:inline-flex;align-items:center;min-height:32px}
.where{margin:2px 0;color:var(--muted)}.where a{display:inline-flex;min-height:32px;align-items:center}
.msg{max-height:260px}
.tag{font-size:.7rem;font-weight:700;padding:1px 6px;border-radius:4px;color:#fff}
.tag-new{background:#8250df}.tag-flaky{background:#b35900}.tag-err{background:#6e7781}
.links{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 0}
.top .auth{margin-left:auto;display:flex;align-items:center;gap:10px}.top .auth form{margin:0}.avatar{width:24px;height:24px;border-radius:50%;vertical-align:middle}
.linkbtn{font:inherit;color:var(--link);background:none;border:0;padding:0 6px;min-height:44px;cursor:pointer;text-decoration:underline}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:8px;text-decoration:none;background:var(--bg)}
.rows{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.row{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;justify-content:space-between;background:var(--card);border:1px solid var(--line);border-left:6px solid var(--idle);border-radius:8px;padding:2px 12px;min-height:48px}
.row.tone-ok{border-left-color:var(--ok)}.row.tone-bad{border-left-color:var(--bad)}.row.tone-warn{border-left-color:var(--warn)}
.row .main{display:inline-flex;align-items:center;min-height:44px;flex:1 1 220px;min-width:0}
.flags{display:flex;flex-wrap:wrap;gap:4px 10px;color:var(--muted)}.flagchip{white-space:nowrap}.cov{font-variant-numeric:tabular-nums}
.pill{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:99px;text-decoration:none;margin:0 6px 6px 0;background:var(--card)}
.pill.on{background:var(--link);color:var(--bg);border-color:var(--link)}
.bar{width:90px;height:8px;vertical-align:middle;border-radius:4px;overflow:hidden}.bar .bg{fill:var(--idlebg)}.bar .fg{fill:var(--idle)}.bar.tone-ok .fg{fill:var(--ok)}.bar.tone-warn .fg{fill:var(--warn)}.bar.tone-bad .fg{fill:var(--bad)}
.spark{margin:4px 0 12px}.spark svg{width:100%;max-width:420px;height:48px;background:var(--card);border:1px solid var(--line);border-radius:6px}.spark path{stroke:var(--link);stroke-width:2;vector-effect:non-scaling-stroke}
.tree,.tree ul{list-style:none;margin:0;padding:0}.tree ul{margin-left:14px;border-left:1px solid var(--line)}
.tree details>summary,.tree a.line{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 6px;text-decoration:none;color:var(--fg);justify-content:space-between}
.tree .nm{flex:1 1 auto;min-width:0}.tree .pc{width:56px;text-align:right;font-variant-numeric:tabular-nums}.tree .dir>details>summary{font-weight:600}
.tree a.line{color:var(--link)}
.src{overflow-x:auto;border:1px solid var(--line);border-radius:6px;background:var(--card);max-width:100%}
table.code{border-collapse:collapse;width:100%}table.code td{padding:0 6px;vertical-align:top;white-space:pre}
table.code .n{position:sticky;left:0;background:var(--card);text-align:right;color:var(--muted);user-select:none;min-width:48px}
table.code .n a{color:inherit;text-decoration:none;display:block;padding:0 4px}
table.code .h{text-align:right;color:var(--muted);min-width:40px;font-size:12px}
table.code tr.hit td.t,table.code tr.hit .h{background:var(--hit)}table.code tr.miss td.t,table.code tr.miss .h{background:var(--miss)}
table.code tr.chg td.n{box-shadow:inset 3px 0 var(--chg)}
table.code tr:target td{outline:2px solid var(--link);outline-offset:-2px}
table.code code{background:none;padding:0}
.src.only-miss tr:not(.miss),.src.only-chg tr:not(.chg){display:none}
.tools{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.tools label{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 10px;border:1px solid var(--line);border-radius:8px;background:var(--card)}
.strip{display:flex;flex-wrap:wrap;gap:3px;margin:4px 0 12px}.strip .cell{width:14px;height:28px;border-radius:3px;background:var(--ok)}.strip .cell.fail{background:var(--bad)}.strip .cell.flaky{background:#b35900}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.path{font-size:1.1rem;word-break:break-all}
@media(max-width:640px){main{padding:8px 12px 40px}.stats dt{min-width:100%}.tree .pc{width:48px}.bar{width:60px}}
`;

export const LINE_JS = `(function(){
var src=document.querySelector('.src');if(!src)return;
function box(t,cls){var l=document.createElement('label');var c=document.createElement('input');c.type='checkbox';
c.addEventListener('change',function(){src.classList.toggle(cls,c.checked)});l.appendChild(c);l.appendChild(document.createTextNode(t));return l}
var bar=document.createElement('div');bar.className='tools';
if(src.querySelector('tr.miss'))bar.appendChild(box('Uncovered lines only','only-miss'));
if(src.querySelector('tr.chg'))bar.appendChild(box('Changed lines only','only-chg'));
if(bar.children.length)src.parentNode.insertBefore(bar,src);
function go(){var id=location.hash.slice(1);var el=id&&document.getElementById(id);if(el)el.scrollIntoView({block:'center'})}
addEventListener('hashchange',go);go();
})();`;
