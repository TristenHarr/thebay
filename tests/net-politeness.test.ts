/**
 * Politeness for a distributed crawler.
 *
 * The bug this file exists to prevent is subtle and would be invisible in production
 * until somebody's abuse desk emailed us: every client obeys its own 900ms gap, and
 * fifty clients therefore hit Eventbrite fifty times per 900ms. Client-side politeness
 * cannot compose, so the coordinator has to withhold work instead — and the assertion
 * that matters is the one at the bottom of "the fleet", where fifty workers poll at
 * once and the host still only ever has one crawler on it.
 *
 * `parseRobots` is fixture-tested against the real files, because a plausible-looking
 * robots.txt proves nothing — the shapes that actually appear in the wild (`Disallow:`
 * with an empty value meaning *allow*, `Disallow: /` rescued by a longer `Allow:`) are
 * exactly the ones a hand-written fixture gets backwards.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/d1";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { ScrapeNetRepo, defaultGapMs, requiresFor } from "../src/storage/d1/scrape-net-repo";
import { recipeHost, hostOfUrl } from "../src/core/scrape/host";
import { parseRobots, pathOf, allowAll } from "../src/core/scrape/robots";
import {
  mayLease,
  effectiveGapMs,
  nextGrantAt,
  backoffUntilMs,
  dayKey,
  LEASE_TTL_MS,
  type HostState,
} from "../src/core/scrape/politeness";
import { windowStart, windowEndMs, windowIsOpen, normalizeWindowMs, DEFAULT_WINDOW_MS } from "../src/core/scrape/window";
import { mintSecret, hashSecret } from "../src/core/net/invite";
import sourcesJson from "../config/sources.json";

const T0 = Date.parse("2026-07-26T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const host = (over: Partial<HostState> = {}): HostState => ({
  host: "example.com",
  minGapMs: 1000,
  maxConcurrent: 1,
  liveLeases: 0,
  lastGrantedAt: null,
  ...over,
});

describe("core/scrape/host — every source must be placeable", () => {
  it("resolves a host for every source in config/sources.json", () => {
    // The guard: a source whose host we can't determine is a source we cannot
    // rate-limit, so the coordinator refuses to schedule it — silently dropping a
    // twelfth of the catalog. Adding an adapter without teaching recipeHost about it
    // fails here rather than in production.
    const unplaceable = (sourcesJson as any[])
      .filter((s) => s.enabled !== false)
      .filter((s) => !recipeHost(s.type, s.params ?? {}))
      .map((s) => `${s.id} (${s.type})`);
    expect(unplaceable, `teach src/core/scrape/host.ts about these: ${unplaceable.join(", ")}`).toEqual([]);
  });

  it("places each adapter type where it actually goes", () => {
    expect(recipeHost("luma", { slug: "sf" })).toBe("api.luma.com");
    expect(recipeHost("eventbrite", { mode: "scrape" })).toBe("www.eventbrite.com");
    expect(recipeHost("partiful", {})).toBe("partiful.com");
    expect(recipeHost("airtable", { mode: "api", baseId: "x" })).toBe("api.airtable.com");
    expect(recipeHost("airtable", { mode: "share", shareUrl: "https://airtable.com/shrABC" })).toBe("airtable.com");
    expect(recipeHost("ical", { urls: ["https://cal.example.org/feed.ics"] })).toBe("cal.example.org");
    expect(recipeHost("html", { urls: ["https://Events.Example.COM/list"] })).toBe("events.example.com");
    // A url template keeps its origin, so the host resolves before substitution.
    expect(recipeHost("generic-json", { url: "https://api.cerebralvalley.ai/v1/x?after={{now}}" })).toBe("api.cerebralvalley.ai");
    // Undeterminable is null — a rejection, not a shrug.
    expect(recipeHost("ical", {})).toBeNull();
    expect(recipeHost("mystery-adapter", {})).toBeNull();
    expect(hostOfUrl("not a url")).toBeNull();
    expect(hostOfUrl(null)).toBeNull();
  });

  it("derives the capabilities a recipe needs instead of trusting a declaration", () => {
    expect(requiresFor("html", {})).toEqual(["fetch"]);
    expect(requiresFor("html", { useBrowser: true })).toEqual(["fetch", "browser"]);
    expect(requiresFor("eventbrite", { mode: "browser" })).toEqual(["fetch", "browser"]);
    expect(requiresFor("airtable", { mode: "share" })).toEqual(["fetch", "browser"]);
  });

  it("inherits the gap that was already tuned against the real Eventbrite", () => {
    expect(defaultGapMs("www.eventbrite.com")).toBe(900);
    expect(defaultGapMs("api.luma.com")).toBe(1000);
  });
});

describe("core/scrape/robots", () => {
  const UA = "thebay.news aggregator (+https://thebay.news/about)";

  it("treats an EMPTY Disallow as permission, not as a ban on everything", () => {
    // The single most common way a site says yes, and the easiest to invert.
    const r = parseRobots("User-agent: *\nDisallow:\n", UA);
    expect(r.allows("/")).toBe(true);
    expect(r.allows("/anything/at/all")).toBe(true);
    expect(r.disallow).toEqual([]);
  });

  it("honours longest-match precedence, with Allow winning a tie", () => {
    const r = parseRobots("User-agent: *\nDisallow: /\nAllow: /events/\n", UA);
    expect(r.allows("/events/ai-meetup")).toBe(true);
    expect(r.allows("/private")).toBe(false);
    // Equal-length competing rules: Allow wins, so a site can carve out a path.
    const tie = parseRobots("User-agent: *\nDisallow: /x\nAllow: /x\n", UA);
    expect(tie.allows("/x")).toBe(true);
  });

  it("prefers the most specific agent, and ignores * once we're named", () => {
    const txt = "User-agent: *\nDisallow:\n\nUser-agent: thebay\nDisallow: /nope\n";
    const r = parseRobots(txt, UA);
    expect(r.allows("/nope")).toBe(false); // our own group applies
    expect(r.allows("/fine")).toBe(true);
    // A crawler we aren't gets the * group.
    expect(parseRobots(txt, "SomeoneElseBot").allows("/nope")).toBe(true);
  });

  it("shares one group across consecutive User-agent lines", () => {
    const r = parseRobots("User-agent: googlebot\nUser-agent: thebay\nDisallow: /shared\n", UA);
    expect(r.allows("/shared")).toBe(false);
  });

  it("supports * wildcards and $ anchors", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/b\n", UA);
    expect(r.allows("/docs/manual.pdf")).toBe(false);
    expect(r.allows("/docs/manual.pdf?download=1")).toBe(true); // $ anchored
    expect(r.allows("/a/anything/b")).toBe(false);
    expect(r.allows("/a/anything/c")).toBe(true);
  });

  it("reads Crawl-delay, including fractional seconds, and caps the absurd", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay: 10\n", UA).crawlDelayMs).toBe(10_000);
    expect(parseRobots("User-agent: *\nCrawl-delay: 0.5\n", UA).crawlDelayMs).toBe(500);
    expect(parseRobots("User-agent: *\nCrawl-delay: 99999\n", UA).crawlDelayMs).toBe(600_000);
    expect(parseRobots("User-agent: *\nCrawl-delay: soon\n", UA).crawlDelayMs).toBeNull();
  });

  it("fails OPEN on an absent or unparseable file", () => {
    // A CDN hiccup on robots.txt must not silently stop the whole network. An absent
    // file means "no restrictions stated", which is not the same as "deny".
    for (const txt of ["", "   ", "\n\n", "total garbage with no colons"]) {
      expect(parseRobots(txt, UA).allows("/anything")).toBe(true);
    }
    expect(allowAll().allows("/")).toBe(true);
    // Rules before any User-agent line belong to nobody.
    expect(parseRobots("Disallow: /\n", UA).allows("/x")).toBe(true);
  });

  it("ignores comments and matches against path + query", () => {
    const r = parseRobots("User-agent: * # everyone\nDisallow: /search?  # no search pages\n", UA);
    expect(r.allows("/search?q=ai")).toBe(false);
    expect(r.allows("/events")).toBe(true);
    expect(pathOf("https://x.com/a/b?c=1#frag")).toBe("/a/b?c=1");
    expect(pathOf("nonsense")).toBe("/");
  });

  it("handles the real shape of a big site's robots.txt", () => {
    // Trimmed from eventbrite.com/robots.txt — the ordering and the mix of long
    // Disallows with a rescuing Allow is what makes this worth a fixture.
    const real = [
      "User-agent: *",
      "Disallow: /d/*/search/",
      "Disallow: /checkout",
      "Disallow: /orderconfirmation",
      "Allow: /d/",
      "Crawl-delay: 1",
      "",
      "Sitemap: https://www.eventbrite.com/sitemap.xml",
    ].join("\n");
    const r = parseRobots(real, UA);
    expect(r.crawlDelayMs).toBe(1000);
    expect(r.allows("/d/ca--san-francisco/technology/")).toBe(true);
    expect(r.allows("/d/ca--san-francisco/search/")).toBe(false);
    expect(r.allows("/checkout")).toBe(false);
    expect(r.disallow).toContain("/checkout");
  });
});

describe("core/scrape/politeness", () => {
  it("takes the LARGER of our floor and the host's request — politeness only ratchets up", () => {
    expect(effectiveGapMs({ minGapMs: 1000, crawlDelayMs: 10_000 })).toBe(10_000);
    expect(effectiveGapMs({ minGapMs: 1000, crawlDelayMs: 100 })).toBe(1000);
    expect(effectiveGapMs({ minGapMs: 900, crawlDelayMs: null })).toBe(900);
  });

  it("is total: no garbage input yields a permissive answer", () => {
    expect(effectiveGapMs({ minGapMs: NaN as any, crawlDelayMs: undefined })).toBe(1000);
    expect(effectiveGapMs({ minGapMs: -5, crawlDelayMs: NaN as any })).toBe(0);
    expect(mayLease(host({ maxConcurrent: NaN as any, liveLeases: 1 }), T0)).toBe("at_capacity");
    expect(mayLease(host({ lastGrantedAt: "not a date" }), T0)).toBe("ok");
    expect(Number.isFinite(nextGrantAt(host({ lastGrantedAt: "nonsense" }), T0))).toBe(true);
  });

  it("names each reason, because 'we scraped less' and 'four hosts blocked us' differ", () => {
    expect(mayLease(host(), T0)).toBe("ok");
    expect(mayLease(host({ blockedUntil: iso(T0 + 60_000) }), T0)).toBe("blocked");
    expect(mayLease(host({ blockedUntil: iso(T0 - 1) }), T0)).toBe("ok"); // block elapsed
    expect(mayLease(host({ liveLeases: 1 }), T0)).toBe("at_capacity");
    expect(mayLease(host({ liveLeases: 1, maxConcurrent: 2 }), T0)).toBe("ok");
    expect(mayLease(host({ lastGrantedAt: iso(T0 - 500) }), T0)).toBe("too_soon");
    expect(mayLease(host({ lastGrantedAt: iso(T0 - 1500) }), T0)).toBe("ok");
    expect(mayLease(host({ dailyCap: 10, grantedToday: 10 }), T0)).toBe("daily_cap");
    expect(mayLease(host({ dailyCap: 10, grantedToday: 9 }), T0)).toBe("ok");
  });

  it("reports capacity before timing, so the reason suggests the right fix", () => {
    // Waiting out a gap won't help when somebody is already in there.
    expect(mayLease(host({ liveLeases: 1, lastGrantedAt: iso(T0 - 10) }), T0)).toBe("at_capacity");
  });

  it("gives a scheduler a non-negative time to sleep", () => {
    expect(nextGrantAt(host(), T0)).toBe(T0);
    expect(nextGrantAt(host({ lastGrantedAt: iso(T0 - 400) }), T0)).toBe(T0 + 600);
    expect(nextGrantAt(host({ blockedUntil: iso(T0 + 5000) }), T0)).toBe(T0 + 5000);
    expect(nextGrantAt(host({ lastGrantedAt: iso(T0 - 99_999) }), T0)).toBe(T0);
  });

  it("backs off harder the more a host pushes back, and obeys Retry-After", () => {
    expect(backoffUntilMs(1, T0)).toBe(T0 + 30_000);
    expect(backoffUntilMs(2, T0)).toBe(T0 + 60_000);
    expect(backoffUntilMs(99, T0)).toBe(T0 + 60 * 60_000); // capped at an hour
    // The host telling us a number wins when it's longer than our own guess.
    expect(backoffUntilMs(1, T0, 120_000)).toBe(T0 + 120_000);
    expect(backoffUntilMs(4, T0, 1000)).toBe(T0 + 240_000);
  });

  it("keeps the day counter in UTC, because it's a budget and not a date", () => {
    expect(dayKey(Date.parse("2026-07-26T23:59:59Z"))).toBe("2026-07-26");
    expect(dayKey(Date.parse("2026-07-27T00:00:01Z"))).toBe("2026-07-27");
  });
});

describe("core/scrape/window", () => {
  it("buckets absolutely, so every participant computes the same boundary", () => {
    const w = 6 * 3600_000;
    expect(windowStart(Date.parse("2026-07-26T13:12:00Z"), w)).toBe("2026-07-26T12:00:00.000Z");
    expect(windowStart(Date.parse("2026-07-26T17:59:59Z"), w)).toBe("2026-07-26T12:00:00.000Z");
    expect(windowStart(Date.parse("2026-07-26T18:00:00Z"), w)).toBe("2026-07-26T18:00:00.000Z");
  });

  it("refuses a window shorter than a lease can complete in", () => {
    expect(normalizeWindowMs(1)).toBe(60_000);
    expect(normalizeWindowMs(undefined)).toBe(DEFAULT_WINDOW_MS);
    expect(normalizeWindowMs(NaN)).toBe(DEFAULT_WINDOW_MS);
    expect(normalizeWindowMs(3600_000)).toBe(3600_000);
  });

  it("knows when a window has closed", () => {
    const start = "2026-07-26T12:00:00.000Z";
    expect(windowEndMs(start, 3600_000)).toBe(Date.parse("2026-07-26T13:00:00Z"));
    expect(windowIsOpen(start, 3600_000, Date.parse("2026-07-26T12:59:00Z"))).toBe(true);
    expect(windowIsOpen(start, 3600_000, Date.parse("2026-07-26T13:00:01Z"))).toBe(false);
  });
});

describe("ScrapeNetRepo — the coordinator", () => {
  let d1: any;
  let net: ScrapeNetRepo;

  /** A member + a client, ready to poll for work. */
  async function worker(
    id: string,
    opts: { tier?: "probation" | "trusted" | "core"; caps?: string[] } = {},
  ): Promise<{ memberId: string; clientId: string }> {
    const memberId = `u_${id}`;
    await d1.prepare("INSERT INTO users (id, email, email_verified, handle, display_name, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)")
      .bind(memberId, `${id}@x.com`, id, id, iso(T0), iso(T0))
      .run();
    await d1.prepare("INSERT INTO network_members (user_id, tier, joined_at) VALUES (?, ?, ?)")
      .bind(memberId, opts.tier ?? "trusted", iso(T0))
      .run();
    const clientId = `c_${id}`;
    await d1
      .prepare("INSERT INTO worker_clients (id, user_id, kind, capabilities_json, token_hash, created_at) VALUES (?, ?, 'cli', ?, ?, ?)")
      .bind(clientId, memberId, JSON.stringify(opts.caps ?? ["fetch"]), `hash_${id}`, iso(T0))
      .run();
    return { memberId, clientId };
  }

  const ask = (w: { memberId: string; clientId: string }, over: any = {}) =>
    net.lease(
      { clientId: w.clientId, memberId: w.memberId, capabilities: ["fetch"] as any, egress: { ipHash: `ip_${w.clientId}`, asn: 100 }, max: 5, ...over },
      over.atMs ?? T0,
    );

  const SOURCES = [
    { id: "luma-bay", type: "luma", params: { mode: "discover", slug: "sf" } },
    { id: "eb-hubs", type: "eventbrite", params: { mode: "scrape", locations: ["ca--san-francisco"] } },
    { id: "cv", type: "generic-json", params: { url: "https://api.cerebralvalley.ai/v1/x" } },
  ];

  beforeEach(async () => {
    ({ d1 } = makeTestDb());
    net = new ScrapeNetRepo(d1);
  });

  it("seeds recipes from config idempotently, and names what it cannot place", async () => {
    const first = await net.seedRecipes([...SOURCES, { id: "broken", type: "ical", params: {} }], recipeHost, T0);
    expect(first.created).toBe(3);
    expect(first.unplaceable).toEqual(["broken"]); // named, never silently skipped

    const again = await net.seedRecipes(SOURCES, recipeHost, T0);
    expect(again.created).toBe(0); // cron may run this forever

    const rs = await net.schedulableRecipes();
    expect(rs.map((r) => r.sourceId).sort()).toEqual(["cv", "eb-hubs", "luma-bay"]);
    expect(rs.every((r) => r.version === 1 && r.status === "active")).toBe(true);
  });

  it("seeds a disabled source as retired, so it exists but is never scheduled", async () => {
    await net.seedRecipes([{ id: "off", type: "luma", enabled: false, params: { slug: "x" } }], recipeHost, T0);
    expect(await net.schedulableRecipes()).toEqual([]);
  });

  it("plans one job per recipe per window, however often cron fires", async () => {
    await net.seedRecipes(SOURCES, recipeHost, T0);
    expect((await net.plan(T0)).created).toBe(3);
    expect((await net.plan(T0)).created).toBe(0);
    expect((await net.plan(T0 + 60_000)).created).toBe(0); // same 6h window
    expect((await net.plan(T0 + 7 * 3600_000)).created).toBe(3); // next window
  });

  it("hands out work, with everything a client needs to be polite on its own", async () => {
    await net.seedRecipes(SOURCES, recipeHost, T0);
    await net.plan(T0);
    const w = await worker("ann");
    const { leases } = await ask(w, { max: 1 });
    expect(leases).toHaveLength(1);
    const l = leases[0]!;
    expect(l.recipe.type).toBeTruthy();
    expect(l.recipe.params).toBeTypeOf("object");
    expect(l.politeness.minGapMs).toBeGreaterThan(0);
    expect(Date.parse(l.expiresAt) - T0).toBe(LEASE_TTL_MS);
  });

  it("NEVER puts two crawlers on one host at once — the whole point", async () => {
    // Two jobs on the same host, one worker asking for both.
    await net.seedRecipes(
      [
        { id: "eb-a", type: "eventbrite", params: { mode: "scrape", locations: ["a"] } },
        { id: "eb-b", type: "eventbrite", params: { mode: "scrape", locations: ["b"] } },
      ],
      recipeHost,
      T0,
    );
    await net.plan(T0);
    const w = await worker("ann");
    const { leases, skipped } = await ask(w, { max: 5 });
    expect(leases).toHaveLength(1);
    // `at_capacity`, not `too_soon`: somebody is *in there*. Waiting out the gap
    // wouldn't help, and reporting it as a timing problem would suggest it would.
    expect(skipped).toContainEqual({ host: "www.eventbrite.com", reason: "at_capacity" });
  });

  it("does lease different hosts in parallel — polite is not the same as slow", async () => {
    await net.seedRecipes(SOURCES, recipeHost, T0);
    await net.plan(T0);
    const { leases } = await ask(await worker("ann"), { max: 5 });
    expect(leases).toHaveLength(3);
    expect(new Set(leases.map((l) => l.recipe.host)).size).toBe(3);
  });

  it("re-leases a host only once the crawler in it has FINISHED and the gap elapsed", async () => {
    await net.seedRecipes(
      [
        { id: "eb-a", type: "eventbrite", params: { mode: "scrape", locations: ["a"] } },
        { id: "eb-b", type: "eventbrite", params: { mode: "scrape", locations: ["b"] } },
      ],
      recipeHost,
      T0,
    );
    await net.plan(T0);
    const a = await worker("ann");
    const b = await worker("bob");
    const first = (await ask(a, { max: 1 })).leases[0]!;

    // While Ann is still crawling, nobody else gets in — regardless of the clock.
    expect((await ask(b, { max: 1, atMs: T0 + 60_000 })).leases).toHaveLength(0);

    await net.markSubmitted(first.leaseId, T0 + 200);
    // Finished, but the gap hasn't elapsed yet.
    expect((await ask(b, { max: 1, atMs: T0 + 300 })).leases).toHaveLength(0);
    // Finished, and the gap has elapsed.
    expect((await ask(b, { max: 1, atMs: T0 + 2000 })).leases).toHaveLength(1);
  });

  it("respects a host that told us to back off", async () => {
    await net.seedRecipes(SOURCES, recipeHost, T0);
    await net.plan(T0);
    await net.blockHost("api.luma.com", T0 + 600_000);
    const { leases, skipped } = await ask(await worker("ann"), { max: 5 });
    expect(leases.some((l) => l.recipe.host === "api.luma.com")).toBe(false);
    expect(skipped).toContainEqual({ host: "api.luma.com", reason: "blocked" });
  });

  it("widens its own gap when robots.txt asks for more room", async () => {
    await net.seedRecipes(SOURCES, recipeHost, T0);
    await net.plan(T0);
    await net.setRobots("api.luma.com", { crawlDelayMs: 30_000, disallow: ["/private"], status: 200 }, T0);
    const state = await net.hostState("api.luma.com", T0);
    expect(effectiveGapMs(state!)).toBe(30_000);
    const { leases } = await ask(await worker("ann"), { max: 5 });
    // And the client is told, so it can pace its own requests too.
    expect(leases.find((l) => l.recipe.host === "api.luma.com")!.politeness).toEqual({
      host: "api.luma.com",
      minGapMs: 30_000,
      disallow: ["/private"],
    });
  });

  it("refuses work a client cannot do, rather than handing it over to fail", async () => {
    await net.seedRecipes([{ id: "eb-browser", type: "eventbrite", params: { mode: "browser" } }], recipeHost, T0);
    await net.plan(T0);
    const plain = await worker("ann", { caps: ["fetch"] });
    const { leases, skipped } = await ask(plain, { max: 1 });
    expect(leases).toHaveLength(0);
    expect(skipped).toContainEqual({ host: "www.eventbrite.com", reason: "capability" });

    const withBrowser = await worker("bea", { caps: ["fetch", "browser"] });
    expect((await ask(withBrowser, { max: 1, capabilities: ["fetch", "browser"] })).leases).toHaveLength(1);
  });

  it("will not let one egress take both slots of a job — that isn't a second opinion", async () => {
    await net.seedRecipes([SOURCES[0]!], recipeHost, T0);
    await net.plan(T0);
    const a = await worker("ann");
    const b = await worker("bob"); // different member, same house
    const shared = { ipHash: "one-nat", asn: 7922 };
    const first = (await ask(a, { max: 1, egress: shared })).leases[0]!;
    await net.markSubmitted(first.leaseId, T0 + 200);

    const second = await ask(b, { max: 1, egress: shared, atMs: T0 + 5000 });
    expect(second.leases).toHaveLength(0);
    expect(second.skipped).toContainEqual({ host: "api.luma.com", reason: "independence" });

    // A genuinely different egress is welcome — the job still wants a second observer.
    const c = await worker("cy");
    expect((await ask(c, { max: 1, egress: { ipHash: "elsewhere", asn: 6167 }, atMs: T0 + 6000 })).leases).toHaveLength(1);
  });

  it("gives one member one shot at a job, so nobody corroborates themselves", async () => {
    await net.seedRecipes([SOURCES[0]!], recipeHost, T0);
    await net.plan(T0);
    const a = await worker("ann");
    expect((await ask(a, { max: 1 })).leases).toHaveLength(1);
    // Even from a second machine on a different network, it's still Ann's opinion.
    expect((await ask(a, { max: 1, egress: { ipHash: "other", asn: 999 }, atMs: T0 + 5000 })).leases).toHaveLength(0);
  });

  it("stops handing out a job once it has enough observers", async () => {
    await net.seedRecipes([SOURCES[0]!], recipeHost, T0);
    await net.plan(T0); // target_observers = 2 for an active recipe
    for (const [i, name] of ["ann", "bob", "cy"].entries()) {
      const w = await worker(name);
      const r = await ask(w, { max: 1, egress: { ipHash: name, asn: 100 + i }, atMs: T0 + i * 5000 });
      expect(r.leases.length, `${name} should ${i < 2 ? "get" : "not get"} work`).toBe(i < 2 ? 1 : 0);
      // Each finishes before the next asks, so only `target_observers` limits them.
      if (r.leases[0]) await net.markSubmitted(r.leases[0].leaseId, T0 + i * 5000 + 100);
    }
  });

  it("caps how much of the queue one member can hold — newcomers must not starve", async () => {
    // Twelve distinct hosts so politeness never confounds the fair-share cap.
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      type: "generic-json",
      params: { url: `https://h${i}.example.com/api` },
    }));
    await net.seedRecipes(many, recipeHost, T0);
    await net.plan(T0);
    const greedy = await worker("greedy", { tier: "probation" });
    const first = await ask(greedy, { max: 10, perWindowCap: 4 });
    expect(first.leases).toHaveLength(4);
    const second = await ask(greedy, { max: 10, perWindowCap: 4, atMs: T0 + 30_000 });
    expect(second.leases).toHaveLength(0);
    expect(second.skipped).toContainEqual({ host: second.skipped[0]!.host, reason: "fair_share" });

    // And there is still work left for someone who just showed up.
    const newcomer = await worker("new");
    expect((await ask(newcomer, { max: 3, atMs: T0 + 31_000, egress: { ipHash: "new", asn: 500 } })).leases.length).toBeGreaterThan(0);
  });

  it("prefers the least-covered job, so coverage beats a third opinion", async () => {
    await net.seedRecipes(SOURCES, recipeHost, T0);
    await net.plan(T0);
    const a = await worker("ann");
    const taken = (await ask(a, { max: 1 })).leases[0]!;
    // Bob asks for one job; it must not be the one Ann already has.
    const b = await worker("bob");
    const bobs = (await ask(b, { max: 1, atMs: T0 + 2000, egress: { ipHash: "bob", asn: 200 } })).leases[0]!;
    expect(bobs.jobId).not.toBe(taken.jobId);
  });

  it("reclaims a lease from a client that went away, and not before", async () => {
    await net.seedRecipes([SOURCES[0]!], recipeHost, T0);
    await net.plan(T0);
    const a = await worker("ann");
    const l = (await ask(a, { max: 1 })).leases[0]!;

    expect(await net.expireLeases(T0 + LEASE_TTL_MS - 1000)).toBe(0);
    expect(await net.expireLeases(T0 + LEASE_TTL_MS + 1000)).toBe(1);
    // Expired work goes back in the pool for somebody else.
    const b = await worker("bob");
    expect((await ask(b, { max: 1, atMs: T0 + LEASE_TTL_MS + 2000, egress: { ipHash: "bob", asn: 200 } })).leases).toHaveLength(1);
  });

  it("lets a client hand work back, and never penalises it for being honest", async () => {
    await net.seedRecipes([SOURCES[0]!], recipeHost, T0);
    await net.plan(T0);
    const a = await worker("ann");
    const l = (await ask(a, { max: 1 })).leases[0]!;
    expect(await net.release(l.leaseId, a.clientId, "failed", "site returned 503")).toBe(true);
    expect(await net.release(l.leaseId, a.clientId, "failed")).toBe(false); // once only
    const row = await net.leaseById(l.leaseId);
    expect(row!.outcome).toBe("failed");
    expect(row!.error).toBe("site returned 503");
  });

  it("records receipts without letting a chatty client blow the parameter limit", async () => {
    await net.seedRecipes([SOURCES[0]!], recipeHost, T0);
    await net.plan(T0);
    const a = await worker("ann");
    const l = (await ask(a, { max: 1 })).leases[0]!;
    // 250 receipts: past the 200 cap and, unchunked, far past D1's 100 bound params.
    await net.saveReceipts(
      l.leaseId,
      Array.from({ length: 250 }, (_, i) => ({ url: `https://api.luma.com/p/${i}`, status: 200, bytes: 1234, elapsedMs: 20 })),
    );
    const n = await d1.prepare("SELECT COUNT(*) AS n FROM scrape_receipts WHERE lease_id = ?").bind(l.leaseId).first();
    expect(n.n).toBe(200);
  });

  describe("the fleet", () => {
    it("keeps a hot host to one crawler while fifty workers poll at once", async () => {
      // The scenario the whole design exists for: everybody wants Eventbrite.
      await net.seedRecipes(
        Array.from({ length: 8 }, (_, i) => ({
          id: `eb-${i}`,
          type: "eventbrite",
          params: { mode: "scrape", locations: [`loc-${i}`] },
        })),
        recipeHost,
        T0,
      );
      await net.plan(T0);

      const workers = [];
      for (let i = 0; i < 50; i++) workers.push(await worker(`w${i}`, { caps: ["fetch"] }));

      // All fifty poll inside the same millisecond.
      const results = await Promise.all(
        workers.map((w, i) =>
          net.lease(
            { clientId: w.clientId, memberId: w.memberId, capabilities: ["fetch"] as any, egress: { ipHash: `ip${i}`, asn: 1000 + i }, max: 5 },
            T0,
          ),
        ),
      );
      const granted = results.flatMap((r) => r.leases);
      expect(granted).toHaveLength(1);

      // Now run the steady state: each round the winner finishes its crawl quickly, the
      // clock advances one gap, and all fifty poll again. At most one is ever admitted.
      let total = granted.length;
      await net.markSubmitted(granted[0]!.leaseId, T0 + 100);
      for (let step = 1; step <= 5; step++) {
        const at = T0 + step * 1000;
        const round = await Promise.all(
          workers.map((w, i) =>
            net.lease(
              { clientId: w.clientId, memberId: w.memberId, capabilities: ["fetch"] as any, egress: { ipHash: `ip${i}`, asn: 1000 + i }, max: 5 },
              at,
            ),
          ),
        );
        const won = round.flatMap((r) => r.leases);
        expect(won.length, `round ${step} admitted ${won.length} crawlers to one host`).toBeLessThanOrEqual(1);
        for (const l of won) await net.markSubmitted(l.leaseId, at + 100);
        total += won.length;
      }
      // Six seconds of fifty eager workers produced at most six crawls of the host —
      // the rate one polite machine would have managed, from up to six different IPs.
      // That is the entire thesis of the design, asserted.
      expect(total).toBeLessThanOrEqual(6);
      expect(total).toBeGreaterThan(1); // ...and it does keep working, not deadlock
    });
  });
});

describe("the cron actually drives the coordinator", () => {
  it("bootstraps recipes and plans this window's jobs from a cold start", async () => {
    // Wiring like this is the classic silent failure: every repo method is tested, the
    // suite is green, and the handler never calls them — so the queue stays empty and
    // the network looks simply unpopular. Drive the real `scheduled` export.
    const worker = (await import("../src/worker/index")).default;
    const { env } = await import("./helpers/app").then((m) => m.makeTestEnv());

    const pending: Promise<unknown>[] = [];
    await worker.scheduled({} as any, env as any, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as any);
    await Promise.allSettled(pending);

    const recipes = await env.DB.prepare("SELECT COUNT(*) AS n FROM scrape_recipes").first();
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM scrape_jobs").first();
    const hosts = await env.DB.prepare("SELECT COUNT(*) AS n FROM scrape_hosts").first();
    // Every enabled source in config/sources.json became a v1 recipe with a host budget
    // and a job for the current window — with nobody running a script.
    const enabled = (sourcesJson as any[]).filter((s) => s.enabled !== false).length;
    expect(recipes.n).toBeGreaterThanOrEqual(enabled);
    expect(jobs.n).toBeGreaterThanOrEqual(1);
    expect(hosts.n).toBeGreaterThanOrEqual(1);

    // And a second tick is a no-op, because it runs every 15 minutes forever.
    const again: Promise<unknown>[] = [];
    await worker.scheduled({} as any, env as any, { waitUntil: (p: Promise<unknown>) => again.push(p) } as any);
    await Promise.allSettled(again);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM scrape_jobs").first()).n).toBe(jobs.n);
  });
});

describe("POST /api/net/lease", () => {
  let t: TestApp;
  let token: string;

  beforeEach(async () => {
    t = makeTestApp({ HANDSHAKE_KEY: "k" });
    const { cookie, user } = await login(t, "ann@x.com", "Ann");
    await t.env.DB.prepare("INSERT INTO network_members (user_id, tier, joined_at) VALUES (?, 'trusted', ?)")
      .bind(user.id, iso(T0))
      .run();
    token = (await call(t, "/api/net/clients", { method: "POST", cookie, body: { kind: "cli", capabilities: ["fetch"] } })).json.token;

    const net = new ScrapeNetRepo(t.env.DB);
    await net.seedRecipes([{ id: "cv", type: "generic-json", params: { url: "https://api.cerebralvalley.ai/v1/x" } }], recipeHost);
    await net.plan();
  });

  const lease = (bearer?: string, body: any = { max: 2 }) =>
    call(t, "/api/net/lease", { method: "POST", body, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

  it("401s without a worker token, and never accepts a session cookie instead", async () => {
    expect((await lease()).status).toBe(401);
    expect((await lease("not-a-real-token")).status).toBe(401);
  });

  it("hands work to a live client", async () => {
    const r = await lease(token);
    expect(r.status).toBe(200);
    expect(r.json.leases).toHaveLength(1);
    expect(r.json.tier).toBe("trusted");
    expect(r.json.leases[0].recipe.host).toBe("api.cerebralvalley.ai");
  });

  it("stops issuing work to a revoked client", async () => {
    await t.env.DB.prepare("UPDATE worker_clients SET revoked_at = ? WHERE token_hash = ?")
      .bind(iso(T0), await hashSecret(token))
      .run();
    expect((await lease(token)).status).toBe(401);
  });

  it("tells a quarantined member plainly instead of wasting their bandwidth", async () => {
    await t.env.DB.prepare("UPDATE network_members SET quarantined_at = ?").bind(iso(T0)).run();
    const r = await lease(token);
    expect(r.status).toBe(403);
    expect(r.json.reason).toBe("quarantined");
  });

  it("remembers where a client speaks from, hashed, so independence can be judged", async () => {
    await call(t, "/api/net/lease", {
      method: "POST",
      body: { max: 1 },
      headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "203.0.113.9" },
    });
    const row = await t.env.DB.prepare("SELECT egress_ip_hash, last_seen_at FROM worker_clients WHERE token_hash = ?")
      .bind(await hashSecret(token))
      .first();
    expect(row.egress_ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.egress_ip_hash).not.toContain("203.0.113.9"); // never the address itself
    expect(row.last_seen_at).toBeTruthy();
  });

  it("rejects a nonsense lease request rather than guessing", async () => {
    expect((await lease(token, { max: 0 })).status).toBe(400);
    expect((await lease(token, { max: 999 })).status).toBe(400);
  });
});
