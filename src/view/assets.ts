import { FONT_MONO_B64, FONT_SANS_B64 } from "./fonts";

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
let sans: Uint8Array | undefined;
let mono: Uint8Array | undefined;
export const fontSans = () => (sans ??= unb64(FONT_SANS_B64));
export const fontMono = () => (mono ??= unb64(FONT_MONO_B64));
/** the file name carries the version, so the font can be cached forever */
export const FONT_SANS_URL = "/assets/geist-5.3.woff2";
export const FONT_MONO_URL = "/assets/geist-mono-5.3.woff2";

/** one design-token stylesheet: tokens first (light, then dark under the OS setting), components after */
const CSS_SRC = `
@font-face{font-family:"Geist";src:url(${FONT_SANS_URL}) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(${FONT_MONO_URL}) format("woff2");font-weight:100 900;font-display:swap}

/* ---------- tokens ---------- */
:root{
--font-sans:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--font-mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--bg:#f5f5f2;--surface:#fff;--raised:#fafaf8;--sunken:#efefeb;--line:#e4e4de;--line-2:#d2d2ca;
--fg:#14151a;--fg-2:#464a54;--fg-3:#666a75;
--accent:#2457f5;--accent-fg:#fff;--accent-soft:#e8eeff;--accent-line:#bccdff;
--ok:#12803f;--ok-soft:#e6f5ec;--ok-line:#b5e0c6;
--bad:#cc2b2b;--bad-soft:#fdecea;--bad-line:#f3bcb9;
--warn:#a35f00;--warn-soft:#fff3dc;--warn-line:#eccb90;
--idle:#5f636d;--idle-soft:#eeeeea;--idle-line:#d6d6cf;
--run:#2457f5;--run-soft:#e8eeff;--run-line:#bccdff;
--new:#6c3fd1;--flaky:#b45309;
--hit:rgba(18,128,63,.09);--miss:rgba(204,43,43,.11);--hit-bar:#12803f;--miss-bar:#cc2b2b;
--sh:0 1px 0 rgba(20,21,26,.03),0 1px 3px rgba(20,21,26,.05);
--sh-pop:0 8px 30px rgba(20,21,26,.14),0 1px 3px rgba(20,21,26,.08);
--r-sm:6px;--r:10px;--r-lg:14px;--tap:36px;--top:52px;--side:272px;
}
@media (prefers-color-scheme:dark){:root{
--bg:#090a0d;--surface:#101216;--raised:#14171c;--sunken:#0c0d10;--line:#1e2128;--line-2:#2d313b;
--fg:#eceef2;--fg-2:#aab0bc;--fg-3:#868c99;
--accent:#7f9fff;--accent-fg:#0a0b0e;--accent-soft:#16203f;--accent-line:#2b3d78;
--ok:#43d27f;--ok-soft:#10271a;--ok-line:#1e4a31;
--bad:#ff7070;--bad-soft:#2b1214;--bad-line:#5a2326;
--warn:#f6b84f;--warn-soft:#2a2008;--warn-line:#57420f;
--idle:#9aa0ab;--idle-soft:#1a1c21;--idle-line:#2d3038;
--run:#7f9fff;--run-soft:#16203f;--run-line:#2b3d78;
--new:#b494ff;--flaky:#f59e4b;
--hit:rgba(67,210,127,.1);--miss:rgba(255,112,112,.12);--hit-bar:#43d27f;--miss-bar:#ff7070;
--sh:0 0 0 rgba(0,0,0,0);--sh-pop:0 10px 36px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.04);
}}
.tone-ok{--t:var(--ok);--ts:var(--ok-soft);--tl:var(--ok-line)}
.tone-bad{--t:var(--bad);--ts:var(--bad-soft);--tl:var(--bad-line)}
.tone-warn{--t:var(--warn);--ts:var(--warn-soft);--tl:var(--warn-line)}
.tone-idle{--t:var(--idle);--ts:var(--idle-soft);--tl:var(--idle-line)}
.tone-run{--t:var(--run);--ts:var(--run-soft);--tl:var(--run-line)}

/* ---------- base ---------- */
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-top:calc(var(--top) + 16px)}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 var(--font-sans);letter-spacing:-.006em;overflow-wrap:anywhere;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
h1,h2,h3,h4,p,ul,ol,dl,dd,figure{margin:0}
h1{font-size:1.65rem;line-height:1.2;font-weight:620;letter-spacing:-.03em}
h2{font-size:1rem;font-weight:620;letter-spacing:-.015em}
h3{font-size:.95rem;font-weight:600}
code,pre,kbd{font:12.5px/1.55 var(--font-mono);letter-spacing:0}
code{background:var(--sunken);padding:1px 5px;border-radius:5px;border:1px solid var(--line)}
pre{background:var(--sunken);border:1px solid var(--line);padding:10px 12px;border-radius:var(--r-sm);overflow:auto;max-width:100%;white-space:pre-wrap;word-break:break-word;margin:8px 0 0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:8px;top:-60px;background:var(--accent);color:var(--accent-fg);padding:8px 12px;border-radius:8px;z-index:100}
.skip:focus{top:8px}
.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.mono{font-family:var(--font-mono);letter-spacing:0}
.muted{color:var(--fg-3)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
b.bad,b.warn{font-weight:600}
svg{display:block}

/* ---------- shell ---------- */
.navchk{position:absolute;opacity:0;pointer-events:none}
.topbar{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:14px;height:var(--top);padding:0 16px;background:color-mix(in srgb,var(--surface) 88%,transparent);-webkit-backdrop-filter:saturate(1.4) blur(12px);backdrop-filter:saturate(1.4) blur(12px);border-bottom:1px solid var(--line)}
.navbtn{display:none;align-items:center;justify-content:center;width:44px;height:44px;margin-left:-10px;border-radius:10px;color:var(--fg-2);cursor:pointer}
.navbtn:hover{background:var(--sunken)}
.navchk:focus-visible~.topbar .navbtn{outline:2px solid var(--accent)}
.logo{display:inline-flex;align-items:center;gap:9px;color:var(--fg);font-weight:650;letter-spacing:-.02em;white-space:nowrap}
.logo:hover{text-decoration:none}
.logo svg{width:24px;height:24px;color:var(--accent)}
.logo .bars{color:var(--accent-fg)}
.crumbs{min-width:0;flex:1 1 auto;overflow:hidden}
.crumbs ol{display:flex;align-items:center;gap:0;list-style:none;padding:0;margin:0;font-size:.9rem;white-space:nowrap}
.crumbs li{display:inline-flex;align-items:center;min-width:0}
.crumbs li+li::before{content:"/";color:var(--line-2);margin:0 9px;font-weight:300}
.crumbs a,.crumbs span{color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;display:inline-block;max-width:34ch}
.crumbs a:hover{color:var(--fg);text-decoration:none}
.crumbs li:last-child a,.crumbs li:last-child span{color:var(--fg);font-weight:560}
.auth{margin-left:auto;display:flex;align-items:center;gap:10px;flex:0 0 auto}
.auth form{margin:0}
.avatar{width:28px;height:28px;border-radius:50%;border:1px solid var(--line-2);background:var(--sunken)}
.umenu{position:relative}
.umenu>summary{list-style:none;display:flex;align-items:center;gap:8px;min-height:var(--tap);padding:0 8px 0 4px;border-radius:99px;cursor:pointer;font-weight:520;color:var(--fg)}
.umenu>summary::-webkit-details-marker{display:none}
.umenu>summary:hover{background:var(--sunken)}
.umenu .who{max-width:16ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.umenu .pop{position:absolute;right:0;top:calc(100% + 6px);min-width:220px;background:var(--surface);border:1px solid var(--line-2);border-radius:var(--r);box-shadow:var(--sh-pop);padding:6px;z-index:60}
.pop .hd{padding:8px 10px;color:var(--fg-3);font-size:.8rem;border-bottom:1px solid var(--line);margin-bottom:6px}
.pop .hd b{display:block;color:var(--fg);font-size:.95rem;font-weight:600}
.pop button,.pop a.item{display:flex;width:100%;align-items:center;min-height:var(--tap);padding:0 10px;border:0;background:none;border-radius:var(--r-sm);font:inherit;color:var(--fg);cursor:pointer;text-align:left}
.pop button:hover,.pop a.item:hover{background:var(--sunken);text-decoration:none}
.shell{display:grid;grid-template-columns:var(--side) minmax(0,1fr);min-height:calc(100vh - var(--top));background:linear-gradient(to right,var(--surface) calc(var(--side) - 1px),var(--line) calc(var(--side) - 1px),var(--line) var(--side),transparent var(--side))}
.side{position:sticky;top:var(--top);align-self:start;height:calc(100vh - var(--top));overflow:auto;padding:18px 12px 32px;border-right:1px solid var(--line);background:var(--surface)}
.side h2{font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--fg-3);padding:0 10px;margin:0 0 8px}
.side .org{margin:16px 0 4px;padding:0 10px;display:flex;align-items:center;gap:8px;font-size:.82rem;font-weight:600;color:var(--fg-2)}
.side ul{list-style:none;margin:0;padding:0}
.side a.nav{display:flex;align-items:center;gap:10px;min-height:var(--tap);padding:0 10px;border-radius:var(--r-sm);color:var(--fg-2);font-size:.9rem}
.side a.nav:hover{background:var(--sunken);color:var(--fg);text-decoration:none}
.side a.nav[aria-current]{background:var(--accent-soft);color:var(--accent);font-weight:560}
.side a.nav .nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side .none{padding:0 10px;color:var(--fg-3);font-size:.85rem}
.main{min-width:0;padding:30px 36px 80px}
.page{max-width:1120px;margin:0 auto}
.mono-av{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px;font:600 .68rem/1 var(--font-sans);color:#fff;text-transform:uppercase;flex:0 0 auto}
.hue-0{background:#3b6ef0}.hue-1{background:#0f9b8e}.hue-2{background:#c2410c}.hue-3{background:#9333ea}.hue-4{background:#be185d}.hue-5{background:#4d7c0f}.hue-6{background:#0e7490}.hue-7{background:#a16207}

/* ---------- primitives ---------- */
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--t,var(--idle));box-shadow:0 0 0 3px var(--ts,var(--idle-soft));flex:0 0 auto}
.dot.run{animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{box-shadow:0 0 0 5px transparent}}
@media (prefers-reduced-motion:reduce){.dot.run{animation:none}*{scroll-behavior:auto!important}}
.st{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px 0 8px;border-radius:99px;font-size:.76rem;font-weight:560;letter-spacing:0;white-space:nowrap;color:var(--t);background:var(--ts);border:1px solid var(--tl)}
.st::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.st.big{height:28px;padding:0 12px 0 10px;font-size:.86rem}
.st.big::before{width:8px;height:8px}
.chip{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:6px;font-size:.76rem;font-weight:560;color:var(--t);background:var(--ts);border:1px solid var(--tl);white-space:nowrap}
.branch{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:6px;font:500 .76rem/1 var(--font-mono);color:var(--fg-2);background:var(--sunken);border:1px solid var(--line);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.branch svg{width:11px;height:11px;flex:0 0 auto;opacity:.7}
.tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;font-size:.66rem;font-weight:700;letter-spacing:.06em;color:#fff;vertical-align:middle}
.tag-new{background:var(--new)}.tag-flaky{background:var(--flaky)}.tag-err{background:var(--idle)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:var(--tap);padding:0 14px;border:1px solid var(--line-2);border-radius:var(--r-sm);background:var(--surface);color:var(--fg);font:inherit;font-size:.88rem;font-weight:520;cursor:pointer;box-shadow:var(--sh);white-space:nowrap}
.btn:hover{background:var(--raised);text-decoration:none;border-color:var(--fg-3)}
.btn.primary,.btn.signin{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.btn.primary:hover,.btn.signin:hover{background:var(--fg-2);border-color:var(--fg-2)}
.btn svg{width:15px;height:15px}
.linkbtn{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.seg{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;background:var(--sunken);border:1px solid var(--line);border-radius:9px}
.seg a,.seg button{display:inline-flex;align-items:center;gap:6px;min-height:calc(var(--tap) - 8px);padding:0 12px;border:0;border-radius:7px;background:none;color:var(--fg-2);font:inherit;font-size:.85rem;font-weight:520;cursor:pointer}
.seg a:hover,.seg button:hover{color:var(--fg);text-decoration:none}
.seg .on,.seg [aria-pressed=true]{background:var(--surface);color:var(--fg);box-shadow:0 0 0 1px var(--line-2),var(--sh)}
.seg .n{color:var(--fg-3);font-variant-numeric:tabular-nums}
.menu{position:relative;display:inline-block}
.menu>summary{list-style:none;cursor:pointer}
.menu>summary::-webkit-details-marker{display:none}
.menu .pop{position:absolute;left:0;top:calc(100% + 6px);min-width:240px;max-height:min(60vh,420px);overflow:auto;background:var(--surface);border:1px solid var(--line-2);border-radius:var(--r);box-shadow:var(--sh-pop);padding:6px;z-index:40}
.menu .pop a{display:flex;align-items:center;gap:8px;min-height:var(--tap);padding:0 10px;border-radius:var(--r-sm);color:var(--fg);font:500 .84rem var(--font-mono)}
.menu .pop a:hover{background:var(--sunken);text-decoration:none}
.menu .pop a.on{background:var(--accent-soft);color:var(--accent)}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);min-width:0}
.panel>.ph{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line)}
.panel>.pb{padding:14px 16px}
.sect{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:32px 0 12px}
.sect h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.09em;color:var(--fg-3);font-weight:600}
.sect .aside{color:var(--fg-3);font-size:.85rem}
.empty{color:var(--fg-2);padding:28px 20px;border:1px dashed var(--line-2);border-radius:var(--r);background:var(--raised);text-align:center}
.note{color:var(--fg-3);font-size:.85rem;margin-top:8px}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;color:var(--fg-2);font-size:.88rem}
.meta>*{display:inline-flex;align-items:center;gap:6px;min-width:0}
.meta a{color:var(--fg-2);text-decoration:underline;text-decoration-color:var(--line-2);text-underline-offset:3px}
.meta a:hover{color:var(--accent);text-decoration-color:currentColor}
.sep{color:var(--line-2)}
.phead{position:relative;padding:4px 0 26px}
.phead::before{content:"";position:absolute;inset:-30px -36px 0 -36px;z-index:-1;pointer-events:none;background-image:radial-gradient(var(--line-2) 1px,transparent 1px);background-size:18px 18px;-webkit-mask-image:linear-gradient(180deg,#000 0,transparent 92%);mask-image:linear-gradient(180deg,#000 0,transparent 92%);opacity:.7}
.phead .eyebrow{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.phead h1{margin-bottom:10px}
.phead .row-end{display:flex;align-items:flex-start;gap:16px;justify-content:space-between;flex-wrap:wrap}
.phead .acts{display:flex;gap:8px;flex-wrap:wrap}
.page{position:relative;z-index:0}

/* coverage bar + sparkline */
.bar{width:96px;height:6px;border-radius:99px;overflow:hidden;flex:0 0 auto}
.bar .bg{fill:var(--sunken)}.bar .fg{fill:var(--idle)}.bar.tone-ok .fg{fill:var(--ok)}.bar.tone-warn .fg{fill:var(--warn)}.bar.tone-bad .fg{fill:var(--bad)}
.bar.lg{width:100%;height:8px}
.spark{width:112px;height:32px;overflow:visible}
.spark .area{fill:var(--accent);opacity:.12}
.spark .ln{fill:none;stroke:var(--accent);stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}
.spark .end{fill:var(--accent)}
.spark.flat .ln{stroke:var(--line-2)}

/* home */
.stats{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.stats{margin-bottom:22px}
.tile{padding:14px 16px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);min-width:0;position:relative;overflow:hidden}
.tile .l{font-size:.76rem;color:var(--fg-3);font-weight:520;display:flex;align-items:center;gap:7px;text-transform:uppercase;letter-spacing:.06em}
.tile .v{font-size:1.9rem;line-height:1.15;font-weight:620;letter-spacing:-.035em;margin-top:6px;font-variant-numeric:tabular-nums}
.tile .v small{font-size:.9rem;font-weight:500;color:var(--fg-3);letter-spacing:0;margin-left:2px}
.tile .s{font-size:.8rem;color:var(--fg-3);margin-top:2px;min-height:1.2em}
.tile.tone-bad .v,.tile.tone-warn .v,.tile.tone-ok .v{color:var(--t)}
.tile.mark::after{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--t)}
.stats a.tile{color:inherit}.stats a.tile:hover{text-decoration:none;border-color:var(--line-2)}
.orgh{display:flex;align-items:center;gap:10px;margin:30px 0 10px}
.orgh h2{font-size:1.05rem}
.orgh .mono-av{width:26px;height:26px;border-radius:8px;font-size:.8rem}
.orgh .c{color:var(--fg-3);font-size:.85rem}
.repos{list-style:none;padding:0;margin:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
.repos .row{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1.3fr) 200px;align-items:center;gap:8px 20px;padding:14px 18px;border-top:1px solid var(--line);position:relative}
.repos .row:first-child{border-top:0}
.repos .row:hover{background:var(--raised)}
.repos .row .id{display:flex;align-items:center;gap:12px;min-width:0}
.repos .row .id .dot{width:10px;height:10px}
.repos .row .name{font-weight:600;font-size:.98rem;letter-spacing:-.015em;color:var(--fg);display:inline-flex;align-items:center;min-height:var(--tap)}
.repos .row .name::after{content:"";position:absolute;inset:0}
.repos .row .name:hover{text-decoration:none;color:var(--accent)}
.repos .row .sub{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--fg-3);font-size:.82rem}
.repos .row .more{position:relative;z-index:1;color:var(--fg-3)}
.fl{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px 0 8px;border-radius:99px;font-size:.78rem;font-weight:520;color:var(--fg-2);background:var(--raised);border:1px solid var(--line);white-space:nowrap}
.fl .dot{width:6px;height:6px;box-shadow:none}
.fl.tone-bad{border-color:var(--tl);background:var(--ts);color:var(--t)}
.fl.tone-warn{border-color:var(--tl);background:var(--ts);color:var(--t)}
.fls{display:flex;flex-wrap:wrap;gap:6px}
.cov{display:flex;align-items:center;gap:12px;min-width:0}
.cov .pc{font-size:1.35rem;font-weight:620;letter-spacing:-.03em;font-variant-numeric:tabular-nums;min-width:4.6ch}
.cov .pc small{font-size:.8rem;color:var(--fg-3);font-weight:500;letter-spacing:0}
.cov .na{color:var(--fg-3);font-size:.9rem}

/* tables */
.tbl{width:100%;border-collapse:collapse;background:var(--surface);font-size:.9rem}
.tblw{border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden;background:var(--surface)}
.tbl th{text-align:left;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-3);padding:10px 14px;background:var(--raised);border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{padding:12px 14px;border-top:1px solid var(--line);vertical-align:middle}
.tbl tbody tr:first-child td{border-top:0}
.tbl tbody tr:hover{background:var(--raised)}
.tbl .r{text-align:right}
.tbl .msg1{font-weight:540;color:var(--fg);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:44ch}
.tbl .msg1:hover{color:var(--accent);text-decoration:none}
.tbl .shaline{display:flex;align-items:center;gap:8px;color:var(--fg-3);font-size:.8rem;margin-top:2px}
.tbl .shaline code{font-size:.74rem}
.delta{font-size:.8rem;font-weight:560;font-variant-numeric:tabular-nums}
.delta.up{color:var(--ok)}.delta.down{color:var(--bad)}.delta.zero{color:var(--fg-3)}
.pcnum{font-weight:600;font-variant-numeric:tabular-nums}

/* repo: heads + trend */
.heads{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}
.head{padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.head .top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.head .fname{font-weight:620;display:inline-flex;align-items:center;gap:8px;letter-spacing:-.01em}
.head .big{font-size:2rem;font-weight:620;letter-spacing:-.04em;line-height:1;font-variant-numeric:tabular-nums}
.head .sub{color:var(--fg-3);font-size:.82rem;display:flex;flex-wrap:wrap;gap:2px 10px}
.trends{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}
.trend{padding:14px 16px 12px}
.trend .th{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px}
.trend .th b{font-weight:620}
.trend .th .big{font-size:1.5rem;font-weight:620;letter-spacing:-.035em;font-variant-numeric:tabular-nums}
.chart{display:grid;grid-template-columns:34px minmax(0,1fr);gap:8px;align-items:stretch}
.chart .yl{display:flex;flex-direction:column;justify-content:space-between;text-align:right;color:var(--fg-3);font-size:.7rem;font-variant-numeric:tabular-nums;line-height:1}
.chart svg{width:100%;height:128px}
.chart .grid{stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke}
.chart .ln{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.chart .hov{fill:transparent}
.chart .hov:hover{fill:var(--accent-soft)}
.chart stop{stop-color:var(--accent)}
.chart .x{grid-column:2;display:flex;justify-content:space-between;color:var(--fg-3);font-size:.7rem;margin-top:-2px}
.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--fg-3);font-size:.8rem}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px}

/* commit */
.verdict{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.cmsg{font-size:1.6rem;max-width:34ch}
.banner{border:1px solid var(--tl);border-left:4px solid var(--t);background:var(--ts);border-radius:var(--r);padding:14px 18px;margin:0 0 22px}
.banner h2{display:flex;align-items:center;gap:9px;color:var(--t);font-size:.98rem;margin-bottom:4px}
.banner h2 svg{width:18px;height:18px}
.banner ul{list-style:none;padding:0;margin:0}
.banner li a{display:block;padding:7px 0;min-height:var(--tap);color:var(--fg);font-weight:500}
.banner li a:hover{color:var(--t);text-decoration:underline}
.banner li+li{border-top:1px solid var(--tl)}
.flagsec{margin:0 0 18px;scroll-margin-top:calc(var(--top) + 16px)}
.flagsec>.ph{align-items:center}
.flagsec .fn{font-size:1.02rem;font-weight:650;letter-spacing:-.02em;display:inline-flex;align-items:center;gap:10px}
.flagsec .jobl{color:var(--fg-3);font-weight:400;font-size:.85rem}
.flagsec .acts{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.flagsec .acts .btn{min-height:32px;padding:0 11px;font-size:.82rem}
.why{font-weight:560;color:var(--t);margin-bottom:10px}
.facts{display:flex;flex-wrap:wrap;gap:8px 28px;margin-bottom:2px}
.fact{min-width:0}
.fact .k{display:block;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-3);font-weight:600;margin-bottom:2px}
.fact .vv{font-weight:560;font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.notes{margin:10px 0 0;padding-left:18px;color:var(--fg-2);font-size:.88rem}
details.warnings{margin-top:8px;color:var(--fg-2);font-size:.88rem}
details.warnings ul{margin:4px 0;padding-left:18px}
summary{cursor:pointer}
details>summary{min-height:var(--tap);display:flex;align-items:center}
.fails{margin-top:16px;border-top:1px solid var(--line)}
.fails>.fh{display:flex;align-items:center;gap:8px;margin:14px 0 4px;font-size:.78rem;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-3);font-weight:600}
.fail{padding:12px 0;border-top:1px solid var(--line)}
.fails>.fh+.fail{border-top:0}
.fail h4{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;font-size:.94rem;font-weight:580;line-height:1.35}
.fail h4 a{color:var(--fg);display:inline-flex;align-items:center;min-height:28px}
.fail h4 a:hover{color:var(--accent)}
.fail .where{margin-top:3px;color:var(--fg-3);font:.78rem var(--font-mono);display:flex;gap:6px 12px;flex-wrap:wrap}
.fail .where a{color:var(--fg-3);text-decoration:underline;text-decoration-color:var(--line-2);text-underline-offset:3px;display:inline-flex;align-items:center;min-height:28px}
.fail .where a:hover{color:var(--accent)}
.fail pre.msg{max-height:260px;border-left:3px solid var(--bad);border-radius:var(--r-sm);background:var(--bad-soft);border-color:var(--bad-line);border-left-color:var(--bad);color:var(--fg)}
.fail details.stack{margin-top:2px}
.fail details.stack>summary{color:var(--fg-3);font-size:.82rem;font-weight:520;gap:6px;min-height:var(--tap)}
.fail details.stack>summary::before{content:"▸";font-size:.7rem;transition:transform .12s}
.fail details.stack[open]>summary::before{transform:rotate(90deg)}
.fail details.stack pre{max-height:320px;font-size:.75rem}
.fail[hidden]{display:none}
.tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px}
.tools[hidden]{display:none}
.field{display:inline-flex;align-items:center;gap:8px;min-height:var(--tap);padding:0 12px;border:1px solid var(--line-2);border-radius:var(--r-sm);background:var(--surface);color:var(--fg-2);font-size:.88rem;cursor:pointer}
.field input[type=search]{border:0;background:none;font:inherit;color:var(--fg);min-width:0;width:200px;outline:none}
.field:focus-within{outline:2px solid var(--accent);outline-offset:1px}
.field svg{width:15px;height:15px;flex:0 0 auto;color:var(--fg-3)}
.field input[type=checkbox]{accent-color:var(--accent);width:16px;height:16px}

/* coverage tree */
.tree,.tree ul{list-style:none;margin:0;padding:0}
.tree>li:first-child>*{border-top:0}
.tree ul{margin-left:19px;border-left:1px solid var(--line)}
.tree details>summary,.tree a.line{display:grid;grid-template-columns:minmax(0,1fr) 120px 62px 74px;align-items:center;gap:14px;min-height:var(--tap);padding:0 16px 0 12px;color:var(--fg);border-top:1px solid var(--line);list-style:none}
.tree details>summary::-webkit-details-marker{display:none}
.tree details>summary:hover,.tree a.line:hover{background:var(--raised);text-decoration:none}
.tree .nm{display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tree .nm svg{width:15px;height:15px;color:var(--fg-3);flex:0 0 auto}
.tree .dir>details>summary .nm{font-weight:580}
.tree details>summary .nm::before{content:"▸";font-size:.65rem;color:var(--fg-3);transition:transform .12s;width:10px}
.tree details[open]>summary .nm::before{transform:rotate(90deg)}
.tree .pc{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.tree .ln2{text-align:right;color:var(--fg-3);font-size:.8rem;font-variant-numeric:tabular-nums}
.tree a.line{color:var(--fg)}
.tree a.line .nm{color:var(--fg-2)}
.tree a.line:hover .nm{color:var(--accent)}
.thead{display:grid;grid-template-columns:minmax(0,1fr) 120px 62px 74px;gap:14px;padding:9px 16px 9px 12px;background:var(--raised);border-bottom:1px solid var(--line);font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-3)}
.thead span:nth-child(n+3){text-align:right}
.covhero{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 28px;align-items:center;padding:18px 20px}
.covhero .bigp{font-size:3rem;font-weight:620;letter-spacing:-.05em;line-height:1;font-variant-numeric:tabular-nums}
.covhero .bigp small{font-size:1.2rem;color:var(--fg-3);letter-spacing:0}

/* PR */
.prhero{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.patch{padding:20px 22px;display:flex;flex-direction:column;gap:12px}
.patch .lab{display:flex;align-items:center;gap:10px;font-weight:620;letter-spacing:-.01em}
.patch .huge{font-size:3.6rem;font-weight:620;letter-spacing:-.055em;line-height:1;font-variant-numeric:tabular-nums}
.patch .huge small{font-size:1.4rem;color:var(--fg-3);letter-spacing:0}
.patch .of{color:var(--fg-3);font-size:.86rem}
.files{list-style:none;padding:0;margin:0}
.files li{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;justify-content:space-between;padding:10px 16px;border-top:1px solid var(--line)}
.files li:first-child{border-top:0}
.files .fp{font:.84rem var(--font-mono);color:var(--fg);min-height:var(--tap);display:inline-flex;align-items:center;min-width:0;flex:1 1 240px}
.files .fp:hover{color:var(--accent);text-decoration:none}
.lines{display:flex;flex-wrap:wrap;gap:4px;align-items:center;color:var(--fg-3);font-size:.8rem}
.lines a{font:500 .74rem var(--font-mono);padding:2px 6px;border-radius:5px;background:var(--bad-soft);color:var(--bad);border:1px solid var(--bad-line);display:inline-flex;align-items:center;min-height:24px}
.lines a:hover{text-decoration:none;background:var(--bad);color:#fff}

/* code viewer */
.fileh{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:12px 16px;border:1px solid var(--line);border-bottom:0;border-radius:var(--r) var(--r) 0 0;background:var(--raised)}
.fileh .grow{flex:1 1 auto}
.src{overflow:auto;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);max-width:100%}
.fileh+.tools{margin:0;padding:10px 16px;border:1px solid var(--line);border-top:0;border-bottom:0;background:var(--raised)}
.fileh+.src,.fileh+.tools+.src{border-radius:0 0 var(--r) var(--r)}
.legend-k{display:flex;gap:16px;flex-wrap:wrap;font-size:.8rem;color:var(--fg-3);align-items:center}
.legend-k i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-2px;border:1px solid transparent}
.k-hit{background:var(--hit);border-color:var(--hit-bar)!important}.k-miss{background:var(--miss);border-color:var(--miss-bar)!important}.k-chg{background:var(--accent);}
table.code{border-collapse:separate;border-spacing:0;width:100%;font:12.5px/21px var(--font-mono);letter-spacing:0}
table.code td{padding:0;vertical-align:top;white-space:pre}
table.code td.n{position:sticky;left:0;z-index:1;background:var(--raised);text-align:right;color:var(--fg-3);user-select:none;min-width:54px;border-right:1px solid var(--line);box-shadow:inset 3px 0 transparent}
table.code td.n a{color:inherit;display:block;padding:0 10px 0 8px;text-decoration:none}
table.code td.n a:hover{color:var(--accent)}
table.code td.h{text-align:right;color:var(--fg-3);min-width:46px;padding:0 8px;font-size:11px;user-select:none;border-right:1px solid var(--line);background:var(--raised)}
table.code td.t{padding:0 16px 0 14px;width:100%}
table.code code{background:none;border:0;padding:0;font:inherit}
table.code tr.hit td.n{box-shadow:inset 3px 0 var(--hit-bar)}table.code tr.hit td.t{background:var(--hit)}
table.code tr.miss td.n{box-shadow:inset 3px 0 var(--miss-bar)}table.code tr.miss td.t{background:var(--miss)}
table.code tr.miss td.h{color:var(--bad);font-weight:700}
table.code tr.chg td.h{box-shadow:inset -3px 0 var(--accent)}
table.code tr.chg td.t{box-shadow:inset 0 0 0 9999px color-mix(in srgb,var(--accent) 7%,transparent)}
table.code tr:target td.t{outline:2px solid var(--accent);outline-offset:-2px}
table.code tr:target td.n{background:var(--accent-soft)}
.src.only-miss tr:not(.miss),.src.only-chg tr:not(.chg){display:none}

/* test list + history */
details.tests{margin:0 0 14px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
details.tests>summary{padding:0 16px;gap:10px;min-height:48px;font-weight:560}
details.tests>summary::before{content:"▸";font-size:.7rem;color:var(--fg-3);transition:transform .12s}
details.tests[open]>summary::before{transform:rotate(90deg)}
details.tests>summary .cnt{margin-left:auto;color:var(--fg-3);font-variant-numeric:tabular-nums;font-weight:500}
.rows{list-style:none;margin:0;padding:0}
.rows>li.row{display:flex;flex-wrap:wrap;gap:2px 16px;align-items:center;justify-content:space-between;padding:8px 16px;min-height:var(--tap);border-top:1px solid var(--line);font-size:.9rem}
.rows .main{display:flex;flex-direction:column;min-width:0;flex:1 1 280px;color:var(--fg)}
.rows .where{color:var(--fg-3);font:.76rem var(--font-mono)}
.rows .dur{color:var(--fg-3);font-size:.82rem;font-variant-numeric:tabular-nums}
.rows>li.hide{display:none}
.clip{overflow:hidden}
.strip a{display:block;width:16px;height:34px;border-radius:4px;background:var(--ok);opacity:.8;position:relative}
.strip a.fail{background:var(--bad);opacity:1}.strip a.flaky{background:var(--flaky);opacity:1}
.strip a:hover{opacity:1;transform:translateY(-2px);transition:transform .1s}
.strip{display:flex;flex-wrap:wrap;gap:4px}
.tests-empty{display:none;padding:28px;text-align:center;color:var(--fg-3)}
.path{font-size:1.25rem;font-family:var(--font-mono);letter-spacing:-.02em;word-break:break-all;font-weight:560}
.path .d{color:var(--fg-3);font-weight:400}

/* error */
.err{max-width:520px;margin:10vh auto 0;text-align:center}
.err .code404{font:600 4.4rem/1 var(--font-mono);letter-spacing:-.06em;color:var(--line-2);margin-bottom:10px}
.err p{margin:10px 0 22px;color:var(--fg-2)}
.err .acts{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}

/* howto */
.howto{text-align:left;max-width:640px;margin:18px auto 0}
.howto pre{margin:0;background:var(--sunken);font-size:.78rem;line-height:1.6}

/* ---------- responsive ---------- */
@media (max-width:1100px){.repos .row{grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) 180px}}
@media (max-width:1023px){
.shell{grid-template-columns:minmax(0,1fr);background:none}
.navbtn{display:inline-flex}
.side{display:none;position:fixed;inset:var(--top) 0 0 0;height:auto;z-index:45;border-right:0;padding-bottom:60px}
.navchk:checked~.shell .side{display:block}
.main{padding:22px 20px 64px}
.phead::before{inset:-24px -20px 0 -20px}
.crumbs a,.crumbs span{max-width:18ch}
}
@media (max-width:640px){
:root{--tap:44px;--top:56px}
body{font-size:15px}
h1{font-size:1.4rem}
.main{padding:16px 16px 56px}
.phead::before{inset:-16px -16px 0 -16px}
.topbar{gap:8px;padding:0 12px}
.crumbs{display:none}
.topbar{gap:10px}
.umenu .who{display:none}
.btn,.seg a,.seg button{min-height:44px}
.flagsec .acts .btn{min-height:44px}
.repos .row{grid-template-columns:minmax(0,1fr) auto;padding:14px 16px}
.repos .row .fls{grid-column:1/-1;order:3}
.repos .row .cov{grid-column:2;grid-row:1;justify-content:flex-end}
.repos .row .cov .spark{display:none}
.stats{grid-template-columns:1fr 1fr}
.stats>:last-child:nth-child(odd){grid-column:1/-1}
.tile .v{font-size:1.6rem}
.cmsg{font-size:1.3rem}
.tbl thead{display:none}
.tbl,.tbl tbody,.tbl tr,.tbl td{display:block;width:100%}
.tbl tr{padding:12px 14px;border-top:1px solid var(--line);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px}
.tbl tbody tr:first-child{border-top:0}
.tbl td{padding:0;border:0}
.tbl td.c-main{grid-column:1/-1}
.tbl td.c-flags{grid-column:1/-1}
.tbl .msg1{max-width:none;white-space:normal}
.tree details>summary,.tree a.line,.thead{grid-template-columns:minmax(0,1fr) 70px 54px}
.tree .ln2,.thead span:nth-child(4){display:none}
.tree .bar{width:70px}
.covhero{grid-template-columns:1fr}
.covhero .bigp{font-size:2.4rem}
.patch .huge{font-size:3rem}
.chart svg{height:110px}
.trends,.heads{grid-template-columns:1fr}
.fileh{padding:10px 12px}
.field input[type=search]{width:140px}
.tools{gap:8px}
.menu .pop,.umenu .pop{position:fixed;left:12px;right:12px;top:calc(var(--top) + 6px);min-width:0}
.rows>li.row{padding:10px 16px}
.fail pre.msg{max-height:200px}
}
@media (pointer:coarse){:root{--tap:44px}}
@media print{.side,.topbar,.tools{display:none}.shell{display:block}}
`;

/** conservative minifier: drops comments and the spaces around braces, semicolons, commas and `>` */
export const CSS = CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\s*([{};,>])\s*/g, "$1")
  .replace(/\n+/g, "")
  .replace(/;}/g, "}")
  .trim();

/** the line view: "uncovered only" / "changed only" filters and jumping to #L<n> */
export const LINE_JS = `(function(){
var src=document.querySelector('.src');if(!src)return;
function box(t,cls){var l=document.createElement('label');l.className='field';var c=document.createElement('input');c.type='checkbox';
c.addEventListener('change',function(){src.classList.toggle(cls,c.checked)});l.appendChild(c);l.appendChild(document.createTextNode(t));return l}
var bar=document.createElement('div');bar.className='tools';
if(src.querySelector('tr.miss'))bar.appendChild(box('Uncovered lines only','only-miss'));
if(src.querySelector('tr.chg'))bar.appendChild(box('Changed lines only','only-chg'));
if(bar.children.length)src.parentNode.insertBefore(bar,src);
function go(){var id=location.hash.slice(1);var el=id&&document.getElementById(id);if(el)el.scrollIntoView({block:'center'})}
addEventListener('hashchange',go);go();
})();`;

/** small shared behaviour: close pop-up menus, test search. Everything works without it. */
export const UI_JS = `(function(){
var d=document;
d.addEventListener('click',function(e){d.querySelectorAll('details.menu[open],details.umenu[open]').forEach(function(m){if(!m.contains(e.target))m.open=false})});
d.addEventListener('keydown',function(e){if(e.key==='Escape')d.querySelectorAll('details.menu[open],details.umenu[open]').forEach(function(m){m.open=false})});
var q=d.querySelector('input[data-search]');
if(q){q.closest('.tools').hidden=false;var items=d.querySelectorAll('.tests li.row'),none=d.querySelector('.tests-empty');
q.addEventListener('input',function(){var s=q.value.toLowerCase(),n=0;
items.forEach(function(li){var m=li.textContent.toLowerCase().indexOf(s)>-1;li.classList.toggle('hide',!m);if(m)n++});
d.querySelectorAll('details.tests').forEach(function(g){var v=g.querySelectorAll('li.row:not(.hide)').length;g.hidden=!v;if(s&&v)g.open=true});
if(none)none.style.display=n?'none':'block'})}
})();`;
