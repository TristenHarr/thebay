import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { GraphRepo } from "../src/storage/d1/graph-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";

let d1: any;
let raw: Database.Database;
let graph: GraphRepo;
let social: SocialRepo;

beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  graph = new GraphRepo(d1);
  social = new SocialRepo(d1);
});

async function mkUser(email: string, name: string) {
  const u = await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: name });
  await social.updateProfile(u.id, { socialEnabled: true });
  return (await social.getUserById(u.id))!;
}
async function befriend(a: string, b: string) {
  await social.requestFriend(a, b);
  await social.respondFriend(b, a, true);
}
function insertEvent(id: string, startUtc = "2026-06-01T18:00:00Z") {
  raw
    .prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'sf-bay', 'https://x', ?, '2026-01-01', '2026-01-01')`,
    )
    .run(id, "fp-" + id, "Event " + id, startUtc, "ch-" + id);
}

describe("warm intros", () => {
  it("connector inbox surfaces requests they can help with; accepting connects + credits the connector", async () => {
    const ann = await mkUser("a@x.com", "Ann"); // requester
    const cid = await mkUser("c@x.com", "Cid"); // connector
    const viv = await mkUser("v@x.com", "Viv"); // target
    await befriend(ann.id, cid.id); // Ann knows Cid
    await befriend(cid.id, viv.id); // Cid knows Viv

    const reqId = await graph.createIntroRequest(ann.id, { targetDesc: "Viv", targetUserId: viv.id });

    // Cid (mutual with target) sees it; Ann/Viv don't get an inbox item for it
    expect((await graph.connectorInbox(cid.id)).map((r) => r.request.id)).toEqual([reqId]);
    expect(await graph.connectorInbox(ann.id)).toEqual([]);

    const fwd = await graph.forwardIntro(cid.id, reqId); // Cid forwards
    expect(fwd).toBeTruthy();
    expect(await graph.acceptIntro(viv.id, fwd!)).toBe("connected"); // Viv accepts

    // Ann & Viv are now friends; request matched; Cid credited
    expect((await social.friendStatus(ann.id, viv.id))?.status).toBe("accepted");
    expect(await graph.introsMade(cid.id)).toBe(1);
    expect(await social.myPoints(cid.id)).toBe(25); // intro points to the connector
    expect((await graph.myIntroRequests(ann.id))[0]?.status).toBe("matched");
  });

  it("only the target can accept an intro", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const cid = await mkUser("c@x.com", "Cid");
    const viv = await mkUser("v@x.com", "Viv");
    await befriend(ann.id, cid.id);
    await befriend(cid.id, viv.id);
    const reqId = await graph.createIntroRequest(ann.id, { targetDesc: "Viv", targetUserId: viv.id });
    const fwd = await graph.forwardIntro(cid.id, reqId);
    expect(await graph.acceptIntro(ann.id, fwd!)).toBe("forbidden"); // requester can't self-accept
  });
});

describe("mentors", () => {
  it("lists active mentors and runs the request lifecycle", async () => {
    const mentee = await mkUser("m@x.com", "Mentee");
    const mentor = await mkUser("g@x.com", "Guru");
    await graph.setMentorProfile(mentor.id, { topics: ["fundraising", "gtm"], blurb: "ask me anything" });
    expect((await graph.listMentors()).map((m) => m.displayName)).toContain("Guru");
    expect((await graph.listMentors("fundraising")).length).toBe(1);
    expect((await graph.listMentors("nonexistent")).length).toBe(0);

    const rid = await graph.requestMentor(mentee.id, mentor.id, "help with seed");
    expect((await graph.mentorInbox(mentor.id)).length).toBe(1);
    await graph.respondMentorRequest(mentor.id, rid, true);
    expect((await social.friendStatus(mentee.id, mentor.id))?.status).toBe("accepted"); // connected on accept
  });
});

describe("matching", () => {
  it("shows a filtered deck and pairs on mutual invite", async () => {
    const a = await mkUser("a@x.com", "Ann");
    const b = await mkUser("b@x.com", "Bob");
    const c = await mkUser("c@x.com", "Cid");
    for (const u of [a, b, c]) await graph.setMatchPrefs(u.id, { looking: true, technical: true });

    const deck = await graph.deck(a.id);
    expect(deck.map((d) => d.id).sort()).toEqual([b.id, c.id].sort()); // everyone looking except me
    expect(await graph.act(a.id, b.id, "invite")).toEqual({ matched: false }); // one-sided
    expect(await graph.act(b.id, a.id, "invite")).toEqual({ matched: true }); // mutual ⇒ match
    expect((await social.friendStatus(a.id, b.id))?.status).toBe("accepted");
    // acted-on users leave the deck
    expect((await graph.deck(a.id)).map((d) => d.id)).toEqual([c.id]);
  });
});

describe("network graph", () => {
  it("returns the ego network — you + friends + the edges among them", async () => {
    const me = await mkUser("me@x.com", "Me");
    const bob = await mkUser("b@x.com", "Bob");
    const cid = await mkUser("c@x.com", "Cid");
    const zed = await mkUser("z@x.com", "Zed"); // not a friend — must be excluded
    await befriend(me.id, bob.id);
    await befriend(me.id, cid.id);
    await befriend(bob.id, cid.id); // a friend-of-friend edge inside my set
    await befriend(bob.id, zed.id); // edge to an outsider — must NOT appear

    const g = await graph.networkGraph(me.id);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["Bob", "Cid", "Me"]);
    expect(g.nodes.find((n) => n.name === "Me")!.me).toBe(true);
    // 3 edges among {me,bob,cid}; the bob–zed edge is excluded
    expect(g.edges.length).toBe(3);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.every((e) => ids.has(e.a) && ids.has(e.b))).toBe(true);
    expect(ids.has(zed.id)).toBe(false);
  });

  it("a lone user graphs as just themselves with no edges", async () => {
    const solo = await mkUser("s@x.com", "Solo");
    const g = await graph.networkGraph(solo.id);
    expect(g.nodes.length).toBe(1);
    expect(g.edges.length).toBe(0);
  });
});

describe("AI-feeder graph queries", () => {
  // Scenario: friendships me–cid, ann–cid, me–bob. Events E1{me,ann,bob}, E2{me,ann}.
  async function scenario() {
    const me = await mkUser("me@x.com", "Me");
    const ann = await mkUser("ann@x.com", "Ann");
    const bob = await mkUser("bob@x.com", "Bob");
    const cid = await mkUser("cid@x.com", "Cid");
    await befriend(me.id, cid.id);
    await befriend(ann.id, cid.id);
    await befriend(me.id, bob.id);
    insertEvent("e1"); insertEvent("e2");
    for (const u of [me, ann, bob]) await social.setRsvp(u.id, "e1", "going");
    for (const u of [me, ann]) await social.setRsvp(u.id, "e2", "going");
    return { me, ann, bob, cid };
  }

  it("networkCandidates ranks non-friend co-attendees with correct shared-event & mutual counts", async () => {
    const { me } = await scenario();
    const cands = await graph.networkCandidates(me.id);
    // bob excluded (already my friend); cid excluded (not at my events); only Ann remains
    expect(cands.map((c) => c.displayName)).toEqual(["Ann"]);
    expect(cands[0]).toMatchObject({ sharedEvents: 2, mutuals: 1 }); // E1+E2 shared; Cid is the mutual
  });

  it("eventResearchAttendees flags friends and counts mutuals per attendee", async () => {
    const { me } = await scenario();
    const att = await graph.eventResearchAttendees(me.id, "e1");
    const byName = Object.fromEntries(att.map((a) => [a.displayName, a]));
    expect(Object.keys(byName).sort()).toEqual(["Ann", "Bob"]); // excludes me
    expect(byName.Ann).toMatchObject({ isFriend: false, mutuals: 1 }); // mutual = Cid
    expect(byName.Bob).toMatchObject({ isFriend: true, mutuals: 0 }); // my direct friend, no mutuals
  });

  it("returns empty structures cleanly when there's nothing to work with", async () => {
    const solo = await mkUser("solo@x.com", "Solo");
    insertEvent("z1");
    expect(await graph.networkCandidates(solo.id)).toEqual([]);
    expect(await graph.eventResearchAttendees(solo.id, "z1")).toEqual([]);
  });
});

describe("communities + rankings", () => {
  it("creates a community with the creator as member and ranks members by intros then points", async () => {
    const a = await mkUser("a@x.com", "Ann");
    const b = await mkUser("b@x.com", "Bob");
    const com = await graph.createCommunity(a.id, "AI Infra");
    await graph.joinCommunity(b.id, com);
    expect((await graph.communityMembers(com)).length).toBe(2);
    expect((await graph.myCommunities(a.id))[0]?.name).toBe("AI Infra");

    // give Ann an intro credit → she should out-rank Bob. Ann must be a genuine
    // connector: friends with BOTH the requester (Bob) and the target (Viv).
    const viv = await mkUser("v@x.com", "Viv");
    const req = await graph.createIntroRequest(b.id, { targetDesc: "Viv", targetUserId: viv.id });
    await befriend(b.id, a.id);   // Ann ↔ Bob (requester)
    await befriend(a.id, viv.id); // Ann ↔ Viv (target)
    const fwd = await graph.forwardIntro(a.id, req); // Ann is an eligible connector
    expect(fwd).toBeTruthy();
    await graph.acceptIntro(viv.id, fwd!);

    const ranks = await graph.rankings("intros");
    expect(ranks[0]?.displayName).toBe("Ann"); // 1 intro made
    expect(ranks[0]?.intros).toBe(1);
  });

  it("community rankings include only members, exclude outsiders, and honor the metric", async () => {
    const a = await mkUser("a@x.com", "Ann");
    const b = await mkUser("b@x.com", "Bob");
    const outsider = await mkUser("o@x.com", "Outsider"); // never joins the community
    const com = await graph.createCommunity(a.id, "AI Infra");
    await graph.joinCommunity(b.id, com);

    // Give the OUTSIDER a huge point total — they must still be absent from the
    // community board because they aren't a member.
    raw.prepare(`INSERT INTO points_ledger (id, user_id, kind, points, dedup_key, created_at) VALUES ('p-out', ?, 'seed', 9999, 'dk-out', '2026-01-01')`).run(outsider.id);
    // Bob out-points Ann inside the community.
    raw.prepare(`INSERT INTO points_ledger (id, user_id, kind, points, dedup_key, created_at) VALUES ('p-bob', ?, 'seed', 10, 'dk-bob', '2026-01-01')`).run(b.id);

    const board = await graph.communityRankings(com, "points");
    expect(board.map((r) => r.displayName).sort()).toEqual(["Ann", "Bob"]); // outsider excluded
    expect(board.find((r) => r.displayName === "Outsider")).toBeUndefined();
    expect(board[0]?.displayName).toBe("Bob"); // highest points among members first
    expect(board[0]?.points).toBe(10);
  });
});

describe("NPS in rankings", () => {
  it("computes host NPS from event review ratings (promoters − detractors)", async () => {
    const host = await mkUser("host@x.com", "Host");
    const r1 = await mkUser("r1@x.com", "R1");
    const r2 = await mkUser("r2@x.com", "R2");
    const r3 = await mkUser("r3@x.com", "R3");
    // Host runs one event; three reviews: 5 (promoter), 5 (promoter), 2 (detractor)
    raw.prepare(`INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at, host_user_id)
                 VALUES ('e1','fp1','Host Event','2026-06-01T18:00:00Z','America/Los_Angeles','sf-bay','https://x','ch1','2026-01-01','2026-01-01', ?)`).run(host.id);
    const rev = (u: string, rating: number) => raw.prepare(`INSERT INTO reviews (id, event_id, user_id, rating, body, created_at) VALUES (?,?,?,?,?,?)`).run("rv-" + u, "e1", u, rating, "", "2026-06-02");
    rev(r1.id, 5); rev(r2.id, 5); rev(r3.id, 2);

    const rows = await graph.rankings("nps");
    // NPS = (2 promoters − 1 detractor) / 3 * 100 = round(33.3) = 33
    expect(rows.find((r) => r.id === host.id)!.nps).toBe(33);
    // a user who hosted nothing has null NPS
    expect(rows.find((r) => r.id === r1.id)!.nps).toBeNull();
  });
});

describe("match actions: save / skip / hide", () => {
  it("each removes the target from the deck and none create a friendship (only mutual invite connects)", async () => {
    const me = await mkUser("me@x.com", "Me");
    const s = await mkUser("s@x.com", "Saved");
    const k = await mkUser("k@x.com", "Skipped");
    const h = await mkUser("h@x.com", "Hidden");
    for (const u of [me, s, k, h]) await graph.setMatchPrefs(u.id, { looking: true });

    expect((await graph.deck(me.id)).length).toBe(3);
    expect(await graph.act(me.id, s.id, "save")).toEqual({ matched: false });
    expect(await graph.act(me.id, k.id, "skip")).toEqual({ matched: false });
    expect(await graph.act(me.id, h.id, "hide")).toEqual({ matched: false });

    // all three leave my deck…
    expect((await graph.deck(me.id)).length).toBe(0);
    // …and none of them became friends
    for (const u of [s, k, h]) expect(await social.friendStatus(me.id, u.id)).toBeNull();
  });

  it("a one-sided invite does not connect; only the reciprocal invite matches", async () => {
    const a = await mkUser("a@x.com", "Ann");
    const b = await mkUser("b@x.com", "Bob");
    for (const u of [a, b]) await graph.setMatchPrefs(u.id, { looking: true });
    expect(await graph.act(a.id, b.id, "invite")).toEqual({ matched: false });
    expect(await social.friendStatus(a.id, b.id)).toBeNull(); // not connected yet
    expect(await graph.act(b.id, a.id, "invite")).toEqual({ matched: true });
    expect((await social.friendStatus(a.id, b.id))?.status).toBe("accepted");
  });
});
