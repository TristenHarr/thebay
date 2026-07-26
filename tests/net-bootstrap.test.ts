/**
 * Making the network actually start, and actually keep its promises.
 *
 * Everything else in this suite tests a network that is already running. This file tests the
 * things that decide whether it ever runs at all — each of which was a real hole:
 *
 *   · **Bootstrap.** Only `trusted`/`core` members may vouch, and `network_members` starts
 *     empty, so with no founding member the network can NEVER admit its first person. A
 *     chicken-and-egg that would have looked like a mysterious 403 in production.
 *   · **robots.txt.** `parseRobots` existed and nothing called it, so `crawl_delay_ms` and
 *     `disallow_json` stayed empty forever and the politeness claim was aspirational.
 *   · **Backing off.** `blockHost` and `backoffUntilMs` existed and nothing called them, so a
 *     host telling us to go away had no way to be heard.
 *   · **Observability.** No way to answer "is the network working?" without opening the DB.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, makeTestEnv, call, login, type TestApp } from "./helpers/app";
import { makeTestDb } from "./helpers/d1";
import { ScrapeNetRepo } from "../src/storage/d1/scrape-net-repo";
import { NetworkRepo } from "../src/storage/d1/network-repo";
import { seedFoundingMembers, refreshRobots, NETWORK_UA, ROBOTS_TTL_MS } from "../src/worker/net-tick";
import { recipeHost, recipePath } from "../src/core/scrape/host";
import { backoffUntilMs } from "../src/core/scrape/politeness";

const T0 = Date.parse("2026-07-26T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SF = { lat: 37.7879, lng: -122.4075 };

describe("bootstrapping the very first member", () => {
  let t: TestApp;

  async function user(handle: string) {
    const { cookie, user } = await login(t, `${handle}@x.com`, handle);
    await t.env.DB.prepare("UPDATE users SET handle = ? WHERE id = ?").bind(handle, user.id).run();
    return { cookie, userId: user.id };
  }

  beforeEach(() => {
    t = makeTestApp({ HANDSHAKE_KEY: "k", ADMIN_HANDLES: "ann,raj" });
  });

  it("without a founding member, NOBODY can ever get in", async () => {
    // The hole, demonstrated. Every account is a non-member, only members can vouch, so the
    // first handshake is unreachable and the network is inert.
    const a = await user("ann");
    const r = await call(t, "/api/net/invite", { method: "POST", cookie: a.cookie, body: SF });
    expect(r.status).toBe(403);
  });

  it("seeds the operator's own handles as founding members, from config", async () => {
    // Privilege from `ADMIN_HANDLES` — config, not a DB column — for the same reason
    // moderation works that way: it cannot be escalated by an application bug, and changing
    // who founds the network requires access to the deployment.
    const a = await user("ann");
    const raj = await user("raj");
    const bystander = await user("zed");

    const { seeded } = await seedFoundingMembers(t.env as any, T0);
    expect(seeded.sort()).toEqual([a.userId, raj.userId].sort());

    const members = new NetworkRepo(t.env.DB);
    expect((await members.member(a.userId))!.tier).toBe("core");
    expect((await members.member(raj.userId))!.tier).toBe("core");
    // A founding member has no voucher and no invite — nobody let them in, which is exactly
    // what "founding" means. Both columns are nullable for this.
    expect((await members.member(a.userId))!.vouchedBy).toBeNull();
    expect((await members.member(a.userId))!.inviteId).toBeNull();
    // And nobody else is quietly elevated.
    expect(await members.member(bystander.userId)).toBeNull();
  });

  it("lets the founding member admit the second person, for real", async () => {
    const a = await user("ann");
    await seedFoundingMembers(t.env as any, T0);

    const session = (await call(t, "/api/net/invite", { method: "POST", cookie: a.cookie, body: SF })).json;
    expect(session.sessionId).toBeTruthy();

    const b = await user("bea");
    const now = Math.floor(Date.now() / session.stepMs);
    const i = Math.max(0, session.frames.findIndex((f: any) => f.step === now));
    const frames = session.frames.slice(i, i + 4).map((f: any) => ({ step: f.step, code: f.code }));
    const joined = await call(t, "/api/net/join", {
      method: "POST",
      cookie: b.cookie,
      body: { sessionId: session.sessionId, frames, lat: SF.lat + 0.0001, lng: SF.lng },
    });
    expect(joined.status).toBe(200);
    expect(joined.json.vouchedBy.handle).toBe("ann");
    // The chain is now human: bea is probation and cannot yet vouch for a third person.
    expect((await call(t, "/api/net/me", { cookie: b.cookie })).json.canVouch).toBe(false);
  });

  it("is idempotent, and never demotes or re-founds an existing member", async () => {
    const a = await user("ann");
    await seedFoundingMembers(t.env as any, T0);
    // Suppose ann later loses standing the honest way.
    await t.env.DB.prepare("UPDATE network_members SET tier = 'probation', confirms = 3 WHERE user_id = ?").bind(a.userId).run();

    const again = await seedFoundingMembers(t.env as any, T0 + 86_400_000);
    expect(again.seeded).toEqual([]); // already a member; nothing to do
    const m = await new NetworkRepo(t.env.DB).member(a.userId);
    expect(m!.tier).toBe("probation"); // config founds you once; it does not keep you promoted
    expect(m!.confirms).toBe(3); // and it does not wipe your history
  });

  it("does nothing when no admin handles are configured — no accidental privilege", async () => {
    const bare = makeTestApp({ HANDSHAKE_KEY: "k" }); // no ADMIN_HANDLES
    await login(bare, "ann@x.com", "ann");
    const { seeded } = await seedFoundingMembers(bare.env as any, T0);
    expect(seeded).toEqual([]);
    const n = await bare.env.DB.prepare("SELECT COUNT(*) AS n FROM network_members").first();
    expect(n.n).toBe(0);
  });

  it("waits for the handle to exist rather than inventing an account", async () => {
    // ADMIN_HANDLES names someone who hasn't signed in yet. That's normal on a fresh deploy,
    // and creating a user row for them would be forging an account.
    const { seeded } = await seedFoundingMembers(t.env as any, T0);
    expect(seeded).toEqual([]);
    const n = await t.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    expect(n.n).toBe(0);
  });

  it("runs from the cron, so a fresh deployment founds itself", async () => {
    const a = await user("ann");
    const worker = (await import("../src/worker/index")).default;
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({} as any, t.env as any, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as any);
    await Promise.allSettled(pending);
    expect((await new NetworkRepo(t.env.DB).member(a.userId))!.tier).toBe("core");
  });
});

describe("robots.txt, actually fetched and actually obeyed", () => {
  let d1: any;
  let net: ScrapeNetRepo;
  let env: any;

  const SOURCES = [
    { id: "cv", type: "generic-json", params: { url: "https://api.cerebralvalley.ai/v1/events" } },
    { id: "eb", type: "eventbrite", params: { mode: "scrape", locations: ["ca--san-francisco"], queries: ["tech"] } },
  ];

  beforeEach(async () => {
    ({ env } = makeTestEnv());
    d1 = env.DB;
    net = new ScrapeNetRepo(d1);
    await net.seedRecipes(SOURCES, recipeHost, T0);
  });

  /** A robots.txt server keyed by host. */
  const fakeFetch = (bodies: Record<string, { status?: number; text: string }>) =>
    (async (url: any) => {
      const host = new URL(String(url)).hostname;
      const b = bodies[host];
      if (!b) return new Response("", { status: 404 });
      return new Response(b.text, { status: b.status ?? 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;

  it("identifies itself honestly and stores what the host asked for", async () => {
    const r = await refreshRobots(
      env,
      fakeFetch({
        "api.cerebralvalley.ai": { text: "User-agent: *\nCrawl-delay: 12\nDisallow: /admin\n" },
        "www.eventbrite.com": { text: "User-agent: *\nDisallow: /checkout\nAllow: /d/\nCrawl-delay: 1\n" },
      }),
      T0,
    );
    expect(r.fetched).toBe(2);

    const cv = await net.hostState("api.cerebralvalley.ai", T0);
    expect(cv!.crawlDelayMs).toBe(12_000);
    const row = await d1.prepare("SELECT disallow_json, robots_status, robots_fetched_at FROM scrape_hosts WHERE host = ?").bind("api.cerebralvalley.ai").first();
    expect(JSON.parse(row.disallow_json)).toEqual(["/admin"]);
    expect(row.robots_status).toBe(200);
    expect(row.robots_fetched_at).toBeTruthy();

    // We tell sites who we are, with a contact path — the same convention thebay.news uses.
    expect(NETWORK_UA).toMatch(/thebay\.events/);
    expect(NETWORK_UA).toMatch(/\+https?:\/\//);
  });

  it("widens the lease gap to whatever the host asked for", async () => {
    await refreshRobots(env, fakeFetch({ "api.cerebralvalley.ai": { text: "User-agent: *\nCrawl-delay: 30\n" } }), T0);
    await net.plan(T0);
    // 30s is far more than our own 1s floor, so it wins.
    const state = await net.hostState("api.cerebralvalley.ai", T0);
    expect(state!.crawlDelayMs).toBe(30_000);
  });

  it("REFUSES TO LEASE a recipe whose path robots.txt disallows", async () => {
    // The enforcement point. Storing the disallow list and then leasing anyway would be
    // theatre — the coordinator has to be the thing that says no.
    await refreshRobots(env, fakeFetch({ "api.cerebralvalley.ai": { text: "User-agent: *\nDisallow: /v1/\n" } }), T0);
    await net.plan(T0);

    const w = await worker(d1, "ann");
    const { leases, skipped } = await net.lease(
      { clientId: w.clientId, memberId: w.memberId, capabilities: ["fetch"] as any, egress: { ipHash: "ip", asn: 1 }, max: 5 },
      T0,
    );
    expect(leases.find((l) => l.recipe.host === "api.cerebralvalley.ai")).toBeUndefined();
    expect(skipped).toContainEqual({ host: "api.cerebralvalley.ai", reason: "robots" });
  });

  it("still leases a path robots.txt allows on the same host", async () => {
    await refreshRobots(env, fakeFetch({ "www.eventbrite.com": { text: "User-agent: *\nDisallow: /checkout\nAllow: /d/\n" } }), T0);
    await net.plan(T0);
    const w = await worker(d1, "ann");
    const { leases } = await net.lease(
      { clientId: w.clientId, memberId: w.memberId, capabilities: ["fetch"] as any, egress: { ipHash: "ip", asn: 1 }, max: 5 },
      T0,
    );
    expect(leases.some((l) => l.recipe.host === "www.eventbrite.com")).toBe(true);
  });

  it("derives the path a recipe will hit, for every adapter type", () => {
    expect(recipePath("generic-json", { url: "https://a/v1/events?x=1" })).toBe("/v1/events?x=1");
    expect(recipePath("ical", { urls: ["https://a/cal/feed.ics"] })).toBe("/cal/feed.ics");
    expect(recipePath("html", { urls: ["https://a/events/list"] })).toBe("/events/list");
    // Adapters whose path is a property of the adapter, not of its params.
    expect(recipePath("eventbrite", { locations: ["ca--sf"], queries: ["tech"] })).toBe("/d/ca--sf/tech/");
    expect(recipePath("luma", { slug: "sf" })).toMatch(/^\//);
    expect(recipePath("partiful", {})).toMatch(/^\//);
    // Unknown shape falls back to root, which is the most conservative thing to test.
    expect(recipePath("mystery", {})).toBe("/");
  });

  it("fails OPEN on a 404 or an unreachable robots.txt", async () => {
    // A missing robots.txt means "no restrictions stated". Treating a CDN hiccup as deny-all
    // would silently stop the whole network.
    const r = await refreshRobots(env, fakeFetch({}), T0); // everything 404s
    expect(r.fetched).toBe(2);
    await net.plan(T0);
    const w = await worker(d1, "ann");
    const { leases } = await net.lease(
      { clientId: w.clientId, memberId: w.memberId, capabilities: ["fetch"] as any, egress: { ipHash: "ip", asn: 1 }, max: 5 },
      T0,
    );
    expect(leases.length).toBeGreaterThan(0);

    // A thrown fetch is the same: recorded as checked, restricting nothing.
    const threw = await refreshRobots(env, (async () => {
      throw new Error("dns");
    }) as any, T0 + ROBOTS_TTL_MS + 1);
    expect(threw.failed).toBe(2);
  });

  it("re-checks on a TTL rather than on every tick", async () => {
    const bodies = { "api.cerebralvalley.ai": { text: "User-agent: *\nCrawl-delay: 5\n" }, "www.eventbrite.com": { text: "User-agent: *\n" } };
    expect((await refreshRobots(env, fakeFetch(bodies), T0)).fetched).toBe(2);
    // Immediately after: nothing to do. Re-fetching robots.txt four times an hour per host
    // would itself be the impolite thing.
    expect((await refreshRobots(env, fakeFetch(bodies), T0 + 60_000)).fetched).toBe(0);
    expect((await refreshRobots(env, fakeFetch(bodies), T0 + ROBOTS_TTL_MS + 1)).fetched).toBe(2);
  });
});

describe("backing off when a host says no", () => {
  let t: TestApp;
  let net: ScrapeNetRepo;

  const raw = (n: number) => ({
    sourceId: "cv",
    sourceType: "generic-json",
    externalId: `e${n}`,
    title: `Event ${n}`,
    startRaw: `2026-08-0${(n % 8) + 1}T18:00:00-07:00`,
    url: `https://cv.ai/e/${n}`,
    city: "San Francisco",
  });

  async function memberToken(name: string, tier: "probation" | "trusted" | "core") {
    const { cookie, user } = await login(t, `${name}@x.com`, name);
    await t.env.DB.prepare("INSERT INTO network_members (user_id, tier, joined_at) VALUES (?, ?, ?)").bind(user.id, tier, iso(T0)).run();
    const r = await call(t, "/api/net/clients", { method: "POST", cookie, body: { kind: "cli", capabilities: ["fetch"] } });
    return r.json.token as string;
  }

  beforeEach(async () => {
    t = makeTestApp({ HANDSHAKE_KEY: "k" });
    net = new ScrapeNetRepo(t.env.DB);
    await net.seedRecipes([{ id: "cv", type: "generic-json", params: { url: "https://api.cerebralvalley.ai/v1/x" } }], recipeHost);
    await net.plan();
    await t.env.DB.prepare("UPDATE scrape_hosts SET min_gap_ms = 0, max_concurrent = 50").run();
  });

  it("backs a host off when a worker reports a 429, and stops leasing it", async () => {
    // The one signal we never argue with. A client can't be trusted to slow down on its own,
    // but it CAN tell us what the host said — and the receipt is where it says it.
    const token = await memberToken("ann", "core");
    const leased = await call(t, "/api/net/lease", { method: "POST", body: { max: 1 }, headers: { authorization: `Bearer ${token}` } });
    const lease = leased.json.leases[0];

    const r = await call(t, "/api/net/submit", {
      method: "POST",
      body: {
        leaseId: lease.leaseId,
        items: [raw(1)],
        receipts: [{ url: "https://api.cerebralvalley.ai/v1/x", status: 429, elapsedMs: 40 }],
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    expect(r.json.backedOff).toBe(true);

    const host = await t.env.DB.prepare("SELECT blocked_until, rebuffs FROM scrape_hosts WHERE host = ?").bind("api.cerebralvalley.ai").first();
    expect(host.rebuffs).toBe(1);
    expect(Date.parse(host.blocked_until)).toBeGreaterThan(Date.now());

    // And no further work is handed out for it — asked by a DIFFERENT worker, because a member
    // is already excluded from re-taking their own job before the host is even considered.
    const other = await memberToken("bea", "core");
    const again = await call(t, "/api/net/lease", {
      method: "POST",
      body: { max: 1 },
      headers: { authorization: `Bearer ${other}`, "cf-connecting-ip": "8.8.8.8" },
    });
    expect(again.json.leases).toHaveLength(0);
    expect(again.json.skipped).toContainEqual({ host: "api.cerebralvalley.ai", reason: "blocked" });
  });

  it("treats a 403 the same way — a refusal is a refusal", async () => {
    const token = await memberToken("ann", "core");
    const leased = await call(t, "/api/net/lease", { method: "POST", body: { max: 1 }, headers: { authorization: `Bearer ${token}` } });
    const r = await call(t, "/api/net/submit", {
      method: "POST",
      body: { leaseId: leased.json.leases[0].leaseId, items: [], receipts: [{ url: "https://api.cerebralvalley.ai/v1/x", status: 403 }] },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.json.backedOff).toBe(true);
  });

  it("does NOT back off on a plain failure or a good response", async () => {
    // A 500 is the host having a bad day, not asking us to stop; blocking on it would take us
    // off a source for an hour every time somebody deployed.
    const token = await memberToken("ann", "core");
    for (const status of [200, 404, 500, 503]) {
      await net.plan(Date.now() + status * 7 * 3600_000);
      await t.env.DB.prepare("UPDATE scrape_hosts SET last_granted_at = NULL, blocked_until = NULL, rebuffs = 0").run();
      const leased = await call(t, "/api/net/lease", { method: "POST", body: { max: 1 }, headers: { authorization: `Bearer ${token}` } });
      if (!leased.json.leases[0]) continue;
      const r = await call(t, "/api/net/submit", {
        method: "POST",
        body: { leaseId: leased.json.leases[0].leaseId, items: [], receipts: [{ url: "https://api.cerebralvalley.ai/v1/x", status }] },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.json.backedOff, `status ${status}`).toBe(false);
    }
  });

  it("escalates a repeated refusal, and clears once the host is happy again", async () => {
    expect(backoffUntilMs(1, T0) - T0).toBeLessThan(backoffUntilMs(3, T0) - T0);
    await net.blockHost("api.cerebralvalley.ai", T0 + 60_000);
    await t.env.DB.prepare("UPDATE scrape_hosts SET rebuffs = 3 WHERE host = ?").bind("api.cerebralvalley.ai").run();

    // A clean submission resets the counter, so one bad afternoon doesn't hold a source
    // hostage forever.
    await net.clearRebuffs("api.cerebralvalley.ai");
    const host = await t.env.DB.prepare("SELECT rebuffs, blocked_until FROM scrape_hosts WHERE host = ?").bind("api.cerebralvalley.ai").first();
    expect(host.rebuffs).toBe(0);
    expect(host.blocked_until).toBeNull();
  });

  it("backs off when a client hands work back with a 429 in the reason", async () => {
    const token = await memberToken("ann", "core");
    const leased = await call(t, "/api/net/lease", { method: "POST", body: { max: 1 }, headers: { authorization: `Bearer ${token}` } });
    const r = await call(t, `/api/net/lease/${leased.json.leases[0].leaseId}/release`, {
      method: "POST",
      body: { error: "HTTP 429 for https://api.cerebralvalley.ai/v1/x" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const host = await t.env.DB.prepare("SELECT blocked_until FROM scrape_hosts WHERE host = ?").bind("api.cerebralvalley.ai").first();
    expect(host.blocked_until).toBeTruthy();
  });
});

describe("GET /api/net/status", () => {
  let t: TestApp;

  beforeEach(async () => {
    t = makeTestApp({ HANDSHAKE_KEY: "k" });
    const net = new ScrapeNetRepo(t.env.DB);
    await net.seedRecipes([{ id: "cv", type: "generic-json", params: { url: "https://api.cerebralvalley.ai/v1/x" } }], recipeHost);
    await net.plan();
  });

  it("answers 'is the network working?' without opening the database", async () => {
    const r = await call(t, "/api/net/status");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      members: expect.any(Number),
      workers: expect.any(Number),
      recipes: { active: expect.any(Number), shadow: expect.any(Number), proposed: expect.any(Number) },
      jobs: { open: expect.any(Number) },
      hosts: { total: expect.any(Number), blocked: expect.any(Number) },
    });
    expect(r.json.recipes.active).toBe(1);
    expect(r.json.jobs.open).toBe(1);
    // The one thing an operator most needs to know on a fresh deploy.
    expect(r.json.handshakeConfigured).toBe(true);
  });

  it("says plainly when the handshake key is missing — the failure that looks like nothing", async () => {
    const bare = makeTestApp();
    const r = await call(bare, "/api/net/status");
    expect(r.json.handshakeConfigured).toBe(false);
  });

  it("reports observations and what has actually been published", async () => {
    const r = await call(t, "/api/net/status");
    expect(r.json.observations).toMatchObject({ pending: 0, confirmed: 0, published: 0, contradicted: 0, quarantined: 0 });
  });
});

/** A member with a client, ready to poll. Used by the repo-level tests above. */
async function worker(d1: any, id: string): Promise<{ memberId: string; clientId: string }> {
  const memberId = `u_${id}`;
  await d1
    .prepare("INSERT OR IGNORE INTO users (id, email, email_verified, handle, display_name, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)")
    .bind(memberId, `${id}@x.com`, id, id, iso(T0), iso(T0))
    .run();
  await d1.prepare("INSERT OR IGNORE INTO network_members (user_id, tier, joined_at) VALUES (?, 'trusted', ?)").bind(memberId, iso(T0)).run();
  const clientId = `c_${id}`;
  await d1
    .prepare("INSERT OR IGNORE INTO worker_clients (id, user_id, kind, capabilities_json, token_hash, created_at) VALUES (?, ?, 'cli', ?, ?, ?)")
    .bind(clientId, memberId, JSON.stringify(["fetch"]), `hash_${id}`, iso(T0))
    .run();
  return { memberId, clientId };
}
