import { chromium } from "playwright";
const B = "http://localhost:8787";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const ok = (c, m) => console.log((c ? "  ✓ " : "  ✗ FAIL ") + m);

await page.goto(B + "/app/", { waitUntil: "networkidle" });
await page.waitForSelector(".event-card", { timeout: 15000 });
ok(await page.locator(".topbar .btn-primary", { hasText: "Sign in" }).isVisible(), "anon sees feed + Sign in button");

// go to sign-in, dev login
await page.click(".topbar .btn-primary");
await page.waitForSelector(".auth-card");
ok(true, "sign-in screen reachable");
await page.click("text=Log in as");
await page.waitForTimeout(700);
ok(await page.locator(".topbar .me").isVisible(), "logged in — user chip visible");

// enable social via the nudge (opt-in → leaderboard + friends)
ok(await page.locator(".nudge").isVisible(), "social-enable nudge shown for new user");
await page.click(".nudge button");
await page.waitForTimeout(500);

// feed loads with events
await page.waitForSelector(".event-card", { timeout: 15000 });
const cards = await page.locator(".event-card").count();
ok(cards > 0, `feed shows events (${cards})`);

// RSVP the first event
await page.locator(".event-card .chip", { hasText: "Going" }).first().click();
await page.waitForTimeout(400);
ok(await page.locator(".event-card .chip.on", { hasText: "Going" }).first().isVisible(), "RSVP 'Going' toggles on");
const pts = await page.locator(".pts-chip").innerText();
ok(/[1-9]/.test(pts), `points awarded, chip shows ${pts}`);

// open an event page
await page.locator(".event-card h3 a").first().click();
await page.waitForSelector(".event-page", { timeout: 8000 });
ok(await page.locator(".event-page h1").isVisible(), "event page opens");
ok((await page.locator(".stat-row").innerText()).includes("going"), "event page shows RSVP counts");

// host an event
await page.click(".navlink:has-text('Host')");
await page.waitForSelector(".hostform");
await page.fill("input.input >> nth=0", "Playwright Test Meetup");
await page.fill('input[type="datetime-local"]', "2026-09-01T18:00");
await page.click("button:has-text('Publish event')");
await page.waitForSelector(".event-page", { timeout: 8000 });
ok((await page.locator(".event-page h1").innerText()) === "Playwright Test Meetup", "hosted event created + opened");
ok((await page.locator(".host").innerText()).includes("Hosted by"), "hosted event shows host");

// leaderboard
await page.click(".navlink:has-text('Leaderboard')");
await page.waitForTimeout(500);
ok(await page.locator(".board .row").first().isVisible(), "leaderboard shows entries");

// groups (create)
await page.click(".navlink:has-text('Groups')");
await page.waitForSelector(".search");
await page.fill(".search .input", "Test Crew");
await page.click("button:has-text('Create')");
await page.waitForSelector(".chat", { timeout: 8000 });
await page.fill(".chat-input .input", "hello from playwright");
await page.click(".chat-input button");
await page.waitForTimeout(800);
ok((await page.locator(".msg").count()) >= 1, "group chat: message appears (live via WS)");

// profile
await page.click(".me a");
await page.waitForSelector(".profile-head");
ok(await page.locator(".profile-head h2").isVisible(), "profile page loads");

// map
await page.click(".navlink:has-text('Map')");
await page.waitForTimeout(2500);
ok(await page.locator(".map").isVisible(), "map view renders (maplibre chunk loaded)");

ok(errs.length === 0, "no page JS errors" + (errs.length ? ": " + errs.join("; ") : ""));

await page.screenshot({ path: "app-shot.png", fullPage: false });
await browser.close();
