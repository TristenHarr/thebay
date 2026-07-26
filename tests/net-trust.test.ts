/**
 * Reputation — who gets to publish alone, who gets held, and who gets paid.
 *
 * The scoring has to be right in two directions at once, and it is much easier to get
 * one than both. Too lenient and a fabricator keeps a foothold; too harsh and the
 * honest volunteer whose partner's crawl failed quietly loses their tier and leaves.
 * So most of what follows is about the second direction: a contradiction is refundable,
 * a quiet month costs you standing rather than history, a burst of work cannot buy
 * `trusted` without calendar time, and vouching for someone who turns out badly costs a
 * fraction rather than a multiple.
 *
 * The points rules mirror the ones already in POINTS: discovering pays like a vibe
 * report, corroborating pays like a pin confirm — less than discovering, but never zero,
 * because a network where verifying is unpaid stops verifying.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { ScrapeNetRepo } from "../src/storage/d1/scrape-net-repo";
import { NetworkRepo } from "../src/storage/d1/network-repo";
import { recipeHost } from "../src/core/scrape/host";
import {
  trustScore,
  tierOf,
  shouldQuarantine,
  TIER_RULES,
  QUARANTINE_FLOOR,
  CONTRADICTION_WEIGHT,
  VOUCH_SHARE,
  VOUCH_DEBIT_CAP,
  TRUST_HALF_LIFE_H,
  type MemberStats,
} from "../src/core/net/trust";
import { POINTS } from "../shared/schema";

const T0 = Date.parse("2026-07-26T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const stats = (over: Partial<MemberStats> = {}): MemberStats => ({
  confirms: 0,
  contradictions: 0,
  distinctDays: 0,
  vouchDebits: 0,
  joinedAt: iso(T0 - DAY),
  lastScoredAt: iso(T0),
  ...over,
});

describe("core/net/trust", () => {
  it("weighs a contradiction more heavily than a confirmation", () => {
    // A wrong published event costs a member a wasted trip AND costs the catalog its
    // credibility, so the asymmetry is larger than the crowd map's 1.5.
    expect(CONTRADICTION_WEIGHT).toBeGreaterThan(1.5);
    expect(trustScore(stats({ confirms: 10 }), T0)).toBeCloseTo(10);
    expect(trustScore(stats({ confirms: 10, contradictions: 2 }), T0)).toBeCloseTo(10 - 2 * CONTRADICTION_WEIGHT);
  });

  it("decays standing when someone goes quiet, without erasing what they did", () => {
    const active = stats({ confirms: 100, lastScoredAt: iso(T0) });
    const quiet = stats({ confirms: 100, lastScoredAt: iso(T0 - TRUST_HALF_LIFE_H * HOUR) });
    expect(trustScore(active, T0)).toBeCloseTo(100);
    expect(trustScore(quiet, T0)).toBeCloseTo(100 * Math.exp(-1), 1);
    expect(trustScore(quiet, T0)).toBeGreaterThan(0); // standing fades; it doesn't invert
  });

  it("falls back to the join date for a member who has never been scored", () => {
    const fresh = stats({ confirms: 5, lastScoredAt: null, joinedAt: iso(T0) });
    expect(trustScore(fresh, T0)).toBeCloseTo(5);
  });

  it("is total: no input can produce NaN, because this number orders the queue", () => {
    for (const bad of [
      stats({ confirms: NaN as any }),
      stats({ contradictions: undefined as any }),
      stats({ lastScoredAt: "not a date" }),
      stats({ joinedAt: "", lastScoredAt: null }),
      stats({ lastScoredAt: iso(T0 + 10 * DAY) }), // clock skew: scored in the future
    ]) {
      const s = trustScore(bad, T0);
      expect(Number.isFinite(s), JSON.stringify(bad)).toBe(true);
    }
  });

  it("charges a voucher a FRACTION of their invitee's contradiction, and caps it", () => {
    expect(VOUCH_SHARE).toBeLessThan(1);
    const clean = trustScore(stats({ confirms: 50 }), T0);
    const oneBadInvitee = trustScore(stats({ confirms: 50, vouchDebits: 1 }), T0);
    expect(clean - oneBadInvitee).toBeCloseTo(VOUCH_SHARE);
    // Capped, so introducing people to the network never becomes frightening.
    const many = trustScore(stats({ confirms: 50, vouchDebits: 10_000 }), T0);
    expect(clean - many).toBeCloseTo(VOUCH_SHARE * VOUCH_DEBIT_CAP);
  });

  it("requires calendar time as well as volume before trusting anyone", () => {
    const burst = stats({ confirms: TIER_RULES.trusted.minConfirms * 10, distinctDays: 1 });
    expect(tierOf(burst, T0)).toBe("probation"); // one scripted afternoon buys nothing
    const earned = stats({ confirms: TIER_RULES.trusted.minConfirms, distinctDays: TIER_RULES.trusted.minDays });
    expect(tierOf(earned, T0)).toBe("trusted");
  });

  it("promotes to core only on sustained, corroborated work", () => {
    const core = stats({ confirms: TIER_RULES.core.minConfirms, distinctDays: TIER_RULES.core.minDays });
    expect(tierOf(core, T0)).toBe("core");
    // One short of any single requirement is not core.
    expect(tierOf({ ...core, distinctDays: TIER_RULES.core.minDays - 1 }, T0)).toBe("trusted");
    expect(tierOf({ ...core, confirms: TIER_RULES.core.minConfirms - 1 }, T0)).toBe("trusted");
  });

  it("demotes when contradictions eat the trust that earned the tier", () => {
    const was = stats({ confirms: TIER_RULES.core.minConfirms, distinctDays: TIER_RULES.core.minDays });
    expect(tierOf(was, T0)).toBe("core");
    // Enough bad work and the tier is simply no longer supported by the evidence.
    const spoiled = { ...was, contradictions: Math.ceil(TIER_RULES.core.minConfirms / CONTRADICTION_WEIGHT) };
    expect(tierOf(spoiled, T0)).toBe("probation");
  });

  it("quarantines only on a real deficit, never on a single bad day", () => {
    expect(QUARANTINE_FLOOR).toBeLessThan(0);
    expect(shouldQuarantine(stats({ contradictions: 1 }), T0)).toBe(false);
    expect(shouldQuarantine(stats({ confirms: 40, contradictions: 3 }), T0)).toBe(false);
    // A member who has produced nothing but contradictions.
    const floor = Math.ceil(Math.abs(QUARANTINE_FLOOR) / CONTRADICTION_WEIGHT) + 1;
    expect(shouldQuarantine(stats({ contradictions: floor }), T0)).toBe(true);
    // And a voucher is never quarantined for their invitees alone, only for their own work.
    expect(shouldQuarantine(stats({ vouchDebits: 10_000 }), T0)).toBe(false);
  });

  it("prices the network's work consistently with the rest of the economy", () => {
    // Discovering pays like reading a room you attended; corroborating pays like keeping
    // a map pin true; authoring a recipe that survives the audit pays near hosting.
    expect(POINTS.scrape_find).toBe(POINTS.vibe_report);
    expect(POINTS.scrape_confirm).toBeLessThan(POINTS.scrape_find);
    expect(POINTS.scrape_confirm).toBeGreaterThan(0); // verifying must never be unpaid
    expect(POINTS.scrape_job).toBe(POINTS.shadow);
    expect(POINTS.recipe).toBeGreaterThan(POINTS.scrape_find);
    expect(POINTS.recipe).toBeLessThanOrEqual(POINTS.host);
  });
});

describe("scoring a member from their observations", () => {
  let t: TestApp;
  let net: ScrapeNetRepo;
  let members: NetworkRepo;

  async function join(name: string, tier: "probation" | "trusted" | "core", vouchedBy?: string) {
    const { cookie, user } = await login(t, `${name}@x.com`, name);
    await t.env.DB.prepare("INSERT INTO network_members (user_id, tier, vouched_by, joined_at) VALUES (?, ?, ?, ?)")
      .bind(user.id, tier, vouchedBy ?? null, iso(T0 - 30 * DAY))
      .run();
    const r = await call(t, "/api/net/clients", { method: "POST", cookie, body: { kind: "cli", capabilities: ["fetch"] } });
    return { token: r.json.token, userId: user.id, cookie };
  }

  const TITLES = ["AI Infra Night", "Hardware Happy Hour", "Robotics Demo Day", "Photonics Meetup", "Rust Systems Salon", "Formal Methods Night"];
  const raw = (n: number, over: Record<string, unknown> = {}) => ({
    sourceId: "cv",
    sourceType: "generic-json",
    externalId: `evt-${n}`,
    title: TITLES[n % TITLES.length]!,
    startRaw: `2026-08-0${(n % 8) + 1}T18:00:00-07:00`,
    url: `https://cerebralvalley.ai/e/${n}`,
    city: "San Francisco",
    venueName: `Venue ${n}`,
    ...over,
  });

  async function work(token: string, items: unknown[], ip: string) {
    const leased = await call(t, "/api/net/lease", {
      method: "POST",
      body: { max: 1 },
      headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": ip },
    });
    const lease = leased.json.leases?.[0];
    if (!lease) return null;
    return await call(t, "/api/net/submit", {
      method: "POST",
      body: { leaseId: lease.leaseId, items },
      headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": ip },
    });
  }

  /**
   * Give a member real history: `confirms` published sightings spread over `days` calendar
   * days. Written as actual observation rows against a real lease, because that is what
   * the scoring queries read — seeding the counters directly would be undone by the first
   * rescore, which is exactly the property we want.
   */
  async function seedHistory(userId: string, confirms: number, days: number) {
    // A job of its own, in a long-past window. Attaching the seed lease to the live job
    // would consume one of its `target_observers` slots and silently starve the worker the
    // test is actually about.
    const recipe = await t.env.DB.prepare("SELECT id, source_id, host FROM scrape_recipes LIMIT 1").first();
    const jobId = `seedjob_${userId}`;
    await t.env.DB.prepare(
      `INSERT INTO scrape_jobs (id, recipe_id, source_id, host, window_start, window_ms, status, created_at)
       VALUES (?, ?, ?, ?, ?, 21600000, 'done', ?)`,
    )
      .bind(jobId, recipe.id, recipe.source_id, recipe.host, iso(T0 - 60 * DAY), iso(T0 - 60 * DAY))
      .run();

    const leaseId = `seed_${userId}`;
    await t.env.DB.prepare(
      `INSERT INTO scrape_leases (id, job_id, client_id, member_id, granted_at, expires_at, submitted_at, outcome)
       VALUES (?, ?, (SELECT id FROM worker_clients WHERE user_id = ? LIMIT 1), ?, ?, ?, ?, 'submitted')`,
    )
      .bind(leaseId, jobId, userId, userId, iso(T0 - 30 * DAY), iso(T0 - 30 * DAY), iso(T0 - 30 * DAY))
      .run();
    for (let i = 0; i < confirms; i++) {
      const day = iso(T0 - (i % days) * DAY);
      await t.env.DB.prepare(
        `INSERT INTO scrape_observations (id, lease_id, job_id, member_id, item_key, fingerprint, payload_json, status, resolved_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', 'published', ?, ?)`,
      )
        .bind(`seed_${userId}_${i}`, leaseId, jobId, userId, `seedkey_${userId}_${i}`, `fp_${i}`, day, day)
        .run();
    }
  }

  const member = (userId: string) => members.member(userId);
  const points = async (userId: string, kind?: string) => {
    const r = await t.env.DB.prepare(
      `SELECT kind, points, dedup_key FROM points_ledger WHERE user_id = ?${kind ? " AND kind = ?" : ""}`,
    )
      .bind(...(kind ? [userId, kind] : [userId]))
      .all();
    return r.results as any[];
  };

  beforeEach(async () => {
    t = makeTestApp({ HANDSHAKE_KEY: "k" });
    net = new ScrapeNetRepo(t.env.DB);
    members = new NetworkRepo(t.env.DB);
    await net.seedRecipes([{ id: "cv", type: "generic-json", params: { url: "https://api.cerebralvalley.ai/v1/x" } }], recipeHost);
    await net.plan();
    // Politeness is proven elsewhere; here it would only obscure the scoring.
    await t.env.DB.prepare("UPDATE scrape_hosts SET min_gap_ms = 0, max_concurrent = 50").run();
  });

  it("credits both workers when their sightings corroborate each other", async () => {
    const ann = await join("ann", "probation");
    const bob = await join("bob", "probation");
    const items = [raw(1), raw(2)];
    await work(ann.token, items, "9.9.9.1");
    await work(bob.token, items, "9.9.9.2");

    // Ann reported first, so she is the finder; Bob corroborated.
    const annPts = await points(ann.userId);
    const bobPts = await points(bob.userId);
    expect(annPts.filter((p) => p.kind === "scrape_find")).toHaveLength(2);
    expect(bobPts.filter((p) => p.kind === "scrape_confirm")).toHaveLength(2);
    // Both were paid for turning up and doing a job.
    expect(annPts.filter((p) => p.kind === "scrape_job")).toHaveLength(1);
    expect(bobPts.filter((p) => p.kind === "scrape_job")).toHaveLength(1);

    // And both counters moved.
    expect((await member(ann.userId))!.confirms).toBe(2);
    expect((await member(bob.userId))!.confirms).toBe(2);
  });

  it("pays for the same find exactly once, however many times consensus runs", async () => {
    const ann = await join("ann", "probation");
    const bob = await join("bob", "probation");
    const cy = await join("cy", "probation");
    await t.env.DB.prepare("UPDATE scrape_jobs SET target_observers = 3").run();
    const items = [raw(1)];
    await work(ann.token, items, "1.1.1.1");
    await work(bob.token, items, "1.1.1.2");
    await work(cy.token, items, "1.1.1.3"); // consensus re-runs, re-confirming the same item

    expect(await points(ann.userId, "scrape_find")).toHaveLength(1);
    expect((await member(ann.userId))!.confirms).toBe(1); // not double-counted either
  });

  it("does not pay for a sighting that is only PENDING", async () => {
    const ann = await join("ann", "probation");
    await work(ann.token, [raw(1), raw(2)], "2.2.2.1");
    expect(await points(ann.userId, "scrape_find")).toHaveLength(0);
    expect((await member(ann.userId))!.confirms).toBe(0);
    // But showing up and doing the work still counts.
    expect(await points(ann.userId, "scrape_job")).toHaveLength(1);
  });

  it("charges a contradiction to the fabricator, and to their voucher at a fraction", async () => {
    const amb = await join("amb", "core");
    const liar = await join("liar", "probation", amb.userId);
    const honest = await join("honest", "probation");
    const real = [raw(1), raw(2), raw(3), raw(4)];

    await work(liar.token, [...real, raw(5, { title: "FREE MONEY SEMINAR" })], "3.3.3.1");
    await work(honest.token, real, "3.3.3.2");

    const bad = await member(liar.userId);
    expect(bad!.contradictions).toBe(1);
    expect(bad!.confirms).toBe(4); // the real ones still count — they were real
    // The voucher takes a share, not a copy.
    expect((await member(amb.userId))!.vouchDebits).toBe(1);
    expect((await member(amb.userId))!.contradictions).toBe(0);
  });

  it("stops charging a voucher once their invitee has earned their own standing", async () => {
    const amb = await join("amb", "core");
    const grown = await join("grown", "trusted", amb.userId);
    const honest = await join("honest", "probation");
    // Real history, so the rescore keeps them at `trusted` — a seeded tier alone would be
    // recomputed away, and then they'd still be on probation and the voucher WOULD pay.
    await seedHistory(grown.userId, TIER_RULES.trusted.minConfirms, TIER_RULES.trusted.minDays);
    const real = [raw(1), raw(2), raw(3), raw(4)];

    await work(grown.token, [...real, raw(5, { title: "Ghost Event" })], "4.4.4.1");
    await work(honest.token, real, "4.4.4.2");

    expect((await member(grown.userId))!.contradictions).toBe(1);
    // Vouching liability covers someone's probation, not their whole career.
    expect((await member(amb.userId))!.vouchDebits).toBe(0);
  });

  it("REFUNDS a contradiction when a later worker proves the reporter was right", async () => {
    const ann = await join("ann", "probation");
    const bob = await join("bob", "probation");
    const cy = await join("cy", "probation");
    const shared = [raw(1), raw(2), raw(3), raw(4)];
    const late = raw(5, { title: "Late Addition" });

    await work(ann.token, [...shared, late], "5.5.5.1");
    await work(bob.token, shared, "5.5.5.2");
    expect((await member(ann.userId))!.contradictions).toBe(1);

    await t.env.DB.prepare("UPDATE scrape_jobs SET target_observers = 3").run();
    await work(cy.token, [...shared, late], "5.5.5.3");

    const fixed = await member(ann.userId);
    expect(fixed!.contradictions).toBe(0); // refunded, in full
    expect(fixed!.confirms).toBe(5);
    expect(await points(ann.userId, "scrape_find")).toHaveLength(5);
  });

  it("advances the day counter once per day, not once per event", async () => {
    const ann = await join("ann", "core");
    await work(ann.token, [raw(1), raw(2), raw(3)], "6.6.6.1");
    expect((await member(ann.userId))!.distinctDays).toBe(1);

    // A second job, same calendar day.
    await net.plan(Date.now() + 7 * HOUR);
    await work(ann.token, [raw(4)], "6.6.6.1");
    expect((await member(ann.userId))!.distinctDays).toBe(1);
  });

  it("rewrites the stored trust and tier from the counters, never by hand", async () => {
    const ann = await join("ann", "probation");
    const bob = await join("bob", "probation");
    await work(ann.token, [raw(1), raw(2)], "7.7.7.1");
    await work(bob.token, [raw(1), raw(2)], "7.7.7.2");
    const m = await member(ann.userId);
    expect(m!.trust).toBeGreaterThan(0);
    expect(m!.tier).toBe("probation"); // two confirms is not a career
    expect(m!.lastScoredAt).toBeTruthy();
  });

  it("promotes a member who has genuinely earned it, on the next scoring pass", async () => {
    const ann = await join("ann", "probation");
    const bob = await join("bob", "probation");
    // Standing is RECOMPUTED from observations, never incremented, so it can't be seeded
    // by writing the counters — give her the actual history instead. That's the point of
    // recomputing: the numbers are always derivable from what she really did.
    await seedHistory(ann.userId, TIER_RULES.trusted.minConfirms, TIER_RULES.trusted.minDays);
    await work(ann.token, [raw(1)], "8.8.8.1");
    await work(bob.token, [raw(1)], "8.8.8.2");
    expect((await member(ann.userId))!.tier).toBe("trusted");
    // ...and the tier is what unlocks vouching, with no separate switch to flip.
    expect((await call(t, "/api/net/me", { cookie: ann.cookie })).json.canVouch).toBe(true);
  });

  it("auto-quarantines a member whose work is nothing but contradictions, holding their data", async () => {
    const liar = await join("liar", "probation");
    const honest = await join("honest", "probation");
    const real = Array.from({ length: 5 }, (_, i) => raw(i));

    // Enough rounds to cross the floor: the five real events they also report keep their
    // balance positive for a while, which is exactly the point — quarantine needs a
    // sustained deficit, not one bad afternoon.
    for (let round = 0; round < 10; round++) {
      await net.plan(Date.now() + round * 7 * HOUR);
      await t.env.DB.prepare("UPDATE scrape_hosts SET min_gap_ms = 0, last_granted_at = NULL").run();
      // Backdate what they already hold. The fair-share cap counts leases from the last
      // hour, and these rounds stand in for days of work — without this the loop would
      // stall on fair share (correctly) long before it reached the quarantine floor.
      await t.env.DB.prepare("UPDATE scrape_leases SET granted_at = ?").bind(iso(Date.now() - 3 * HOUR)).run();
      const fake = raw(90 + round, { title: `Phantom Summit ${round}` });
      await work(liar.token, [...real, fake], `9.9.${round}.1`);
      await work(honest.token, real, `9.9.${round}.2`);
    }

    const m = await member(liar.userId);
    expect(m!.contradictions).toBeGreaterThanOrEqual(5);
    expect(m!.quarantinedAt).toBeTruthy();
    expect(m!.tier).toBe("probation");

    // Nothing was destroyed — every payload they ever submitted is still readable, which
    // is what makes a human review possible at all.
    const kept = await t.env.DB.prepare("SELECT COUNT(*) AS n FROM scrape_observations WHERE member_id = ?").bind(liar.userId).first();
    expect(kept.n).toBeGreaterThan(10);
    // Their corroborated work stays published, because it was real and two people saw it.
    // Quarantine holds what is UNRESOLVED; it is not a retroactive purge.
    const stillPublished = await t.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM scrape_observations WHERE member_id = ? AND status = 'published'",
    )
      .bind(liar.userId)
      .first();
    expect(stillPublished.n).toBeGreaterThan(0);
    // No phantom ever reached the catalog.
    const titles = await t.env.DB.prepare("SELECT title FROM events").all();
    expect((titles.results as any[]).some((e) => e.title.startsWith("Phantom"))).toBe(false);
    // And they get no more work.
    const after = await call(t, "/api/net/lease", { method: "POST", body: { max: 1 }, headers: { authorization: `Bearer ${liar.token}` } });
    expect(after.status).toBe(403);
  });

  it("shows contributors on the leaderboard, ranked by what they actually found", async () => {
    const ann = await join("ann", "probation");
    const bob = await join("bob", "probation");
    await work(ann.token, [raw(1), raw(2), raw(3)], "1.1.2.1");
    await work(bob.token, [raw(1), raw(2), raw(3)], "1.1.2.2");

    const r = await call(t, "/api/net/leaderboard");
    expect(r.status).toBe(200);
    expect(r.json.board).toHaveLength(2);
    const top = r.json.board[0];
    expect(top.handle).toBe("ann"); // the finder outranks the corroborator
    expect(top.finds).toBe(3);
    expect(top.points).toBeGreaterThan(0);
    expect(top.tier).toBe("probation");
    // Never leak an email onto a public board.
    expect(JSON.stringify(r.json)).not.toContain("@x.com");
  });

  it("reports a member their own standing, including what it would take to level up", async () => {
    const ann = await join("ann", "probation");
    const r = await call(t, "/api/net/me", { cookie: ann.cookie });
    expect(r.status).toBe(200);
    expect(r.json.member.tier).toBe("probation");
    expect(r.json.nextTier).toEqual({ tier: "trusted", ...TIER_RULES.trusted });
  });
});
