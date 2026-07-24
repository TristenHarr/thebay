import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { PlatformRepo } from "../src/storage/d1/platform-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";

let d1: any;
let raw: Database.Database;
let repo: PlatformRepo;
let social: SocialRepo;

beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  repo = new PlatformRepo(d1);
  social = new SocialRepo(d1);
});

function insertEvent(id: string, startUtc: string, title = "Event") {
  raw
    .prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'sf-bay', 'https://x', ?, '2026-01-01', '2026-01-01')`,
    )
    .run(id, "fp-" + id, title, startUtc, "ch-" + id);
}
async function mkUser(email: string, name: string) {
  return social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: name });
}
const past = new Date(Date.now() - 3 * 86400000).toISOString();

describe("goals", () => {
  it("creates overall + per-event goals and enforces event goals need an event", async () => {
    const u = await mkUser("a@x.com", "Ann");
    insertEvent("e1", past);
    const g1 = await repo.createGoal(u.id, { kind: "overall", title: "Raise a seed round", visibility: "public" });
    const g2 = await repo.createGoal(u.id, { kind: "event", eventId: "e1", title: "Meet 3 fintech founders" });
    expect(g1 && g2).toBeTruthy();
    // event goal without an event id is rejected by the schema CHECK
    await expect(repo.createGoal(u.id, { kind: "event", title: "bad" } as any)).rejects.toThrow();
    const list = await repo.listGoals(u.id);
    expect(list.map((g) => g.title).sort()).toEqual(["Meet 3 fintech founders", "Raise a seed round"]);
  });

  it("updates status and filters public goals by visibility", async () => {
    const u = await mkUser("a@x.com", "Ann");
    const g = await repo.createGoal(u.id, { kind: "overall", title: "Public goal", visibility: "public" });
    await repo.createGoal(u.id, { kind: "overall", title: "Secret goal", visibility: "private" });
    await repo.updateGoal(u.id, g, { status: "done", progress: 100 });
    expect((await repo.publicGoals(u.id)).map((x) => x.title)).toEqual(["Public goal"]);
    expect((await repo.listGoals(u.id)).find((x) => x.id === g)?.status).toBe("done");
  });
});

describe("QR check-in", () => {
  it("checks in with a valid token, awards points once, is idempotent", async () => {
    const u = await mkUser("a@x.com", "Ann");
    insertEvent("e1", past);
    const token = await repo.createCheckinToken("e1");
    expect(await repo.checkIn(u.id, "e1", token)).toBe("ok");
    expect(await repo.checkIn(u.id, "e1", token)).toBe("already"); // idempotent
    expect(await social.myPoints(u.id)).toBe(20); // checkin points once
  });

  it("rejects invalid + expired tokens (no check-in)", async () => {
    const u = await mkUser("a@x.com", "Ann");
    insertEvent("e1", past);
    expect(await repo.checkIn(u.id, "e1", "nope")).toBe("invalid");
    const expired = await repo.createCheckinToken("e1", -1000); // already expired
    expect(await repo.checkIn(u.id, "e1", expired)).toBe("expired");
    expect(await social.myPoints(u.id)).toBe(0);
  });

  it("rejects a token issued for a different event", async () => {
    const u = await mkUser("a@x.com", "Ann");
    insertEvent("e1", past);
    insertEvent("e2", past);
    const token = await repo.createCheckinToken("e2");
    expect(await repo.checkIn(u.id, "e1", token)).toBe("invalid");
  });
});

describe("review-gate", () => {
  it("check-in opens an obligation that blocks new RSVPs until you review", async () => {
    const u = await mkUser("a@x.com", "Ann");
    insertEvent("e1", past);
    const token = await repo.createCheckinToken("e1");
    await repo.checkIn(u.id, "e1", token);
    // obligation now open → gate is closed
    expect(await repo.openObligations(u.id)).toEqual(["e1"]);
    expect(await repo.canRsvp(u.id)).toBe(false);
    // reviewing the attended event satisfies the obligation
    await repo.reviewEvent(u.id, "e1", 5, "great room");
    expect(await repo.openObligations(u.id)).toEqual([]);
    expect(await repo.canRsvp(u.id)).toBe(true);
  });

  it("reviewEvent awards review points + first-review achievement, once", async () => {
    const u = await mkUser("a@x.com", "Ann");
    insertEvent("e1", past);
    await repo.checkIn(u.id, "e1", await repo.createCheckinToken("e1"));
    await repo.reviewEvent(u.id, "e1", 4, "good");
    await repo.reviewEvent(u.id, "e1", 3, "changed my mind"); // upsert, not a new award
    expect(await social.myPoints(u.id)).toBe(20 + 10); // checkin + one review
    expect((raw.prepare("SELECT COUNT(*) n FROM achievements WHERE kind='first_review'").get() as any).n).toBe(1);
    expect((raw.prepare("SELECT COUNT(*) n FROM reviews").get() as any).n).toBe(1);
  });
});

describe("attend streak", () => {
  it("increments within the weekly window and resets after a gap; tracks best", async () => {
    const u = await mkUser("a@x.com", "Ann");
    insertEvent("e1", past); insertEvent("e2", past); insertEvent("e3", past);
    const t0 = Date.parse("2026-06-01T18:00:00Z");
    await repo.checkIn(u.id, "e1", await repo.createCheckinToken("e1"), t0);
    await repo.checkIn(u.id, "e2", await repo.createCheckinToken("e2"), t0 + 6 * 86400000); // within 8d → 2
    expect((await repo.getStreak(u.id, "attend"))).toMatchObject({ count: 2, best: 2 });
    await repo.checkIn(u.id, "e3", await repo.createCheckinToken("e3"), t0 + 30 * 86400000); // gap → reset to 1
    expect((await repo.getStreak(u.id, "attend"))).toMatchObject({ count: 1, best: 2 });
  });
});

describe("achievements & points readouts", () => {
  it("summarizes achievements, streaks and the points breakdown behind a profile", async () => {
    const u = await mkUser("a@x.com", "Ann");
    insertEvent("e1", past);
    // check in (checkin points + attend streak) then satisfy the review-gate (review points + first_review trophy)
    await repo.checkIn(u.id, "e1", await repo.createCheckinToken("e1"), Date.parse("2026-06-01T18:00:00Z"));
    await repo.reviewEvent(u.id, "e1", 5, "great");

    const ach = await repo.listAchievements(u.id);
    expect(ach.map((a) => a.kind)).toContain("first_review");
    expect(ach[0]!.awardedAt).toBeTruthy();

    const streaks = await repo.listStreaks(u.id);
    expect(streaks.find((s) => s.kind === "attend")).toMatchObject({ count: 1, best: 1 });

    const pts = await repo.pointsBreakdown(u.id);
    const byKind = Object.fromEntries(pts.map((p) => [p.kind, p.points]));
    expect(byKind.checkin).toBe(20);
    expect(byKind.review).toBe(10);
    expect(pts.reduce((s, p) => s + p.points, 0)).toBe(30);
  });
});

describe("host check-in roster", () => {
  it("lists who checked in, newest first, with names", async () => {
    const host = await mkUser("h@x.com", "Host");
    const ann = await mkUser("a@x.com", "Ann");
    const bob = await mkUser("b@x.com", "Bob");
    insertEvent("e1", past);
    const t0 = Date.parse("2026-06-01T18:00:00Z");
    await repo.checkIn(ann.id, "e1", await repo.createCheckinToken("e1"), t0);
    await repo.checkIn(bob.id, "e1", await repo.createCheckinToken("e1"), t0 + 60000);

    const roster = await repo.eventCheckins("e1");
    expect(roster.length).toBe(2);
    expect(roster[0]!.displayName).toBe("Bob"); // newest first
    expect(roster.map((r) => r.displayName).sort()).toEqual(["Ann", "Bob"]);
    void host;
  });
});

describe("web push subscriptions", () => {
  it("saves (dedup by endpoint), lists per user, and deletes", async () => {
    const a = await mkUser("a@x.com", "Ann");
    const b = await mkUser("b@x.com", "Bob");
    await repo.savePushSub(a.id, { endpoint: "https://push/1", p256dh: "k1", auth: "s1" });
    await repo.savePushSub(a.id, { endpoint: "https://push/2", p256dh: "k2", auth: "s2" });
    await repo.savePushSub(a.id, { endpoint: "https://push/1", p256dh: "k1b", auth: "s1b" }); // same endpoint → upsert
    await repo.savePushSub(b.id, { endpoint: "https://push/3", p256dh: "k3", auth: "s3" });

    const annSubs = await repo.listPushSubs(a.id);
    expect(annSubs.length).toBe(2);
    expect(annSubs.find((s) => s.endpoint === "https://push/1")!.p256dh).toBe("k1b"); // upserted
    expect((await repo.listPushSubs(b.id)).length).toBe(1);

    // deletion is user-scoped: Bob can't delete Ann's endpoint
    await repo.deletePushSub(b.id, "https://push/1");
    expect((await repo.listPushSubs(a.id)).length).toBe(2); // unchanged — not Bob's
    await repo.deletePushSub(a.id, "https://push/1");
    expect((await repo.listPushSubs(a.id)).length).toBe(1);
  });
});

describe("boundary conditions", () => {
  it("check-in token is valid at exactly its expiry instant, expired one ms later", async () => {
    const u = await mkUser("a@x.com", "Ann");
    insertEvent("e1", past); insertEvent("e2", past);
    const t0 = Date.parse("2026-06-01T18:00:00Z");
    const ttl = 60 * 60 * 1000;
    const tokA = await repo.createCheckinToken("e1", ttl, t0);       // expires t0+ttl
    expect(await repo.checkIn(u.id, "e1", tokA, t0 + ttl)).toBe("ok"); // == expiry → still valid
    const tokB = await repo.createCheckinToken("e2", ttl, t0);
    expect(await repo.checkIn(u.id, "e2", tokB, t0 + ttl + 1)).toBe("expired"); // 1ms past → expired
  });

  it("attend streak increments at exactly the 8-day grace, resets one ms beyond it", async () => {
    const u = await mkUser("a@x.com", "Ann");
    for (const e of ["e1", "e2", "e3"]) insertEvent(e, past);
    const t0 = Date.parse("2026-06-01T18:00:00Z");
    const GRACE = 8 * 86400000;
    await repo.checkIn(u.id, "e1", await repo.createCheckinToken("e1", 9e9, t0), t0);
    await repo.checkIn(u.id, "e2", await repo.createCheckinToken("e2", 9e9, t0 + GRACE), t0 + GRACE); // exactly 8d → 2
    expect((await repo.getStreak(u.id, "attend")).count).toBe(2);
    await repo.checkIn(u.id, "e3", await repo.createCheckinToken("e3", 9e9, t0 + GRACE + GRACE + 1), t0 + GRACE + GRACE + 1); // >8d gap → reset
    expect((await repo.getStreak(u.id, "attend"))).toMatchObject({ count: 1, best: 2 });
  });

  it("wrong-event token is 'invalid' even when also expired (event check precedes expiry)", async () => {
    const u = await mkUser("a@x.com", "Ann");
    insertEvent("e1", past); insertEvent("e2", past);
    const t0 = Date.parse("2026-06-01T18:00:00Z");
    const tok = await repo.createCheckinToken("e1", 1000, t0); // for e1, long expired by t0+9e9
    expect(await repo.checkIn(u.id, "e2", tok, t0 + 9e9)).toBe("invalid");
  });

  it("agent settings default to disabled/approve and round-trip auto mode", async () => {
    const u = await mkUser("a@x.com", "Ann");
    expect(await repo.getAgentSettings(u.id)).toMatchObject({ enabled: false, mode: "approve" });
    await repo.setAgentSettings(u.id, true, { mode: "auto", maxPerWeek: 3 });
    expect(await repo.getAgentSettings(u.id)).toMatchObject({ enabled: true, mode: "auto" });
  });
});

describe("bring-your-own AI key storage", () => {
  it("stores the OpenRouter key server-side, exposes only hasAiKey, and clears on null", async () => {
    const u = await mkUser("a@x.com", "Ann");
    await repo.setAiKey(u.id, "sk-secret-123", "openai/gpt-4o-mini");
    const settings = await repo.getAgentSettings(u.id);
    expect(settings.hasAiKey).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("sk-secret-123"); // never surfaced
    expect((await repo.getAiKey(u.id)).key).toBe("sk-secret-123");   // server-only read
    await repo.setAiKey(u.id, null, null);
    expect((await repo.getAgentSettings(u.id)).hasAiKey).toBe(false);
  });
});

describe("subject reviews (host / speaker / participant)", () => {
  it("rates people, upserts per author→subject→event, and aggregates by role", async () => {
    const author = await mkUser("a@x.com", "Ann");
    const author2 = await mkUser("b@x.com", "Bob");
    const host = await mkUser("h@x.com", "Host");
    insertEvent("e1", past);
    await repo.addSubjectReview(author.id, "host", host.id, 5, "great host", "e1");
    await repo.addSubjectReview(author.id, "host", host.id, 4, "revised", "e1"); // upsert, not a 2nd row
    await repo.addSubjectReview(author2.id, "host", host.id, 2);                  // different author
    await repo.addSubjectReview(author.id, "speaker", host.id, 5);               // same person, speaker role

    const reviews = await repo.subjectReviews(host.id);
    expect(reviews.length).toBe(3); // 2 host (ann revised + bob) + 1 speaker
    const rating = await repo.subjectRating(host.id);
    expect(rating.count).toBe(3);
    expect(rating.byRole.host).toMatchObject({ count: 2, avg: 3 });   // (4 + 2)/2
    expect(rating.byRole.speaker).toMatchObject({ count: 1, avg: 5 });
  });
});
