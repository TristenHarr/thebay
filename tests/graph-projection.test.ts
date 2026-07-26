/**
 * The projection, attacked.
 *
 * A stale search index is a missed result. A leaky graph PUBLISHES A RELATIONSHIP SOMEBODY
 * REVOKED — it tells a stranger that a `social_enabled = 0` person was at an event, or draws
 * a line to someone who blocked them. So most of this file is privacy, and every privacy test
 * is written as the attack rather than as the happy path.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { GraphProjection } from "../src/storage/d1/graph-projection";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { canSeeUser, ANON_VIEWER, type ViewerCtx } from "../src/core/graph/visibility";

let d1: any, raw: Database.Database, graph: GraphProjection, social: SocialRepo;

const NOW = Date.now();
const AT = new Date(NOW - 3 * 86_400_000).toISOString();

beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  graph = new GraphProjection(d1);
  social = new SocialRepo(d1);
});

/** Social sharing ON by default here — the interesting tests are the ones that turn it off. */
async function mkUser(email: string, socialEnabled = true) {
  const u = await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: email.split("@")[0]! });
  if (socialEnabled) raw.prepare("UPDATE users SET social_enabled = 1 WHERE id = ?").run(u.id);
  return u.id;
}

function mkEvent(id: string, hostId: string | null = null, lat: number | null = 37.78, lng: number | null = -122.4) {
  raw
    .prepare(
      `INSERT INTO events (id,fingerprint,title,start_utc,timezone,city,url,categories,content_hash,host_user_id,latitude,longitude,first_seen_at,last_seen_at)
       VALUES (?,?,?,?,'America/Los_Angeles','sf-bay',?,'[]',?,?,?,?,?,?)`,
    )
    .run(id, `fp-${id}`, `Event ${id}`, AT, `https://x/${id}`, `ch-${id}`, hostId, lat, lng, AT, AT);
}

const checkin = (userId: string, eventId: string, at = AT) =>
  raw.prepare("INSERT INTO checkins (user_id,event_id,at,source) VALUES (?,?,?,'qr')").run(userId, eventId, at);
const rsvp = (userId: string, eventId: string, status = "going") =>
  raw.prepare("INSERT INTO rsvps (user_id,event_id,status,created_at) VALUES (?,?,?,?)").run(userId, eventId, status, AT);

function friendship(a: string, b: string, status = "accepted") {
  const [low, high] = a < b ? [a, b] : [b, a];
  raw
    .prepare("INSERT INTO friendships (user_low,user_high,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(low, high, status, a, AT, AT);
}

const ids = (r: { nodes: Array<{ id: string }> }) => r.nodes.map((n) => n.id).sort();

describe("canSeeUser — the rules, in isolation", () => {
  const ctx = (over: Partial<ViewerCtx> = {}): ViewerCtx => ({ id: "me", banned: false, friends: new Set(), blocked: new Set(), ...over });
  const other = (over: Partial<{ socialEnabled: boolean; bannedAt: string | null }> = {}) => ({
    id: "them",
    socialEnabled: true,
    bannedAt: null,
    ...over,
  });

  it("always shows you yourself, even with sharing off", () => {
    expect(canSeeUser(ctx(), { id: "me", socialEnabled: false, bannedAt: null }, 0)).toBe(true);
  });

  it("hides anyone with social sharing off", () => {
    expect(canSeeUser(ctx(), other({ socialEnabled: false }), 2)).toBe(false);
  });

  it("shows a hop-1 accepted friend even with sharing off — parity with listFriends", () => {
    expect(canSeeUser(ctx({ friends: new Set(["them"]) }), other({ socialEnabled: false }), 1)).toBe(true);
  });

  it("does NOT let that exemption travel past hop 1", () => {
    // Otherwise an opt-out becomes "opted out, unless you know someone who knows me".
    expect(canSeeUser(ctx({ friends: new Set(["them"]) }), other({ socialEnabled: false }), 2)).toBe(false);
  });

  it("makes a block outrank everything, including friendship", () => {
    expect(canSeeUser(ctx({ blocked: new Set(["them"]), friends: new Set(["them"]) }), other(), 1)).toBe(false);
  });

  it("hides a banned subject and blinds a banned viewer", () => {
    expect(canSeeUser(ctx(), other({ bannedAt: AT }), 1)).toBe(false);
    expect(canSeeUser(ctx({ banned: true }), other(), 1)).toBe(false);
  });

  it("shows an anonymous viewer only public people", () => {
    expect(canSeeUser(ANON_VIEWER, other(), 2)).toBe(true);
    expect(canSeeUser(ANON_VIEWER, other({ socialEnabled: false }), 1)).toBe(false);
  });
});

describe("the ego projection", () => {
  it("returns an empty graph for an anonymous or banned viewer", async () => {
    const me = await mkUser("me@x.com");
    expect((await graph.ego({ viewerId: null })).nodes).toEqual([]);
    raw.prepare("UPDATE users SET banned_at = ? WHERE id = ?").run(AT, me);
    expect((await graph.ego({ viewerId: me })).nodes).toEqual([]);
  });

  it("is genuinely multi-entity: events are NODES, not collapsed away", async () => {
    const me = await mkUser("me@x.com");
    const sam = await mkUser("sam@x.com");
    mkEvent("e1");
    checkin(me, "e1");
    checkin(sam, "e1");

    const r = await graph.ego({ viewerId: me, nowMs: NOW });
    expect(ids(r)).toContain("event:e1");
    expect(ids(r)).toContain(`user:${sam}`);
    // Two check-in edges through the hub, NOT one synthetic user↔user edge.
    expect(r.edges.filter((e) => e.kind === "checkin")).toHaveLength(2);
    expect(r.edges.some((e) => e.kind === "co_attended")).toBe(false);
  });

  it("gives every edge at least one evidence record, with a real source row", async () => {
    const me = await mkUser("me@x.com");
    const sam = await mkUser("sam@x.com");
    mkEvent("e1", me);
    checkin(me, "e1");
    rsvp(sam, "e1", "went");
    friendship(me, sam);

    const r = await graph.ego({ viewerId: me, nowMs: NOW });
    expect(r.edges.length).toBeGreaterThan(0);
    for (const e of r.edges) {
      expect(e.evidence.length, `${e.kind} has no evidence`).toBeGreaterThan(0);
      for (const ev of e.evidence) {
        expect(ev.source.table).toBeTruthy();
        expect(Object.keys(ev.source.keys).length).toBeGreaterThan(0);
        // The citation must point at a row that EXISTS. This is what makes "the graph cites
        // its sources" a test rather than a comment.
        const where = Object.keys(ev.source.keys).map((k) => `${k} = ?`).join(" AND ");
        const found = raw.prepare(`SELECT COUNT(*) n FROM ${ev.source.table} WHERE ${where}`).get(...Object.values(ev.source.keys)) as any;
        expect(found.n, `${ev.source.table} ${JSON.stringify(ev.source.keys)} does not exist`).toBeGreaterThan(0);
      }
    }
  });

  it("weights a check-in above an RSVP, and 'went' above 'interested'", async () => {
    const me = await mkUser("me@x.com");
    mkEvent("e1");
    mkEvent("e2");
    mkEvent("e3");
    checkin(me, "e1");
    rsvp(me, "e2", "went");
    rsvp(me, "e3", "interested");

    const r = await graph.ego({ viewerId: me, nowMs: NOW });
    const s = (id: string) => r.edges.find((e) => e.b === `event:${id}`)!.strength;
    expect(s("e1")).toBeGreaterThan(s("e2"));
    expect(s("e2")).toBeGreaterThan(s("e3"));
  });

  it("projects a redeemed invite as the strongest edge there is", async () => {
    const me = await mkUser("me@x.com");
    const sam = await mkUser("sam@x.com");
    raw
      .prepare(
        `INSERT INTO network_invites (id,ambassador_id,lat,lng,step_ms,frames_required,start_step,end_step,expires_at,created_at,redeemed_at,redeemed_by)
         VALUES ('inv1',?,37.78,-122.40,30000,2,0,4,?,?,?,?)`,
      )
      .run(me, AT, AT, AT, sam);

    const r = await graph.ego({ viewerId: me, nowMs: NOW });
    const vouch = r.edges.find((e) => e.kind === "vouched")!;
    expect(vouch).toBeTruthy();
    expect(vouch.evidence[0]!.tier).toBe("attested");
    // It carries the geometry of where the two of them actually stood.
    expect(vouch.evidence[0]!.detail?.lat).toBeCloseTo(37.78, 2);
  });
});

describe("PRIVACY — the attacks", () => {
  it("never reveals a stranger who has social sharing off", async () => {
    const me = await mkUser("me@x.com");
    const shy = await mkUser("shy@x.com", false);
    mkEvent("e1");
    checkin(me, "e1");
    checkin(shy, "e1");

    const r = await graph.ego({ viewerId: me, nowMs: NOW });
    expect(ids(r)).not.toContain(`user:${shy}`);
    // And no dangling edge either — an edge to a hidden node still reveals they were there.
    expect(r.edges.some((e) => e.a === `user:${shy}` || e.b === `user:${shy}`)).toBe(false);
    expect(r.omitted.nodes).toBeGreaterThan(0);
  });

  it("shows my OWN private friend but never exposes them to a third party", async () => {
    const me = await mkUser("me@x.com");
    const shyFriend = await mkUser("shy@x.com", false);
    const stranger = await mkUser("stranger@x.com");
    friendship(me, shyFriend);
    mkEvent("e1");
    checkin(shyFriend, "e1");
    checkin(stranger, "e1");
    checkin(me, "e1");

    // I can see my friend.
    expect(ids(await graph.ego({ viewerId: me, nowMs: NOW }))).toContain(`user:${shyFriend}`);
    // The stranger, at the same event, cannot.
    expect(ids(await graph.ego({ viewerId: stranger, nowMs: NOW }))).not.toContain(`user:${shyFriend}`);
  });

  it("HARD-CUTS a blocked user in both directions, even through a shared event", async () => {
    // Nothing in the codebase enforced this before the projection existed.
    const me = await mkUser("me@x.com");
    const enemy = await mkUser("enemy@x.com");
    friendship(me, enemy, "blocked");
    mkEvent("e1");
    checkin(me, "e1");
    checkin(enemy, "e1");

    expect(ids(await graph.ego({ viewerId: me, nowMs: NOW }))).not.toContain(`user:${enemy}`);
    expect(ids(await graph.ego({ viewerId: enemy, nowMs: NOW }))).not.toContain(`user:${me}`);
  });

  it("does not extend the friend exemption to a friend-of-a-friend", async () => {
    // `far` is my friend; `shy` is my friend with sharing off. From far's point of view shy
    // is two hops away, so the exemption must not reach them — otherwise opting out would
    // mean "opted out, unless you know someone who knows me".
    const me = await mkUser("me@x.com");
    const shy = await mkUser("shy@x.com", false);
    const far = await mkUser("far@x.com");
    friendship(me, shy);
    friendship(me, far);
    // Give them a shared room too, so shy is genuinely reachable at hop 2 rather than merely
    // absent from the query.
    mkEvent("e1");
    checkin(shy, "e1");
    checkin(far, "e1");

    const r = await graph.ego({ viewerId: far, nowMs: NOW });
    expect(ids(r)).not.toContain(`user:${shy}`);
    // …while I, their actual friend, still see them.
    expect(ids(await graph.ego({ viewerId: me, nowMs: NOW }))).toContain(`user:${shy}`);
  });

  it("excludes a hidden event and everything that pointed at it", async () => {
    const me = await mkUser("me@x.com");
    mkEvent("e1");
    checkin(me, "e1");
    raw.prepare("UPDATE events SET hidden = 1 WHERE id = 'e1'").run();

    const r = await graph.ego({ viewerId: me, nowMs: NOW });
    expect(ids(r)).not.toContain("event:e1");
    expect(r.edges.some((e) => e.b === "event:e1")).toBe(false);
  });

  it("excludes a banned user even if we are friends", async () => {
    const me = await mkUser("me@x.com");
    const gone = await mkUser("gone@x.com");
    friendship(me, gone);
    raw.prepare("UPDATE users SET banned_at = ? WHERE id = ?").run(AT, gone);
    expect(ids(await graph.ego({ viewerId: me, nowMs: NOW }))).not.toContain(`user:${gone}`);
  });
});

describe("bounds", () => {
  it("never trips D1's 100-bound-parameter cap, at any realistic size", async () => {
    // The shim THROWS on an unchunked IN(...) — the bug class that passes every small-fixture
    // test and 500s in production. `ShadowsRepo.activeInCells` still has it.
    const me = await mkUser("me@x.com");
    for (let i = 0; i < 250; i++) {
      const f = await mkUser(`f${i}@x.com`);
      friendship(me, f);
    }
    for (let i = 0; i < 150; i++) {
      mkEvent(`e${i}`);
      checkin(me, `e${i}`);
    }
    const r = await graph.ego({ viewerId: me, nowMs: NOW });
    expect(r.nodes.length).toBeGreaterThan(0);
  });

  it("caps nodes and edges, and SAYS how much it dropped", async () => {
    const me = await mkUser("me@x.com");
    for (let i = 0; i < 40; i++) {
      mkEvent(`e${i}`);
      checkin(me, `e${i}`);
      for (let j = 0; j < 12; j++) checkin(await mkUser(`u${i}_${j}@x.com`), `e${i}`);
    }
    const r = await graph.ego({ viewerId: me, maxNodes: 50, maxEdges: 60, nowMs: NOW });
    expect(r.nodes.length).toBeLessThanOrEqual(50);
    expect(r.edges.length).toBeLessThanOrEqual(60);
    // Silent truncation reads as "this is your whole network", which is a lie.
    expect(r.omitted.nodes + r.omitted.edges).toBeGreaterThan(0);
  });

  it("keeps me in the graph and never emits an edge whose endpoint was dropped", async () => {
    const me = await mkUser("me@x.com");
    for (let i = 0; i < 30; i++) {
      mkEvent(`e${i}`);
      checkin(me, `e${i}`);
      for (let j = 0; j < 6; j++) checkin(await mkUser(`u${i}_${j}@x.com`), `e${i}`);
    }
    const r = await graph.ego({ viewerId: me, maxNodes: 20, maxEdges: 200, nowMs: NOW });
    const present = new Set(r.nodes.map((n) => n.id));
    expect(present.has(`user:${me}`)).toBe(true);
    for (const e of r.edges) {
      expect(present.has(e.a), `dangling ${e.a}`).toBe(true);
      expect(present.has(e.b), `dangling ${e.b}`).toBe(true);
    }
  });

  it("honours hops: 1 leaves out the people I merely shared a room with", async () => {
    const me = await mkUser("me@x.com");
    const sam = await mkUser("sam@x.com");
    mkEvent("e1");
    checkin(me, "e1");
    checkin(sam, "e1");

    expect(ids(await graph.ego({ viewerId: me, hops: 1, nowMs: NOW }))).not.toContain(`user:${sam}`);
    expect(ids(await graph.ego({ viewerId: me, hops: 2, nowMs: NOW }))).toContain(`user:${sam}`);
  });
});

describe("collapse", () => {
  it("synthesises co_attended and ALWAYS names the event it came from", async () => {
    const me = await mkUser("me@x.com");
    const sam = await mkUser("sam@x.com");
    mkEvent("e1");
    checkin(me, "e1");
    checkin(sam, "e1");

    const r = await graph.ego({ viewerId: me, collapse: true, nowMs: NOW });
    const co = r.edges.filter((e) => e.kind === "co_attended");
    expect(co.length).toBeGreaterThan(0);
    for (const e of co) {
      // Without `via` this edge has degenerated into "you two are similar", which is the
      // claim the whole feature exists to replace.
      expect(e.evidence[0]!.via, "a collapsed edge with no via is a bug").toBeTruthy();
      expect(e.evidence[0]!.via!.label).toBe("Event e1");
    }
  });

  it("collapsing is opt-in — the default keeps the event visible as the hub", async () => {
    const me = await mkUser("me@x.com");
    const sam = await mkUser("sam@x.com");
    mkEvent("e1");
    checkin(me, "e1");
    checkin(sam, "e1");
    const r = await graph.ego({ viewerId: me, nowMs: NOW });
    expect(r.edges.some((e) => e.kind === "co_attended")).toBe(false);
  });
});

describe("scalability — the bugs that pass a small fixture and die in production", () => {
  it("BOUNDS the O(k²) collapse — asserted on the pair count, not on the truncated output", async () => {
    // The first version of this test checked `edges.length <= 400` and passed with the bound
    // REMOVED, because the output cap trims to 400 either way. It proved nothing. The bound is
    // only observable before truncation, so the collapse is exercised directly.
    const { collapseThroughEvents, MAX_COLLAPSE_GROUP } = await import("../src/storage/d1/graph-projection");
    const { evidenceOf } = await import("../src/core/graph/evidence");

    const K = 300;
    const nodes = new Map<string, any>([["event:big", { id: "event:big", type: "event", label: "Big" }]]);
    const edges = Array.from({ length: K }, (_, i) => ({
      a: `user:u${i}`,
      b: "event:big",
      kind: "checkin" as const,
      directed: true,
      strength: 1 - i / (K * 2),
      evidence: [evidenceOf("attested", "checkins", { user_id: `u${i}`, event_id: "big" }, AT)],
    }));

    const out = collapseThroughEvents(edges, nodes, NOW);
    const pairs = out.filter((e) => e.kind === "co_attended").length;
    const bounded = (MAX_COLLAPSE_GROUP * (MAX_COLLAPSE_GROUP - 1)) / 2;
    expect(pairs, "must pair the capped group, not all 300").toBe(bounded);
    // Unbounded this would be 44,850 objects allocated to keep at most 400.
    expect(pairs).toBeLessThan((K * (K - 1)) / 2 / 10);
    for (const e of out.filter((x) => x.kind === "co_attended")) expect(e.evidence[0]!.via).toBeTruthy();
  });

  it("keeps the STRONGEST attendees when it caps a group, not an arbitrary slice", async () => {
    const { collapseThroughEvents, MAX_COLLAPSE_GROUP } = await import("../src/storage/d1/graph-projection");
    const { evidenceOf } = await import("../src/core/graph/evidence");
    const nodes = new Map<string, any>([["event:big", { id: "event:big", type: "event", label: "Big" }]]);
    // Weakest first, so a naive `slice(0, N)` would keep exactly the wrong people.
    const edges = Array.from({ length: 100 }, (_, i) => ({
      a: `user:u${i}`,
      b: "event:big",
      kind: "checkin" as const,
      directed: true,
      strength: i / 100,
      evidence: [evidenceOf("attested", "checkins", { user_id: `u${i}`, event_id: "big" }, AT)],
    }));
    const out = collapseThroughEvents(edges, nodes, NOW).filter((e) => e.kind === "co_attended");
    const kept = new Set(out.flatMap((e) => [e.a, e.b]));
    expect(kept.size).toBe(MAX_COLLAPSE_GROUP);
    expect(kept.has("user:u99"), "the strongest attendee must survive").toBe(true);
    expect(kept.has("user:u0"), "the weakest must not").toBe(false);
  });

  it("REPORTS that a graph is a sample when a fetch hit its ceiling", async () => {
    // `capped` is the observable difference the LIMIT makes: without it the fetch never fills
    // a page, so this flag stays false and the UI would present a sample as the whole room.
    const { MAX_HOP2_ROWS } = await import("../src/storage/d1/graph-projection");
    const me = await mkUser("me@x.com");
    mkEvent("big");
    checkin(me, "big");
    for (let i = 0; i < MAX_HOP2_ROWS + 50; i++) checkin(await mkUser(`a${i}@x.com`), "big");

    const r = await graph.ego({ viewerId: me, nowMs: NOW });
    expect(r.omitted.capped, "a full page means there was more we did not fetch").toBe(true);
    expect(r.nodes.length).toBeLessThanOrEqual(300);
  });

  it("does not claim to be capped for a graph that genuinely fit", async () => {
    const me = await mkUser("me@x.com");
    mkEvent("e1");
    checkin(me, "e1");
    for (let i = 0; i < 5; i++) checkin(await mkUser(`b${i}@x.com`), "e1");
    expect((await graph.ego({ viewerId: me, nowMs: NOW })).omitted.capped).toBe(false);
  });
});
