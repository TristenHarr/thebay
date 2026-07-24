/*
 * End-to-end test: drives the real built dashboard (dist/site) in a headless
 * browser and asserts EVERY filter produces correct, real results.
 * Run:  npm run test:e2e   (builds the site first)
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(process.cwd(), "dist/site");
const PORT = 8199;
const URL = `http://localhost:${PORT}/`;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = join(ROOT, p);
  if (existsSync(file) && !file.includes("..")) {
    res.setHeader("content-type", MIME[extname(file)] || "application/octet-stream");
    res.end(readFileSync(file));
  } else { res.statusCode = 404; res.end("not found"); }
});
server.on("error", (e) => { console.error("test server error:", e.message); process.exit(1); });
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(e.message));

const results = [];
const assert = (c, m) => { if (!c) throw new Error(m); };
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (e) { results.push([false, `${name} — ${e.message}`]); console.log(`  ✗ ${name} — ${e.message}`); }
}
const cardCount = () => page.locator(".card").count();
const summaryCount = async () => {
  const t = await page.locator("#summary").innerText();
  const nums = (t.replace(/,/g, "").match(/\d+/g) || ["0"]).map(Number);
  return Math.max(...nums); // "Showing 600 of 4578 events" → 4578
};
async function fresh() {
  await page.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".card", { timeout: 20000 });
}
const scoreBadges = () => page.$$eval(".badge.score", (ns) => ns.map((n) => parseInt(n.textContent.replace(/\D/g, ""), 10)));

console.log("\nRunning end-to-end filter tests…\n");
await fresh();

await test("loads events (default = next 30 days)", async () => {
  const n = await cardCount();
  assert(n > 0, "no cards rendered");
  const summary = await page.locator("#summary").innerText();
  assert(/\d/.test(summary), "summary has no count");
});

await test("no page JS errors on load", async () => {
  assert(consoleErrors.length === 0, "page errors: " + consoleErrors.join("; "));
});

await test("date filters are monotonic (today ≤ 7d ≤ 30d ≤ everything)", async () => {
  const get = async (d) => { await page.click(`[data-date="${d}"]`); await page.waitForTimeout(250); return summaryCount(); };
  const today = await get("today"), d7 = await get("7d"), d30 = await get("30d"), all = await get("all");
  assert(today <= d7, `today ${today} > 7d ${d7}`);
  assert(d7 <= d30, `7d ${d7} > 30d ${d30}`);
  assert(d30 <= all, `30d ${d30} > all ${all}`);
  assert(all > d30, `expected 'everything' (${all}) to exceed 30d (${d30})`);
});

await test("search narrows for a real term, empties for nonsense", async () => {
  await page.click('[data-date="all"]'); await page.waitForTimeout(150);
  const before = await summaryCount();
  await page.fill("#search", "founder"); await page.waitForTimeout(300);
  const after = await summaryCount();
  // matches title/org/venue/description, so we assert narrowing, not visible-text
  assert(after > 0 && after < before, `search 'founder' returned ${after} of ${before}`);
  await page.fill("#search", "zzqxnonexistent9999"); await page.waitForTimeout(300);
  assert((await summaryCount()) === 0, "nonsense search should return 0 results");
  await page.fill("#search", "");
});

await test("time-of-day filter narrows results", async () => {
  await fresh(); await page.click('[data-date="all"]'); await page.waitForTimeout(150);
  const any = await summaryCount();
  await page.click('#time-chips [data-time="evening"]'); await page.waitForTimeout(250);
  const eve = await summaryCount();
  assert(eve > 0 && eve < any, `evening ${eve} not between 0 and all ${any}`);
  await page.click('#time-chips [data-time="any"]'); await page.waitForTimeout(150);
  assert((await summaryCount()) === any, "returning to Any didn't restore the count");
});

await test("category filter shows only that category", async () => {
  await fresh(); await page.click('[data-date="all"]'); await page.waitForTimeout(150);
  const chip = page.locator("#f-categories .chip", { hasText: "Hardware" }).first();
  await chip.click(); await page.waitForTimeout(250);
  const n = await cardCount();
  assert(n > 0, "no hardware events");
  const ok = await page.$$eval(".card", (cards) => cards.every((c) => [...c.querySelectorAll(".badge")].some((b) => b.textContent.trim() === "Hardware")));
  assert(ok, "a card lacks the Hardware badge");
});

await test("source filter restricts to that source", async () => {
  await fresh(); await page.click('[data-date="all"]'); await page.waitForTimeout(150);
  const chip = page.locator("#f-sources .chip", { hasText: "partiful-sf" }).first();
  await chip.click(); await page.waitForTimeout(250);
  const n = await cardCount();
  assert(n > 0, "no partiful events");
  const ok = await page.$$eval(".card .src-tag", (ns) => ns.every((n) => n.textContent.toLowerCase().includes("partiful")));
  assert(ok, "a card is not from partiful");
});

await test("Free only returns free events (heuristic populated)", async () => {
  await fresh(); await page.click('[data-date="all"]'); await page.waitForTimeout(150);
  const before = await summaryCount();
  await page.check("#free"); await page.waitForTimeout(250);
  const after = await summaryCount();
  assert(after > 0, "Free only returned zero (the bug we fixed)");
  assert(after < before, `Free (${after}) should be fewer than all (${before})`);
});

// the curator's durable home (their newsletter/list) — links should point here.
// (NB: `URL` is shadowed by the page-URL constant above, so parse the host by hand.)
const hostOf = (u) => (u || "").replace(/^https?:\/\//, "").split("/")[0];
const curatorHome = async () => page.evaluate(async () => {
  const c = ((await (await fetch("./events.json")).json()).curators || [])[0] || {};
  return c.substack || c.url || "";
});

await test("curator spotlight credits the curator + links back (newsletter CTA)", async () => {
  await fresh();
  const spot = page.locator("#curator-spotlight");
  assert(await spot.isVisible(), "curator spotlight not shown");
  assert(/Kyosuke/i.test(await spot.innerText()), "spotlight doesn't name the curator");
  const home = await curatorHome();
  const host = hostOf(home);
  const link = await spot.locator("a.cs-link").first().getAttribute("href");
  assert(link && host && link.includes(host), `spotlight linkback ${link} doesn't point at the curator (${host})`);
  assert(/substack/i.test(host) && /newsletter/i.test(await spot.innerText()), "spotlight has no newsletter CTA");
  const foot = await page.locator("#foot-curators").innerText();
  assert(/Kyosuke/i.test(foot), "footer doesn't credit the curator");
});

await test("curated filter narrows to picks when upcoming exist, degrades gracefully otherwise", async () => {
  await fresh(); await page.click('[data-date="all"]'); await page.waitForTimeout(150);
  const curatedN = await page.evaluate(async () =>
    (await (await fetch("./events.json")).json()).events.filter((e) => e.curatedBy && e.curatedBy.length).length);
  const toggleVisible = await page.locator("#curated-toggle").isVisible();
  if (curatedN > 0) {
    assert(toggleVisible, "toggle hidden despite upcoming curated picks");
    await page.check("#curated"); await page.waitForTimeout(250);
    const after = await summaryCount();
    assert(after > 0 && after <= curatedN, `curated (${after}) should be >0 and ≤ ${curatedN}`);
    const allBadged = await page.$$eval(".card", (cs) => cs.every((c) => c.querySelectorAll(".badge.curated").length > 0));
    assert(allBadged, "a curated-only card lacks the ✦ curated badge");
    const href = await page.locator(".card .badge.curated").first().getAttribute("href");
    const host = hostOf(await curatorHome());
    assert(href && host && href.includes(host), "curated badge doesn't link back to the curator");
    await page.uncheck("#curated");
  } else {
    // the curator's list has nothing upcoming — the toggle is hidden (never a dead
    // filter) and the spotlight still links back so the credit + discovery survives.
    assert(!toggleVisible, "curated toggle should be hidden when there are no upcoming picks");
    const link = await page.locator("#curator-spotlight a.cs-link").getAttribute("href");
    const host = hostOf(await curatorHome());
    assert(link && host && link.includes(host), "spotlight linkback missing when no upcoming picks");
  }
});

await test("curator archive: recent picks expand + link out to the real event", async () => {
  await fresh();
  const archiveN = await page.evaluate(async () =>
    ((await (await fetch("./events.json")).json()).curatedArchive || []).length);
  if (archiveN === 0) return; // nothing archived (curator has only upcoming picks) — nothing to assert
  const cta = page.locator("#curator-spotlight .cs-cta", { hasText: /recent picks/i });
  assert(await cta.isVisible(), "no archive CTA despite a curatedArchive");
  assert(await page.locator("#curator-archive").isHidden(), "archive should start collapsed");
  await cta.click(); await page.waitForTimeout(150);
  assert(await page.locator("#curator-archive").isVisible(), "archive didn't expand on click");
  const rows = await page.locator("#curator-archive .ca-row").count();
  assert(rows === archiveN, `archive showed ${rows} rows, expected ${archiveN}`);
  const href = await page.locator("#curator-archive a.ca-row").first().getAttribute("href");
  assert(href && /^https?:/.test(href), "archive row doesn't link out to the real event");
});

await test("feed excludes junk far-future dates (horizon cap)", async () => {
  const maxTime = await page.evaluate(async () =>
    (await (await fetch("./events.json")).json()).events.reduce((m, e) => Math.max(m, new Date(e.startUtc).getTime()), 0));
  assert(maxTime > 0 && maxTime < Date.now() + 740 * 86400000, "an event is dated beyond the 2-year horizon (junk not capped)");
});

await test("min-interest slider filters by score", async () => {
  await fresh(); await page.click('[data-date="all"]'); await page.waitForTimeout(150);
  await page.$eval("#minScore", (el) => { el.value = "80"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(250);
  const scores = await scoreBadges();
  assert(scores.length > 0, "no scored events at ≥80");
  assert(scores.every((s) => s >= 80), "a visible event scores below 80");
});

await test("Most interesting sort orders by score desc", async () => {
  await fresh(); await page.click('[data-date="all"]'); await page.click('[data-sort="interesting"]');
  await page.waitForTimeout(300);
  const scores = await scoreBadges();
  assert(scores.length > 2, "not enough scored events");
  assert(scores[0] >= scores[scores.length - 1], "not sorted by score");
});

await test("Starred only reflects a starred event", async () => {
  await fresh(); await page.click('[data-date="all"]'); await page.waitForTimeout(150);
  await page.locator(".card .iconbtn.starred, .card .actions .iconbtn").first().click();
  await page.check("#starred"); await page.waitForTimeout(250);
  const n = await cardCount();
  assert(n === 1, `starred-only showed ${n}, expected 1`);
});

await test("Trip planner filters to the chosen dates + shows banner", async () => {
  await fresh();
  const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  await page.click("#trip-btn");
  await page.fill("#trip-from", iso(3));
  await page.fill("#trip-to", iso(12));
  await page.click("#trip-apply");
  await page.waitForTimeout(300);
  assert(await page.locator("#trip-banner").isVisible(), "trip banner not shown");
  const banner = await page.locator("#trip-banner").innerText();
  assert(/day/.test(banner), "banner missing day count");
  assert((await cardCount()) > 0, "trip window has no events");
});

await test("theme toggle flips light/dark", async () => {
  await fresh();
  const before = await page.evaluate(() => document.documentElement.getAttribute("data-theme") || getComputedStyle(document.documentElement).colorScheme);
  await page.click("#theme"); await page.waitForTimeout(150);
  const after = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  assert(after === "dark" || after === "light", "no data-theme set");
  assert(after !== before, "theme did not change");
});

await test("cards expose Directions + Add-to-calendar + Food-nearby links", async () => {
  await fresh(); await page.click('[data-date="all"]'); await page.waitForTimeout(150);
  const hrefs = await page.$$eval(".card .cardlink", (ns) => ns.map((n) => n.getAttribute("href")));
  assert(hrefs.some((h) => h && h.includes("calendar.google.com")), "no Google Calendar link");
  assert(hrefs.some((h) => h && h.includes("google.com/maps/dir")), "no Google Maps directions link");
  assert(hrefs.some((h) => h && h.includes("maps/search") && h.toLowerCase().includes("restaurants")), "no food-nearby link");
});

await test("starring builds the itinerary bar + share card + X intent", async () => {
  await fresh(); await page.click('[data-date="all"]'); await page.waitForTimeout(150);
  await page.locator(".card .actions .iconbtn").first().click();
  await page.locator(".card").nth(2).locator(".actions .iconbtn").first().click();
  await page.waitForTimeout(200);
  assert(await page.locator("#itinerary-bar").isVisible(), "itinerary bar not shown");
  await page.click("#itinerary-bar .btn-primary");
  await page.waitForTimeout(200);
  assert(await page.locator("#share-modal").isVisible(), "share modal not shown");
  assert((await page.locator("#share-card .sc-ev").count()) >= 2, "share card missing events");
  assert((await page.locator("#share-card .sc-qr svg").count()) === 1, "no QR code on share card");
  const x = await page.locator("#sc-x").getAttribute("href");
  assert(x && x.includes("twitter.com/intent"), "no X share intent link");
});

await test("shared ?pick link loads that itinerary", async () => {
  const id = await page.evaluate(async () => (await (await fetch("./events.json")).json()).events[0].id);
  // about:blank forces a real page load (a hash-only goto wouldn't re-run the app)
  await page.goto("about:blank");
  await page.goto(URL + "#pick=" + id, { waitUntil: "networkidle" });
  await page.waitForSelector(".card", { timeout: 15000 });
  await page.waitForTimeout(300);
  assert(await page.locator("#itinerary-bar").isVisible(), "shared itinerary bar not shown");
  const n = await cardCount();
  assert(n === 1, `shared pick showed ${n}, expected 1`);
});

await test("itinerary bar is always visible (discoverable) + view-schedule toggles", async () => {
  await fresh();
  assert(await page.locator("#itinerary-bar").isVisible(), "itinerary bar not visible on load");
  assert((await page.locator("#itinerary-bar").innerText()).toLowerCase().includes("plan"), "no 'plan' prompt in empty itinerary");
  await page.click('[data-date="all"]'); await page.waitForTimeout(150);
  await page.locator(".card .actions .iconbtn").first().click();
  await page.locator(".card").nth(3).locator(".actions .iconbtn").first().click();
  await page.waitForTimeout(200);
  await page.click("#itinerary-bar .btn-ghost"); // "View my schedule"
  await page.waitForTimeout(300);
  const n = await cardCount();
  assert(n === 2, `view-schedule showed ${n}, expected 2`);
});

const passed = results.filter((r) => r[0]).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed < results.length) console.log("FAILURES:\n" + results.filter((r) => !r[0]).map((r) => "  - " + r[1]).join("\n"));

await browser.close();
server.close();
process.exit(passed === results.length ? 0 : 1);
