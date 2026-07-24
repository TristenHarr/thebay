import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { SocialRepo } from "../src/storage/d1/social-repo";

let d1: any;
let raw: Database.Database;
let repo: SocialRepo;

beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  repo = new SocialRepo(d1);
});

/** Insert a minimal valid event row directly (bypassing the scraper pipeline). */
function insertEvent(id: string, startUtc: string, title = "Test Event") {
  raw
    .prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'sf-bay', 'https://x', ?, '2026-01-01', '2026-01-01')`,
    )
    .run(id, "fp-" + id, title, startUtc, "ch-" + id);
}
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const past = new Date(Date.now() - 7 * 86400000).toISOString();

async function mkUser(email: string, name: string, social = true) {
  const u = await repo.upsertByIdentity({ provider: "google", providerUid: "g-" + email, email, displayName: name });
  if (social) await repo.updateProfile(u.id, { socialEnabled: true });
  return (await repo.getUserById(u.id))!;
}

describe("identity", () => {
  it("creates a user on first identity login", async () => {
    const u = await repo.upsertByIdentity({ provider: "google", providerUid: "g1", email: "a@x.com", displayName: "Ann" });
    expect(u.email).toBe("a@x.com");
    expect(u.handle).toMatch(/^[a-z0-9_]{3,20}$/);
    expect(u.socialEnabled).toBe(false); // opt-in
  });

  it("returns the SAME user for a repeat identity (no duplicate)", async () => {
    const a = await repo.upsertByIdentity({ provider: "google", providerUid: "g1", email: "a@x.com", displayName: "Ann" });
    const b = await repo.upsertByIdentity({ provider: "google", providerUid: "g1", email: "a@x.com", displayName: "Ann" });
    expect(b.id).toBe(a.id);
    expect(raw.prepare("SELECT COUNT(*) n FROM users").get() as any).toEqual({ n: 1 });
  });

  it("links a second provider with the same email to one user", async () => {
    const a = await repo.upsertByIdentity({ provider: "google", providerUid: "g1", email: "a@x.com", displayName: "Ann" });
    const b = await repo.upsertByIdentity({ provider: "github", providerUid: "h1", email: "a@x.com", displayName: "Ann" });
    expect(b.id).toBe(a.id);
    expect((raw.prepare("SELECT COUNT(*) n FROM identities").get() as any).n).toBe(2);
    expect((raw.prepare("SELECT COUNT(*) n FROM users").get() as any).n).toBe(1);
  });

  it("gives colliding handle-seeds distinct handles", async () => {
    const a = await repo.upsertByIdentity({ provider: "google", providerUid: "g1", email: "sam@a.com", displayName: "Sam" });
    const b = await repo.upsertByIdentity({ provider: "google", providerUid: "g2", email: "sam@b.com", displayName: "Sam" });
    expect(a.handle).not.toBe(b.handle);
  });
});

describe("profile", () => {
  it("updates fields and toggles social", async () => {
    const u = await mkUser("a@x.com", "Ann", false);
    const up = await repo.updateProfile(u.id, { displayName: "Annie", bio: "hi", socialEnabled: true, handle: "annie" });
    expect(up?.displayName).toBe("Annie");
    expect(up?.handle).toBe("annie");
    expect(up?.socialEnabled).toBe(true);
    expect(await repo.getUserByHandle("annie")).toBeTruthy();
  });
});

describe("rsvp + points", () => {
  it("sets/clears rsvp and awards rsvp points once (idempotent)", async () => {
    const u = await mkUser("a@x.com", "Ann");
    insertEvent("e1", future);
    await repo.setRsvp(u.id, "e1", "going");
    expect(await repo.getRsvp(u.id, "e1")).toBe("going");
    await repo.setRsvp(u.id, "e1", "going"); // repeat must NOT double-award
    expect(await repo.myPoints(u.id)).toBe(5);
    await repo.setRsvp(u.id, "e1", "none");
    expect(await repo.getRsvp(u.id, "e1")).toBe("none");
  });

  it("lists only social + going/went attendees", async () => {
    const a = await mkUser("a@x.com", "Ann");
    const b = await mkUser("b@x.com", "Bob");
    const c = await mkUser("c@x.com", "Cid", false); // private
    insertEvent("e1", future);
    await repo.setRsvp(a.id, "e1", "going");
    await repo.setRsvp(b.id, "e1", "interested"); // not counted
    await repo.setRsvp(c.id, "e1", "going"); // private, not shown
    const list = await repo.attendees("e1");
    expect(list.map((p) => p.displayName)).toEqual(["Ann"]);
  });
});

describe("friendships", () => {
  it("normalizes A↔B to one row and dedupes reverse requests", async () => {
    const a = await mkUser("a@x.com", "Ann");
    const b = await mkUser("b@x.com", "Bob");
    await repo.requestFriend(a.id, b.id);
    await repo.requestFriend(b.id, a.id); // reverse — must not create a 2nd row
    expect((raw.prepare("SELECT COUNT(*) n FROM friendships").get() as any).n).toBe(1);
    const st = await repo.friendStatus(b.id, a.id);
    expect(st).toEqual({ status: "pending", incoming: true }); // b sees a's request
  });

  it("requester cannot accept their own request; addressee can", async () => {
    const a = await mkUser("a@x.com", "Ann");
    const b = await mkUser("b@x.com", "Bob");
    await repo.requestFriend(a.id, b.id);
    await repo.respondFriend(a.id, b.id, true); // requester tries — no-op
    expect((await repo.friendStatus(a.id, b.id))?.status).toBe("pending");
    await repo.respondFriend(b.id, a.id, true); // addressee accepts
    expect((await repo.friendStatus(a.id, b.id))?.status).toBe("accepted");
    expect((await repo.listFriends(a.id)).map((f) => f.displayName)).toEqual(["Bob"]);
    expect((await repo.listFriends(b.id)).map((f) => f.displayName)).toEqual(["Ann"]);
  });

  it("surfaces pending requests to the addressee only", async () => {
    const a = await mkUser("a@x.com", "Ann");
    const b = await mkUser("b@x.com", "Bob");
    await repo.requestFriend(a.id, b.id);
    expect((await repo.pendingRequests(b.id)).map((p) => p.displayName)).toEqual(["Ann"]);
    expect(await repo.pendingRequests(a.id)).toEqual([]);
  });

  it("shows friends attending an event", async () => {
    const a = await mkUser("a@x.com", "Ann");
    const b = await mkUser("b@x.com", "Bob");
    await repo.requestFriend(a.id, b.id);
    await repo.respondFriend(b.id, a.id, true);
    insertEvent("e1", future);
    await repo.setRsvp(b.id, "e1", "going");
    const fa = await repo.friendsAttending(a.id, "e1");
    expect(fa.map((p) => p.displayName)).toEqual(["Bob"]);
    const fe = await repo.friendEventIds(a.id);
    expect(fe).toEqual([{ eventId: "e1", friends: [expect.objectContaining({ displayName: "Bob" })] }]);
  });
});

describe("reviews (attendee-gated)", () => {
  it("gates by attendance", async () => {
    const u = await mkUser("a@x.com", "Ann");
    insertEvent("past", past);
    insertEvent("future", future);
    expect(await repo.canReview(u.id, "past")).toBe(false); // no rsvp
    await repo.setRsvp(u.id, "future", "going");
    expect(await repo.canReview(u.id, "future")).toBe(false); // going but not yet happened
    await repo.setRsvp(u.id, "past", "going");
    expect(await repo.canReview(u.id, "past")).toBe(true); // going + already happened
    await repo.setRsvp(u.id, "future", "went");
    expect(await repo.canReview(u.id, "future")).toBe(true); // explicit 'went'
  });

  it("enforces rating 1..5 and one review per user, awards points once", async () => {
    const u = await mkUser("a@x.com", "Ann");
    insertEvent("e1", past);
    await repo.setRsvp(u.id, "e1", "went");
    await expect(repo.addReview(u.id, "e1", 6, "nope")).rejects.toThrow(); // CHECK
    await repo.addReview(u.id, "e1", 5, "great");
    await repo.addReview(u.id, "e1", 4, "updated"); // upsert, not a 2nd row
    expect((raw.prepare("SELECT COUNT(*) n FROM reviews").get() as any).n).toBe(1);
    const rv = await repo.reviews("e1");
    expect(rv[0]!).toMatchObject({ rating: 4, author: "Ann" });
    // rsvp(5, from 'went' award) + review(10), review awarded once despite two calls
    expect(await repo.myPoints(u.id)).toBe(15);
  });
});

describe("hosting", () => {
  it("creates a hosted event owned by the user and awards host points", async () => {
    const u = await mkUser("a@x.com", "Ann");
    const id = await repo.createHostedEvent(u.id, { title: "My Meetup", startUtc: future, categories: ["software"] });
    const row = raw.prepare("SELECT * FROM events WHERE id = ?").get(id) as any;
    expect(row.host_user_id).toBe(u.id);
    expect(row.title).toBe("My Meetup");
    expect((await repo.eventHost(id))?.displayName).toBe("Ann");
    expect(await repo.myPoints(u.id)).toBe(50);
  });
});

describe("groups + messages", () => {
  it("creates a group with the creator as admin member and stores messages", async () => {
    const a = await mkUser("a@x.com", "Ann");
    const b = await mkUser("b@x.com", "Bob");
    const g = await repo.createGroup(a.id, "SF Trip");
    expect(await repo.isMember(a.id, g)).toBe(true);
    expect(await repo.isMember(b.id, g)).toBe(false);
    await repo.joinGroup(b.id, g);
    expect((await repo.groupMembers(g)).length).toBe(2);
    await repo.addMessage(g, a.id, "hey");
    await repo.addMessage(g, b.id, "yo");
    const msgs = await repo.recentMessages(g);
    expect(msgs.map((m) => m.body)).toEqual(["hey", "yo"]); // chronological
    expect(msgs[0]!.author).toBe("Ann");
    expect((await repo.myGroups(a.id))[0]).toMatchObject({ name: "SF Trip", members: 2 });
  });
});

describe("photos + leaderboard", () => {
  it("adds photos (each awards points) and ranks the leaderboard", async () => {
    const a = await mkUser("a@x.com", "Ann");
    const b = await mkUser("b@x.com", "Bob");
    insertEvent("e1", past);
    await repo.addPhoto(a.id, "e1", "photos/1.jpg", "nice");
    await repo.addPhoto(a.id, "e1", "photos/2.jpg");
    expect((await repo.photos("e1")).length).toBe(2);
    // Photo points are idempotent per event (anti-farming): 2 photos to one event = 15 once.
    expect(await repo.myPoints(a.id)).toBe(15);

    await repo.setRsvp(b.id, "e1", "going"); // 5
    const board = await repo.leaderboard();
    expect(board.map((r) => r.displayName)).toEqual(["Ann", "Bob"]);
    expect(board[0]!.points).toBe(15);
  });

  it("points ledger dedup_key makes awards idempotent", async () => {
    const a = await mkUser("a@x.com", "Ann");
    insertEvent("e1", past);
    await repo.awardPoints(a.id, "checkin", "checkin:a:e1", "e1");
    await repo.awardPoints(a.id, "checkin", "checkin:a:e1", "e1"); // same key — ignored
    expect(await repo.myPoints(a.id)).toBe(20);
  });
});
