/**
 * The page shell. Same lockup, nav grammar and theme mechanism as thebay.events,
 * so the two sites read as one publication — only the accent hue and the type
 * scale differ.
 */
import { html, raw, type RawHtml } from "./escape";
import { renderHead, type PageMeta } from "./head";

export interface Chrome {
  /** Signed-in user, if any. */
  user?: { displayName: string; handle: string } | null;
  /** Has the viewer proved they're in the Bay in the last 12h? */
  inBay?: boolean;
  /** Origin of the events site, for the cross-site switcher. */
  eventsOrigin: string;
  assets: { css: string; js: string };
  /** Marks the current nav item. */
  active?: "top" | "new" | "submit" | null;
}

/**
 * Runs before first paint so a returning reader never sees a flash of the wrong
 * theme. Also carries the theme across the domain boundary: the switcher links
 * append ?theme=, because localStorage is per-origin and cannot be shared.
 */
const THEME_BOOTSTRAP = `(function(){try{
var q=new URLSearchParams(location.search).get('theme');
if(q==='dark'||q==='light'){localStorage.setItem('bay-theme',q)}
var t=localStorage.getItem('bay-theme');
if(t){document.documentElement.setAttribute('data-theme',t)}
}catch(e){}})()`;

export function page(meta: PageMeta, chrome: Chrome, body: RawHtml): string {
  return `<!doctype html>
<html lang="en">
<head>
<script>${THEME_BOOTSTRAP}</script>
${renderHead(meta, chrome.assets).value}
</head>
<body>
${masthead(chrome).value}
<main class="wrap" id="main">
${body.value}
</main>
${footer(chrome).value}
</body>
</html>`;
}

function masthead(c: Chrome): RawHtml {
  return html`<header class="masthead">
  <div class="wrap masthead-inner">
    <a class="brand mono" href="/"><span class="tilde">≈</span> the.bay<span style="color:var(--muted)">.news</span></a>
    <nav>
      <!-- top/new duplicate the hot/new sort chips, so they're the first things
           dropped when the header can't fit (see .navlink-optional). -->
      <a class="navlink navlink-optional mono" href="/" ${c.active === "top" ? raw('aria-current="page"') : ""}>top</a>
      <a class="navlink navlink-optional mono" href="/newest" ${c.active === "new" ? raw('aria-current="page"') : ""}>new</a>
      <a class="navlink mono" href="/submit" ${c.active === "submit" ? raw('aria-current="page"') : ""}>submit</a>
      <!-- Same rule in reverse: start the handoff HERE, land signed in over there. -->
      <a class="switch mono" href="/auth/handoff/start?next=%2Fapp" title="The Bay — events"
         aria-label="Go to thebay.events">📡<span class="switch-label"> events</span></a>
      <button class="iconbtn" type="button" data-theme-toggle aria-label="Toggle light or dark theme">☾</button>
      ${c.user
        ? html`<a class="navlink mono" href="/u/${c.user.handle}">${c.user.displayName}</a>`
        : html`<a class="navlink mono" href="/login">sign in</a>`}
    </nav>
  </div>
</header>`;
}

function footer(c: Chrome): RawHtml {
  return html`<footer class="wrap foot">
  <span>≈ thebay.news</span>
  <a href="${c.eventsOrigin}">thebay.events</a>
  <a href="/feed.xml">rss</a>
  <a href="/about">about</a>
  <span style="margin-left:auto">submitting is open to people in the Bay</span>
</footer>`;
}
