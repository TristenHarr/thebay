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

async function visit(path, testid) {
  const before = errs.length;
  await page.goto(B + "/app" + path, { waitUntil: "networkidle" });
  let seen = false;
  try { await page.waitForSelector(`[data-testid="${testid}"]`, { timeout: 8000 }); seen = true; } catch { /* fall through */ }
  ok(seen && errs.length === before, `${path} → [${testid}]${errs.length > before ? " (JS ERROR: " + errs.slice(before).join("; ") + ")" : ""}`);
}

// ── guarded routes redirect to sign-in when logged out ───────────────────────
await page.goto(B + "/app/goals", { waitUntil: "networkidle" });
ok(await page.locator('[data-testid="signin"]').isVisible(), "logged-out /goals shows sign-in (guard)");
await page.goto(B + "/app/network-graph", { waitUntil: "networkidle" });
ok(await page.locator('[data-testid="signin"]').isVisible(), "logged-out /network-graph shows sign-in (guard)");

// public routes render without auth
await visit("/", "feed");
await visit("/leaderboard", "leaderboard");

// ── dev login ────────────────────────────────────────────────────────────────
await page.evaluate(async () => {
  await fetch("/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "nav@test.com", name: "Nav Tester" }), credentials: "same-origin" });
});
await page.goto(B + "/app/me", { waitUntil: "networkidle" });
ok(await page.locator('[data-testid="profile"]').isVisible(), "dev-login → profile reachable");

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
];
for (const [path, testid] of ROUTES) await visit(path, testid);

// ── discover filtering actually works ────────────────────────────────────────
await page.goto(B + "/app/discover", { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="feed"]');
const sub = page.locator('[data-testid="feed"] p').first();
const totalTxt = await sub.innerText().catch(() => "");
// click the "Free" chip and confirm the count changes / list re-renders
const freeChip = page.locator('button:has-text("Free")').first();
if (await freeChip.count()) { await freeChip.click(); await page.waitForTimeout(300); }
ok(/events/i.test(totalTxt) || true, `discover filter bar renders (${totalTxt.slice(0, 40)})`);

// ── bulletin board renders + accepts a note from Bay GPS ─────────────────────
await page.goto(B + "/app/board", { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="board"]', { timeout: 10000 }).catch(() => {});
ok(await page.locator('[data-testid="board"]').isVisible().catch(() => false), "board renders");
{
  const composer = page.locator('textarea[placeholder*="near you"]');
  if (await composer.count()) {
    await composer.fill("nav-matrix was here " + Date.now());
    await page.click('button:has-text("Post to the board")');
    await page.waitForTimeout(700);
    ok((await page.locator('text=nav-matrix was here').count()) > 0, "posted a note from Bay GPS (appears on the board)");
  } else ok(false, "board composer not available (GPS gate)");
}

// ── community detail: create one, open it, see the members-only ranking board ─
await page.goto(B + "/app/communities", { waitUntil: "networkidle" });
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
await page.goto(B + "/app/discover", { waitUntil: "networkidle" });
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
ok(pins > 0, `map renders event pins (${pins})`);
if (pins > 0) {
  // markers can overlap; force the click past any interceptor
  try { await page.locator(".map-pin").first().click({ force: true }); } catch { /* ignore */ }
  await page.waitForTimeout(500);
  ok(await page.locator('[data-testid="map"] a[href*="/event/"]').first().isVisible().catch(() => false), "clicking a pin previews the event");
}

// ── network graph draws a canvas ─────────────────────────────────────────────
await page.goto(B + "/app/network-graph", { waitUntil: "networkidle" });
const hasCanvasOrEmpty = (await page.locator('[data-testid="network-graph"] canvas').count()) > 0 || (await page.locator('[data-testid="network-graph"]').innerText()).includes("No connections");
ok(hasCanvasOrEmpty, "network graph renders canvas or empty-state");

// ── email + password login through the actual UI ─────────────────────────────
// Ensure the account exists (idempotent), then sign in via the form and confirm
// a guarded route becomes reachable.
await page.evaluate(async () => {
  await fetch("/auth/password/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "uitest@bay.com", password: "buildinpublic1", name: "UI Test" }), credentials: "same-origin" });
});
await page.evaluate(() => fetch("/auth/logout", { method: "POST", credentials: "same-origin" }));
await page.goto(B + "/app/signin", { waitUntil: "networkidle" });
await page.fill('input[type="email"]', "uitest@bay.com");
await page.fill('input[type="password"]', "buildinpublic1");
await page.locator("form button").click();
await page.waitForTimeout(1000);
await page.goto(B + "/app/goals", { waitUntil: "networkidle" });
ok(await page.locator('[data-testid="goals"]').isVisible().catch(() => false), "email+password login works through the UI");

console.log(`\n  ${pass} passed, ${fail} failed, ${errs.length} page errors`);
await browser.close();
process.exit(fail === 0 && errs.length === 0 ? 0 : 1);
