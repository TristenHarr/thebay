// Playwright VISUAL suite for Shadows — the "we can SEE it works" gate.
//
// This is the regression net for "I don't see the map": it opens the floating
// board in a real browser, and HARD-FAILS if the MapLibre canvas isn't actually
// rendered at a real size (the exact bug where MapLibre's position:relative
// collapsed the container to height:0). It also drives the full journey — open →
// map visible → cast a shadow → zoom to live pins → expand — capturing a
// screenshot at every step AND a video of the whole thing, so CI can post visual
// proof (screenshots + a GIF) straight into the PR/commit.
//
// Run against a local `wrangler dev` on :8787 with DEV_LOGIN=1.
//   BASE=http://localhost:8787 ARTIFACTS=./artifacts/visual node tests/shadows-visual.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const B = process.env.BASE || "http://localhost:8787";
const ART = process.env.ARTIFACTS || "./artifacts/visual";
const MAP_MIN_H = 200; // the map must be at least this tall, or it's the collapse bug
mkdirSync(ART, { recursive: true });
mkdirSync(join(ART, "video"), { recursive: true });

let pass = 0, fail = 0, shot = 0;
const results = [];
const ok = (c, m) => { c ? pass++ : fail++; results.push({ c, m }); console.log((c ? "  ✓ " : "  ✗ FAIL ") + m); };
async function step(name, fn) { try { const r = await fn(); ok(r !== false, name); } catch (e) { ok(false, `${name} — threw: ${String(e).slice(0, 160)}`); } }

const browser = await chromium.launch();
// A Bay-Area user (geolocation granted) in a recorded context.
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  geolocation: { latitude: 37.7749, longitude: -122.4194 }, // SF — inside the Bay gate
  permissions: ["geolocation"],
  recordVideo: { dir: join(ART, "video"), size: { width: 1280, height: 900 } },
});
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

const snap = async (label) => {
  const name = `${String(++shot).padStart(2, "0")}-${label}.png`;
  await page.screenshot({ path: join(ART, name) });
  console.log(`    📸 ${name}`);
  return name;
};

// Sign in (dev login) so the composer is in its signed-in state.
await ctx.request.post(`${B}/auth/dev`, { data: { email: `visual-${Date.now()}@bay.test`, name: "Visual Bot" } });

await step("app shell loads with the Shadows bubble", async () => {
  await page.goto(`${B}/app/`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="shadows-bubble"]', { timeout: 10000 });
  await snap("home-with-bubble");
  return true;
});

await step("opening the bubble reveals the panel", async () => {
  await page.locator('[data-testid="shadows-bubble"]').click();
  await page.waitForSelector('[data-testid="shadows-panel"]', { timeout: 8000 });
  return true;
});

// THE regression gate: the map must actually render at a real size.
let mapBox = null;
await step(`the MAP renders at a real size (height ≥ ${MAP_MIN_H}px)`, async () => {
  await page.waitForSelector('[data-testid="shadows-panel"] canvas.maplibregl-canvas', { timeout: 8000 });
  await page.waitForTimeout(1500); // let tiles paint
  mapBox = await page.locator('[data-testid="shadows-map"]').first().boundingBox();
  await snap("map-visible");
  console.log(`    map box: ${JSON.stringify(mapBox)}`);
  return !!mapBox && mapBox.height >= MAP_MIN_H && mapBox.width >= MAP_MIN_H;
});

// The unified map is layered (shadows / spots / … more each stage). No numbered
// screenshot here so the CI comment's 01/02/05/06 references stay stable.
await step("the layer switcher is present and toggles", async () => {
  const chips = page.locator('[data-testid="map-layers"] .shadows-layer');
  if ((await chips.count()) < 2) return false;
  const spots = page.locator('[data-testid="map-layers"] .shadows-layer', { hasText: "Spots" });
  const before = (await spots.getAttribute("class")) || "";
  await spots.click();
  await page.waitForTimeout(250);
  const after = (await spots.getAttribute("class")) || "";
  await spots.click(); // restore
  console.log(`    layers: ${await chips.count()} · Spots toggled ${before.includes("is-on")}→${after.includes("is-on")}`);
  return before.includes("is-on") && !after.includes("is-on"); // clicking turned it off
});

await step("mobbing toggles on and tracks movement (no numbered shot)", async () => {
  const toggle = page.locator('[data-testid="mob-toggle"]');
  if (!(await toggle.count())) return false;
  await toggle.click();
  await page.waitForTimeout(700);
  const on = await page.locator('[data-testid="mob-indicator"]').count();
  await toggle.click(); // back off so it doesn't ping during the rest of the run
  console.log(`    mobbing indicator shown: ${on > 0}`);
  return on > 0;
});

await step("casting a shadow from the composer works", async () => {
  const before = (await (await ctx.request.get(`${B}/api/me`)).json()).points ?? 0;
  await page.locator(".shadows-cast").click(); // "✦ Cast a shadow"
  await page.locator(".shadows-text").first().fill("visual test — the map is alive 🌉");
  await snap("composer-open");
  await page.locator(".shadows-post").click();
  await page.waitForTimeout(1200);
  const after = (await (await ctx.request.get(`${B}/api/me`)).json()).points ?? 0;
  await snap("after-cast");
  return after > before; // a cast awards points → proof it persisted
});

await step("the cast shadow shows up as a live pin", async () => {
  // Casting already flew the map to the shadow at live zoom; wait for its pin to
  // pop in (proves the live read/cell path renders end-to-end in the browser).
  await page.waitForSelector(".shadow-pin", { timeout: 12000 });
  await page.waitForTimeout(400);
  const pins = await page.locator(".shadow-pin").count();
  await snap("live-pin");
  console.log(`    live pins: ${pins}`);
  return pins >= 1;
});

// XP orbs are deterministic per cell — zoomed in on a live cell, at least one floats.
await step("XP orbs float on the map (no numbered shot)", async () => {
  await page.waitForTimeout(600);
  const orbs = await page.locator(".orb-marker").count();
  console.log(`    orbs rendered: ${orbs}`);
  return orbs >= 1;
});

// The lore layer (SF-VC landmark billboards) + the coming-soon vision banner.
await step("lore billboards + P2P-mesh banner render (no numbered shot)", async () => {
  const lore = await page.locator(".lore-marker").count();
  const banner = await page.locator('[data-testid="mesh-banner"]').count();
  console.log(`    lore markers: ${lore} · mesh banner: ${banner}`);
  return lore >= 1 && banner >= 1;
});

await step("expanding the widget grows it", async () => {
  const small = await page.locator('[data-testid="shadows-panel"]').boundingBox();
  await page.locator('.shadows-icon[title="Expand"]').click();
  await page.waitForTimeout(600);
  const big = await page.locator('[data-testid="shadows-panel"]').boundingBox();
  await snap("expanded");
  return big.height > small.height;
});

ok(pageErrors.length === 0, `no uncaught page errors (${pageErrors.length}${pageErrors.length ? ": " + pageErrors[0] : ""})`);

await ctx.close(); // flushes the video
const videoPath = await page.video()?.path().catch(() => null);
await browser.close();

// Machine-readable summary for the CI comment step.
const summary = { pass, fail, shots: shot, map: mapBox, video: videoPath, results };
const { writeFileSync } = await import("node:fs");
writeFileSync(join(ART, "summary.json"), JSON.stringify(summary, null, 2));

console.log(`\nVISUAL: ${pass} passed, ${fail} failed · ${shot} screenshots · video: ${videoPath ? "yes" : "no"}`);
process.exit(fail ? 1 : 0);
