import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SECTIONS, sectionFor, allDestinations } from "../web/src/app/nav";

/**
 * LOCK-IN TESTS — navigation and test hygiene.
 *
 * The recurring failure here isn't a crash, it's a feature that ships and then
 * can't be found: ~25 screens accumulated behind 5 nav slots and a `/network` card
 * grid, and four of the five parallel tracks finished with "no nav entry — that
 * file wasn't mine". Reachability has to be an assertion, not a good intention.
 */

const APP = readFileSync(resolve(process.cwd(), "web/src/app/App.tsx"), "utf8");
const NAV_MATRIX = readFileSync(resolve(process.cwd(), "tests/nav-matrix.mjs"), "utf8");

/** Every `<Route path="...">` declared in the app. */
const routePaths = [...APP.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]!);

/**
 * Routes that intentionally belong to no section.
 * Keep this list tiny — every entry is a screen a user cannot navigate to.
 */
const UNSECTIONED = new Set([
  "*", // catch-all, renders Discover
  "/signin", // reached by the header button and by every auth guard, not by nav
]);

/** `/event/:id/vibe` → `/event`; the static prefix a section can own. */
function staticPrefix(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (p.startsWith(":")) break;
    out.push(p);
  }
  return "/" + out.join("/");
}

describe("lock: every screen is reachable", () => {
  it("found the route table", () => {
    // Guards against the regex silently matching nothing after a refactor, which
    // would make every assertion below vacuously true.
    expect(routePaths.length).toBeGreaterThan(20);
  });

  it("assigns every route to a section", () => {
    const orphans = routePaths.filter((p) => !UNSECTIONED.has(p) && !sectionFor(staticPrefix(p)));
    expect(
      orphans,
      `These routes belong to no section in web/src/app/nav.ts, so nothing in the UI ` +
        `links to them and they render without a tab strip: ${orphans.join(", ")}. ` +
        `Add each to a section's items or owns — or to UNSECTIONED with a reason.`,
    ).toEqual([]);
  });

  it("has no dead tabs — every nav destination has a route", () => {
    const declared = new Set(routePaths);
    const dead = allDestinations()
      .map((d) => d.to)
      .filter((to) => !declared.has(to));
    expect(
      dead,
      `These nav tabs point at paths with no <Route>, so clicking them hits the ` +
        `catch-all and silently renders Discover: ${dead.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the retired hub URLs redirecting rather than 404ing", () => {
    // /network was a real destination for months; bookmarks and the sitemap still
    // point at it. Falling through to the catch-all would look like it worked.
    for (const legacy of ["/network", "/people", "/signal"]) {
      expect(routePaths, `${legacy} must still resolve`).toContain(legacy);
    }
  });

  it("exposes every section in the nav, not behind a hub", () => {
    // The thing that went wrong: a card grid at /network held 11 links, so none of
    // them were in the nav at all. Sections are rendered directly by SectionLinks.
    expect(SECTIONS.length).toBeGreaterThanOrEqual(5);
    for (const s of SECTIONS) {
      expect(APP).toContain("SectionLinks");
      expect(routePaths, `section ${s.id} points at ${s.to}, which has no route`).toContain(s.to);
    }
  });
});

describe("lock: nav-matrix covers what ships", () => {
  /**
   * CLAUDE.md: "Every user-facing screen has a data-testid + a nav-matrix entry."
   * That held right up until five agents shipped at once.
   */
  const NOT_IN_MATRIX = new Set([
    "/map", // covered by its own pin/tile block rather than the ROUTES table
  ]);

  it("visits every nav destination", () => {
    const missing = allDestinations()
      .map((d) => d.to)
      .filter((to) => !NOT_IN_MATRIX.has(to))
      // `visit("/x", …)`, `goto("/x")` or a raw page.goto(B + "/app/x")
      .filter((to) => !new RegExp(`["'\\(]${to.replace(/\//g, "\\/")}["'\\)]|/app${to.replace(/\//g, "\\/")}["'\`]`).test(NAV_MATRIX));
    expect(
      missing,
      `These screens are in the nav but never opened by tests/nav-matrix.mjs, so a ` +
        `render crash in them ships silently: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

describe("lock: no networkidle in browser tests", () => {
  /**
   * The bug: the floating board holds a WebSocket to its geohash cell and both maps
   * stream tiles indefinitely, so the network is never idle. `waitUntil:
   * "networkidle"` therefore hangs for the full 30s timeout and then fails a page
   * that had rendered instantly — and it failed *positionally*: /communities passed
   * in the ROUTES table and then timed out later in the same run, once the board
   * had been opened. Diagnosing that from the symptom cost real time.
   */
  const browserTests = readdirSync(resolve(process.cwd(), "tests"))
    .filter((f) => f.endsWith(".mjs"));

  it("found the browser test files", () => {
    expect(browserTests.length).toBeGreaterThan(0);
  });

  it.each(["nav-matrix.mjs", "actions-e2e.mjs"])("%s does not wait on networkidle", (file) => {
    const path = resolve(process.cwd(), "tests", file);
    let src: string;
    try {
      src = readFileSync(path, "utf8");
    } catch {
      return; // file doesn't exist in this checkout
    }
    // Match the option, not the word — the explanatory comments mention it by name.
    const offenders = [...src.matchAll(/waitUntil\s*:\s*["']networkidle["']/g)];
    expect(
      offenders.length,
      `${file} waits on networkidle. The app holds a persistent WebSocket, so the ` +
        `network never goes idle: this hangs 30s and fails a page that rendered fine. ` +
        `Use waitUntil:"domcontentloaded" plus an explicit waitForSelector.`,
    ).toBe(0);
  });

  it("waits on the app shell before asserting on it", () => {
    // App returns ONLY a "Loading…" div while useGetMeQuery is in flight — no header,
    // no nav. With domcontentloaded, asserting immediately after a goto races the
    // first paint, which is what made "found 0 sections" look like a nav bug.
    expect(NAV_MATRIX).toMatch(/async function shows\(/);
    expect(NAV_MATRIX).toMatch(/waitForSelector/);
  });
});
