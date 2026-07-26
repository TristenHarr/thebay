/**
 * Visual checks for thebay.news — screenshots you can look at, and assertions
 * that don't need you to.
 *
 * Why this exists: the front page had a story rendering the browser's
 * broken-image glyph — a torn grey box, three rows down — and 68 passing
 * production checks said nothing, because every one of them asked about HTML.
 * I only found it by taking a screenshot and looking at it. That's not a
 * process; this is.
 *
 * Deliberately NOT pixel-diffing against committed baselines. Font rendering
 * differs between macOS and CI's Linux, so byte-comparing screenshots taken on
 * different machines fails forever for reasons nobody cares about, and a suite
 * that cries wolf gets ignored or deleted. Instead every assertion here is
 * something measured from the live page — an image that didn't load, a page
 * that scrolls sideways, a tap target too small for a thumb, text the same
 * colour as its background. Those are true or false regardless of which font
 * the machine rendered.
 *
 * The PNGs are written every run either way, and CI uploads them, so "let me
 * see what it looks like" is answered by an artifact instead of by asking.
 *
 *   npm run test:visual                      # against production
 *   BASE=http://localhost:8788 npm run test:visual
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = (process.env.BASE || "https://thebay.news").replace(/\/+$/, "");
const OUT = resolve(process.cwd(), "test-results/visual");

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 1400 },
  { name: "mobile", width: 390, height: 1100 },
];
const THEMES = ["light", "dark"];
const PAGES = [
  { name: "front", path: "/" },
  { name: "newest", path: "/newest" },
  { name: "research", path: "/?src=research" },
  { name: "crates", path: "/?src=crates" },
  // Signed out, /submit must send you somewhere useful — it is a page, not an API.
  { name: "submit", path: "/submit", expectRedirectTo: "/login" },
  { name: "about", path: "/about" },
];

/**
 * The story page is where search and social traffic actually lands, and nothing
 * had ever looked at it. Resolved at runtime because the front page changes
 * hourly — hardcoding an id would rot within a day and start "failing" for a
 * reason that has nothing to do with the site.
 */
async function discoverPages() {
  const res = await fetch(`${BASE}/api/news/feed?src=bay&limit=1`);
  if (!res.ok) return [];
  const s = (await res.json()).stories?.[0];
  if (!s) return [];
  return [{ name: "item", path: s.slug ? `/item/${s.id}/${s.slug}` : `/item/${s.id}` }];
}

let failures = 0;
const shots = [];
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };

/** WCAG relative luminance, for a contrast ratio that means something. */
function contrast(rgb1, rgb2) {
  const lum = ([r, g, b]) => {
    const c = [r, g, b].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [a, b] = [lum(rgb1), lum(rgb2)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
const parseRgb = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);

async function checkPage(browser, page, viewport, theme) {
  const label = `${page.name} · ${viewport.name} · ${theme}`;
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  const tab = await ctx.newPage();

  // Record every image the browser failed to fetch. This is the check that
  // would have caught the broken thumbnail.
  const badImages = [];
  tab.on("response", (r) => {
    const type = r.request().resourceType();
    if (type === "image" && r.status() >= 400) badImages.push(`${r.status()} ${r.url().slice(0, 80)}`);
  });
  tab.on("requestfailed", (r) => {
    if (r.resourceType() === "image") badImages.push(`failed ${r.url().slice(0, 80)}`);
  });

  const res = await tab.goto(BASE + page.path, { waitUntil: "networkidle", timeout: 45_000 });
  if (page.expectRedirectTo && res && res.ok()) {
    const landed = new URL(tab.url()).pathname;
    if (landed === page.expectRedirectTo) ok(`${label} — signed out, redirected to ${landed}`);
    else bad(`${label} — expected a redirect to ${page.expectRedirectTo}, landed on ${landed}`);
  }
  if (!res || res.status() >= 400) {
    bad(`${label} — HTTP ${res ? res.status() : "no response"}`);
    await ctx.close();
    return;
  }

  const file = resolve(OUT, `${page.name}-${viewport.name}-${theme}.png`);
  await tab.screenshot({ path: file, fullPage: false });
  shots.push({ label, file: `${page.name}-${viewport.name}-${theme}.png` });

  // 1. No broken images. A dead preview URL renders as the browser's torn-image
  //    glyph, and the island removes it — so a *rendered* broken image is a bug
  //    even though the failed request itself is expected and harmless.
  const renderedBroken = await tab.evaluate(() =>
    [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src.slice(0, 80)),
  );
  if (renderedBroken.length) bad(`${label} — ${renderedBroken.length} broken image(s) rendered: ${renderedBroken[0]}`);
  else ok(`${label} — no broken images${badImages.length ? ` (${badImages.length} dead URL(s) cleaned up)` : ""}`);

  // 2. Nothing may push the page sideways. This is the classic mobile break and
  //    it is invisible in HTML assertions.
  const overflow = await tab.evaluate(() => {
    const de = document.documentElement;
    const wide = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1)
      .slice(0, 3)
      .map((el) => el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : ""));
    return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, wide };
  });
  if (overflow.scrollWidth > overflow.clientWidth + 1) {
    bad(`${label} — page scrolls sideways (${overflow.scrollWidth} > ${overflow.clientWidth}) via ${overflow.wide.join(", ")}`);
  } else ok(`${label} — no horizontal overflow`);

  // 3. The header must be entirely on screen. "sign in" was once clipped off
  //    the right edge on a phone, and only a screenshot showed it.
  const header = await tab.evaluate(() => {
    const h = document.querySelector("header");
    if (!h) return null;
    const r = h.getBoundingClientRect();
    // Only things actually on screen. `top`/`new` are dropped by CSS on narrow
    // viewports ON PURPOSE (.navlink-optional), and calling that "clipped"
    // would be the suite inventing a bug.
    const kids = [...h.querySelectorAll("a,button")]
      .filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== "hidden";
      })
      .map((el) => {
        const b = el.getBoundingClientRect();
        return { text: (el.textContent || "").trim().slice(0, 14), right: Math.round(b.right), w: Math.round(b.width) };
      });
    return { right: Math.round(r.right), width: document.documentElement.clientWidth, kids };
  });
  if (!header) bad(`${label} — no <header>`);
  else {
    const clipped = header.kids.filter((k) => k.right > header.width + 1);
    if (clipped.length) bad(`${label} — header item clipped: ${clipped.map((c) => c.text).join(", ")}`);
    else ok(`${label} — header fits (${header.kids.length} controls)`);
  }

  // 4. Body text has to be readable against what's actually behind it.
  const text = await tab.evaluate(() => {
    const el = document.querySelector(".story-title a") || document.querySelector("h1, h2, p");
    if (!el) return null;
    const bgOf = (n) => {
      for (let cur = n; cur; cur = cur.parentElement) {
        const c = getComputedStyle(cur).backgroundColor;
        if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    return { fg: getComputedStyle(el).color, bg: bgOf(el), size: parseFloat(getComputedStyle(el).fontSize) };
  });
  if (!text) bad(`${label} — found no text to measure`);
  else {
    const ratio = contrast(parseRgb(text.fg), parseRgb(text.bg));
    if (ratio < 4.5) bad(`${label} — text contrast ${ratio.toFixed(2)}:1 is below 4.5:1 (${text.fg} on ${text.bg})`);
    else ok(`${label} — contrast ${ratio.toFixed(2)}:1, ${text.size}px`);
  }

  // 5. On a phone, things you tap need to be big enough to tap.
  if (viewport.name === "mobile") {
    const small = await tab.evaluate(() => {
      return [...document.querySelectorAll("button, .chip, .vote")]
        .map((el) => ({ t: (el.textContent || "").trim().slice(0, 12), r: el.getBoundingClientRect() }))
        .filter((x) => x.r.width > 0 && x.r.height > 0 && (x.r.height < 24 || x.r.width < 24))
        .map((x) => `${x.t}(${Math.round(x.r.width)}×${Math.round(x.r.height)})`);
    });
    if (small.length) bad(`${label} — tap targets under 24px: ${small.slice(0, 3).join(", ")}`);
    else ok(`${label} — tap targets ≥24px`);
  }

  await ctx.close();
}

function writeContactSheet() {
  const rows = shots
    .map((s) => `<figure><img src="${s.file}" alt="${s.label}"><figcaption>${s.label}</figcaption></figure>`)
    .join("\n");
  writeFileSync(
    resolve(OUT, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>thebay.news — visual run</title>
<style>body{font:14px/1.5 ui-sans-serif,system-ui;margin:24px;background:#fbfdfc;color:#0b1f1c}
h1{font-size:18px}figure{margin:0 0 28px}img{max-width:100%;border:1px solid #d7e5e1;border-radius:8px;display:block}
figcaption{padding-top:6px;color:#4a635e;font-family:ui-monospace,monospace;font-size:12px}
.grid{display:grid;gap:24px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}</style>
<h1>thebay.news — ${BASE}</h1><div class="grid">${rows}</div>`,
  );
}

const browser = await chromium.launch();
mkdirSync(OUT, { recursive: true });
console.log(`\nVisual checks — ${BASE}\n`);
try {
  for (const page of [...PAGES, ...(await discoverPages())]) {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        await checkPage(browser, page, viewport, theme);
      }
    }
  }
} finally {
  await browser.close();
  writeContactSheet();
}

console.log(`\n${shots.length} screenshots → test-results/visual/index.html`);
if (failures) {
  console.log(`\x1b[31m${failures} visual check(s) failed.\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32mAll visual checks passed.\x1b[0m\n`);
