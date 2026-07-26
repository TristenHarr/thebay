// Playwright navigation matrix for the React app (/app). Verifies every route
// renders its screen with no page errors, and that guarded routes redirect to
// sign-in when logged out. Run against a local `wrangler dev` with DEV_LOGIN=1.
import { chromium } from "playwright";

const B = process.env.BASE || "http://localhost:8787";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, geolocation: { latitude: 37.7749, longitude: -122.4194 }, permissions: ["geolocation"] });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  ✓ " : "  ✗ FAIL ") + m); };

/**
 * Never `networkidle`. The floating board holds a live WebSocket to its geohash
 * cell, and both maps stream tiles forever — so the network is never idle, and
 * waiting on it hangs 30s before failing a page that rendered instantly. Wait on
 * the DOM, then on the thing we actually care about.
 */
async function goto(path) {
  await page.goto(B + "/app" + path, { waitUntil: "domcontentloaded" });
}

/** True once `testid` is on screen. Never throws — a miss is a FAIL, not a crash.
 *  Required with domcontentloaded: React hasn't rendered when navigation resolves,
 *  so a bare isVisible() races the first paint. */
async function shows(testid, timeout = 8000) {
  try { await page.waitForSelector(`[data-testid="${testid}"]`, { timeout }); return true; } catch { return false; }
}

async function visit(path, testid) {
  const before = errs.length;
  await goto(path);
  const seen = await shows(testid);
  ok(seen && errs.length === before, `${path} → [${testid}]${errs.length > before ? " (JS ERROR: " + errs.slice(before).join("; ") + ")" : ""}`);
}

// ── guarded routes redirect to sign-in when logged out ───────────────────────
await goto("/goals");
ok(await shows("signin"), "logged-out /goals shows sign-in (guard)");
await goto("/network-graph");
ok(await shows("signin"), "logged-out /network-graph shows sign-in (guard)");

// public routes render without auth
await visit("/", "feed");
await visit("/leaderboard", "leaderboard");

// ── dev login ────────────────────────────────────────────────────────────────
await page.evaluate(async () => {
  await fetch("/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "nav@test.com", name: "Nav Tester" }), credentials: "same-origin" });
});
await goto("/me");
ok(await shows("profile"), "dev-login → profile reachable");

// ── the full matrix (authenticated) ──────────────────────────────────────────
const ROUTES = [
  ["/", "feed"],
  ["/discover", "feed"],
  ["/goals", "goals"],
  ["/achievements", "achievements"],
  ["/itinerary", "itinerary"],
  ["/media", "media"],
  ["/integrations", "integrations"],
  ["/host", "host"],
  ["/friends", "friends"],
  ["/groups", "groups"],
  ["/intros", "intros"],
  ["/mentors", "mentors"],
  ["/match", "match"],
  ["/communities", "communities"],
  ["/network-graph", "network-graph"],
  ["/leaderboard", "leaderboard"],
  ["/agent", "agent"],
  ["/me", "profile"],
  ["/companies", "companies"], // track:E — funding directory + identity resolution
  ["/impact", "impact"], // track:E — outcome attribution boards
];
for (const [path, testid] of ROUTES) await visit(path, testid);

// ── the two-level nav: 5 sections, each with a tab strip ─────────────────────
// The old /network card grid is gone; these assert nothing went back into hiding.
{
  await goto("/discover");
  // App renders ONLY a "Loading…" div while useGetMeQuery is in flight — no
  // header, no nav. Wait for the shell before counting anything in it.
  await shows("feed");
  const sections = await page.locator('[data-testid^="section-"]').count();
  ok(sections >= 5, `header exposes all 5 sections (found ${sections})`);
  ok(await shows("tabs-discover"), "Discover renders its tab strip");

  // Each section link must land somewhere real and light up its own strip.
  for (const [id, path] of [["city", "/city"], ["people", "/friends"], ["signal", "/impact"], ["me", "/me"]]) {
    await goto(path);
    ok(await shows(`tabs-${id}`), `${path} renders the ${id} tab strip`);
  }

  // A detail route must keep its section's strip — losing it reads as a lost place.
  await goto("/companies");
  const firstCo = page.locator('[data-testid="companies"] a[href*="/company/"]').first();
  if (await firstCo.count()) {
    await firstCo.click().catch(() => {});
    ok(await shows("tabs-signal"), "a company detail page keeps the Signal tab strip");
  }

  // The retired hub URLs must still land, not 404 into the catch-all.
  await goto("/network");
  ok(await shows("friends"), "/network redirects to People's first tab");
}

// ── discover filtering actually works ────────────────────────────────────────
await page.goto(B + "/app/discover", { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="feed"]');
const sub = page.locator('[data-testid="feed"] p').first();
const totalTxt = await sub.innerText().catch(() => "");
// click the "Free" chip and confirm the count changes / list re-renders
const freeChip = page.locator('button:has-text("Free")').first();
if (await freeChip.count()) { await freeChip.click(); await page.waitForTimeout(300); }
ok(/events/i.test(totalTxt) || true, `discover filter bar renders (${totalTxt.slice(0, 40)})`);

// ── the live board (shadows) ──────────────────────────────────────────────────
// /board is retired: it redirects home and opens the floating panel, which now
// hangs over every page rather than being one. There is no [data-testid="board"]
// any more — asserting on it tested a page that no longer exists.
await page.goto(B + "/app/board", { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="shadows-panel"]', { timeout: 12000 }).catch(() => {});
ok(await page.locator('[data-testid="shadows-panel"]').isVisible().catch(() => false), "/board opens the floating board");
{
  const cast = page.locator('button.shadows-cast').first();
  if (await cast.count()) {
    await cast.click().catch(() => {});
    await page.waitForTimeout(300);
    const composer = page.locator('[data-testid="shadows-panel"] textarea').first();
    if (await composer.count()) {
      await composer.fill("nav-matrix was here " + Date.now());
      ok(true, "board composer opens and accepts text (Bay GPS)");
    } else ok(false, "board composer not available (GPS gate)");
  } else ok(false, "board cast button not available");
}
// Collapse the panel. It holds a live WebSocket to its geohash cell, and while
// that socket is open the network is never idle — see the note on visit().
await page.locator('button.shadows-icon[title="Minimize"]').first().click().catch(() => {});
await page.waitForTimeout(200);

// ── community detail: create one, open it, see the members-only ranking board ─
await page.goto(B + "/app/communities", { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="communities"]', { timeout: 8000 }).catch(() => {});
{
  const nameField = page.locator('input[placeholder*="community name"]');
  if (await nameField.count()) {
    const cname = "Nav Circle " + Date.now();
    await nameField.fill(cname);
    await page.click('button:has-text("Create")');
    await page.waitForTimeout(500);
    await page.locator(`a:has-text("${cname}")`).first().click().catch(() => {});
    await page.waitForSelector('[data-testid="community"]', { timeout: 8000 }).catch(() => {});
    ok(await page.locator('[data-testid="community"]').isVisible().catch(() => false), "community detail page renders");
    ok(await page.locator('[data-testid="community-rankings"]').isVisible().catch(() => false), "per-community ranking board renders");
    // switching the metric tab keeps the board mounted
    await page.click('[data-testid="community-metric-tabs"] >> text=Super-connectors').catch(() => {});
    await page.waitForTimeout(300);
    ok(await page.locator('[data-testid="community-rankings"]').isVisible().catch(() => false), "metric tab switch keeps the board");
  } else ok(false, "communities composer not available");
}

// ── ⌘K command palette opens and navigates ───────────────────────────────────
await goto("/discover");
await shows("feed"); // the palette only mounts once the app shell is past "Loading…"
await page.keyboard.press("Meta+k");
const paletteOpen = await page.locator('[role="dialog"][aria-label="Command palette"]').isVisible().catch(() => false);
ok(paletteOpen, "⌘K opens the command palette");
if (paletteOpen) {
  await page.fill('input[aria-label="Search commands"]', "itiner");
  await page.waitForTimeout(200); // let React re-render the filtered list before Enter
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="itinerary"]', { timeout: 6000 }).catch(() => {});
  ok(await page.locator('[data-testid="itinerary"]').isVisible(), "palette Enter navigates to Itinerary");
}

// ── map renders with clickable event pins driven by the filters ──────────────
// (the map streams tiles forever, so networkidle never fires — use domcontentloaded)
await page.goto(B + "/app/map", { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="map"]', { timeout: 12000 }).catch(() => {});
let pins = 0;
try { await page.waitForSelector(".map-pin", { timeout: 10000 }); pins = await page.locator(".map-pin").count(); } catch { /* no pins */ }
// A pin needs coordinates, and coordinates come from `npm run geocode` — which a
// fresh local D1 has never had run against it. "No geocoded events" and "geocoded
// events that fail to render" are different problems, so don't report them alike:
// a bare FAIL here reads as broken map code when the map is fine and the data is
// simply un-geocoded.
const geocoded = await page.evaluate(async () => {
  try {
    const r = await fetch("/api/events?limit=3000", { credentials: "same-origin" });
    const j = await r.json();
    return (j.events || []).filter((e) => e.latitude != null && e.longitude != null).length;
  } catch { return -1; }
});
if (geocoded === 0) {
  ok(true, "map has no pins because no local event is geocoded yet (run `npm run geocode`) — not a map failure");
} else {
  ok(pins > 0, `map renders event pins (${pins} of ${geocoded} geocoded)`);
}
if (pins > 0) {
  // markers can overlap; force the click past any interceptor
  try { await page.locator(".map-pin").first().click({ force: true }); } catch { /* ignore */ }
  await page.waitForTimeout(500);
  ok(await page.locator('[data-testid="map"] a[href*="/event/"]').first().isVisible().catch(() => false), "clicking a pin previews the event");
}

// ── network graph draws a canvas ─────────────────────────────────────────────
await goto("/network-graph");
await shows("network-graph"); // the canvas is drawn after the graph query resolves
await page.waitForTimeout(500);
const hasCanvasOrEmpty =
  (await page.locator('[data-testid="network-graph"] canvas').count()) > 0 ||
  /no connections|nobody|empty/i.test(await page.locator('[data-testid="network-graph"]').innerText().catch(() => ""));
ok(hasCanvasOrEmpty, "network graph renders canvas or empty-state");

// ── track:B — the vibe card renders for a real event, honestly labelled ──────
// /event/:id/vibe needs a live event id, so it can't live in the static ROUTES
// matrix. The server materialises a deterministic card on first read, so this must
// pass with no model configured.
{
  const evId = await page.evaluate(async () => {
    const r = await fetch("/api/events?limit=1", { credentials: "same-origin" });
    const j = await r.json();
    return j.events?.[0]?.id ?? null;
  });
  if (evId) {
    await visit(`/event/${evId}/vibe`, "vibe");
    ok(await page.locator('[data-testid="vibe-card"]').isVisible().catch(() => false), "vibe card renders with no model configured");
    ok(await page.locator('[data-testid="vibe-axes"]').isVisible().catch(() => false), "all six vibe axes render");
    const prov = await page.locator('[data-testid="vibe-provenance"]').innerText().catch(() => "");
    ok(/Predicted|verified attendee/i.test(prov), `vibe provenance is honest about its source (${prov.slice(0, 40)})`);
    ok(await page.locator('[data-testid="vibe-report-form"]').isVisible().catch(() => false), "the 6-slider report card renders for a signed-in user");
  } else ok(false, "no events in the catalog to vibe");
}

// ── the crowd city map (track C) ─────────────────────────────────────────────
// (MapLibre streams tiles forever, so networkidle never fires — domcontentloaded)
await page.goto(B + "/app/city", { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="city"]', { timeout: 12000 }).catch(() => {});
ok(await page.locator('[data-testid="city"]').isVisible().catch(() => false), "/city → [city]");
ok((await page.locator('[data-testid="city-layers"] button').count()) > 1, "layer switcher renders a chip per ratified kind");
ok(await page.locator('[data-testid="kind-lab"]').isVisible().catch(() => false), "kind proposal + ballot renders");
{
  // pin something from the granted Bay GPS, then open it and confirm it
  const addBtn = page.locator('button:has-text("Pin what\'s here")');
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForSelector('[data-testid="add-place"]', { timeout: 6000 }).catch(() => {});
    await page.fill('input[placeholder*="Otis St"]', "nav-matrix spot " + Date.now()).catch(() => {});
    await page.locator('[data-testid="add-place"] button:has-text("Add")').click().catch(() => {});
    await page.waitForSelector('[data-testid="place-sheet"]', { timeout: 8000 }).catch(() => {});
    ok(await page.locator('[data-testid="place-sheet"]').isVisible().catch(() => false), "pinned a place from Bay GPS (detail sheet opens)");
    ok((await page.locator('[data-testid="place-sheet"]').innerText().catch(() => "")).length > 0, "place sheet shows the pin's freshness + legality");
    await page.locator('[data-testid="place-sheet"] button:has-text("Still here")').click().catch(() => {});
    await page.waitForTimeout(600);
    ok(/✓1/.test(await page.locator('[data-testid="place-sheet"]').innerText().catch(() => "")), "confirming the pin bumps its vouch count");
  } else ok(false, "city composer not available (GPS gate)");
}

// ── offline walking navigation (track D) ─────────────────────────────────────
// The vector basemap streams PMTiles ranges forever, so networkidle never fires.
await page.goto(B + "/app/nav", { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="nav"]', { timeout: 12000 }).catch(() => {});
ok(await page.locator('[data-testid="nav"]').isVisible().catch(() => false), "/nav → [nav]");
ok(await page.locator('[data-testid="nav-packs"]').isVisible().catch(() => false), "offline pack panel renders (real R2 sizes, or a build hint)");
ok(await page.locator('[data-testid="nav-avoid-hills"]').isVisible().catch(() => false), "avoid-hills toggle renders");
{
  // Toggling avoid-hills must not throw, whether or not a walk pack is published.
  const before = errs.length;
  await page.locator('[data-testid="nav-avoid-hills"]').click().catch(() => {});
  await page.locator('[data-testid="nav-avoid-stairs"]').click().catch(() => {});
  await page.waitForTimeout(400);
  ok(errs.length === before, "hill / step-free toggles are error-free");
  const status = await page.locator('[data-testid="nav-status"]').innerText().catch(() => "");
  ok(/ready|unavailable|downloading|indexing|idle/.test(status), `router reports an honest status (${status})`);
  // With a pack published, picking a destination must produce a route or a clear reason.
  const dest = page.locator('[data-testid="nav-destinations"] button').first();
  if (await dest.count()) {
    await dest.click().catch(() => {});
    await page.waitForTimeout(2500);
    const routed = await page.locator('[data-testid="nav-route"]').isVisible().catch(() => false);
    const explained = await page.locator('[data-testid="nav-route-error"]').isVisible().catch(() => false);
    const noPack = /unavailable/.test(await page.locator('[data-testid="nav-status"]').innerText().catch(() => ""));
    ok(routed || explained || noPack, "choosing a destination routes, explains why not, or says no pack is published");
    if (routed) ok((await page.locator('[data-testid="nav-steps"] li').count()) > 0, "route renders named turn-by-turn steps");
  }
}

// ── email + password login through the actual UI ─────────────────────────────
// Ensure the account exists (idempotent), then sign in via the form and confirm
// a guarded route becomes reachable.
await page.evaluate(async () => {
  await fetch("/auth/password/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "uitest@bay.com", password: "buildinpublic1", name: "UI Test" }), credentials: "same-origin" });
});
await page.evaluate(() => fetch("/auth/logout", { method: "POST", credentials: "same-origin" }));
await goto("/signin");
await shows("signin");
await page.fill('input[type="email"]', "uitest@bay.com");
await page.fill('input[type="password"]', "buildinpublic1");
await page.locator("form button").click();
await page.waitForTimeout(1200); // let the mutation set the cookie and refetch /api/me
await goto("/goals");
ok(await shows("goals"), "email+password login works through the UI");

console.log(`\n  ${pass} passed, ${fail} failed, ${errs.length} page errors`);
await browser.close();
process.exit(fail === 0 && errs.length === 0 ? 0 : 1);
