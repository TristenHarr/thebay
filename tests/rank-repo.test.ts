import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { RankRepo, SETTLE_HOURS, RETENTION_DAYS } from "../src/storage/d1/rank-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { emptyFeatures } from "../src/core/rank/features";

let d1: any, raw: Database.Database, rank: RankRepo, social: SocialRepo;
beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  rank = new RankRepo(d1);
  social = new SocialRepo(d1);
});

const mkUser = async (email: string) =>
  (await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: email })).id;

function mkEvent(id: string) {
  raw
    .prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'San Francisco', ?, ?, ?, ?)`,
    )
    .run(id, `fp-${id}`, `Event ${id}`, "2026-08-01T18:00:00Z", `https://x/${id}`, `ch-${id}`, "2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z");
}

const feats = (quality = 0.5) => {
  const f = emptyFeatures();
  f.quality = quality;
  return f;
};

const log = (viewerId: string, items: Array<[string, number]>, when: string, explored = false) =>
  rank.logImpressions({
    surface: "events",
    viewerId,
    modelVersion: "v0",
    explored,
    items: items.map(([itemId, position]) => ({ itemId, position, features: feats() })),
    now: new Date(when),
  });

const rowsFor = (itemId: string) =>
  raw.prepare("SELECT * FROM rank_impressions WHERE item_id = ?").all(itemId) as any[];

describe("RankRepo: logging is idempotent but re-exposure is still observable", () => {
  it("logs one row per item with its position and propensity", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    mkEvent("e2");
    await log(ann, [["e1", 0], ["e2", 5]], "2026-07-26T10:00:00Z");

    const r1 = rowsFor("e1")[0]!;
    expect(r1.position).toBe(0);
    expect(r1.propensity).toBe(1); // slot 0 is always examined
    expect(rowsFor("e2")[0]!.propensity).toBeLessThan(1); // deeper slots are discounted
    expect(r1.label).toBeNull(); // unlabelled until the ladder runs
  });

  it("a re-render on the same day bumps times_shown instead of adding a training row", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    await log(ann, [["e1", 0]], "2026-07-26T10:00:00Z");
    await log(ann, [["e1", 3]], "2026-07-26T11:00:00Z");
    await log(ann, [["e1", 7]], "2026-07-26T12:00:00Z");

    const rows = rowsFor("e1");
    expect(rows).toHaveLength(1); // one training row, not three
    expect(rows[0]!.times_shown).toBe(3);
    expect(rows[0]!.position).toBe(0); // the FIRST slot — the least biased one
  });

  it("a different day is a genuinely new impression", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    await log(ann, [["e1", 0]], "2026-07-26T10:00:00Z");
    await log(ann, [["e1", 0]], "2026-07-27T10:00:00Z");
    expect(rowsFor("e1")).toHaveLength(2);
  });

  it("the schema refuses an anonymous impression", async () => {
    mkEvent("e1");
    // Such a row could never be labelled positive (every engagement needs an account)
    // and its exposure count would be shared by every anonymous visitor.
    await expect(log(null as any, [["e1", 0]], "2026-07-26T10:00:00Z")).rejects.toThrow();
  });

  it("reports no exposure history for an anonymous viewer instead of a shared count", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    await log(ann, [["e1", 0]], "2026-07-26T10:00:00Z");
    await log(ann, [["e1", 0]], "2026-07-27T10:00:00Z");
    // Ann has seen it twice; a logged-out reader has seen it zero times, not twice.
    expect((await rank.timesShown("events", ann, ["e1"])).get("e1")).toBe(2);
    expect((await rank.timesShown("events", null, ["e1"])).size).toBe(0);
  });

  it("reports times_shown for a whole candidate set in one query", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    mkEvent("e2");
    await log(ann, [["e1", 0], ["e2", 1]], "2026-07-26T10:00:00Z");
    await log(ann, [["e1", 0]], "2026-07-26T11:00:00Z");
    const seen = await rank.timesShown("events", ann, ["e1", "e2", "e3"]);
    expect(seen.get("e1")).toBe(2);
    expect(seen.get("e2")).toBe(1);
    expect(seen.has("e3")).toBe(false); // never shown → absent, not 0
  });

  it("handles a candidate set larger than D1's bind-parameter cap", async () => {
    const ann = await mkUser("a@x.com");
    const ids = Array.from({ length: 250 }, (_, i) => `e${i}`);
    for (const id of ids) mkEvent(id);
    await log(ann, ids.map((id, i) => [id, i] as [string, number]), "2026-07-26T10:00:00Z");
    const seen = await rank.timesShown("events", ann, ids);
    expect(seen.size).toBe(250);
  });

  it("deletes a user's impressions with the user", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    await log(ann, [["e1", 0]], "2026-07-26T10:00:00Z");
    raw.prepare("DELETE FROM users WHERE id = ?").run(ann);
    expect(rowsFor("e1")).toHaveLength(0); // ON DELETE CASCADE, not a cleanup job
  });
});

describe("RankRepo: labelling joins the signals we already store", () => {
  it("an RSVP after the impression becomes a positive", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    await log(ann, [["e1", 0]], "2026-07-26T10:00:00Z");
    raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,?,?)")
      .run(ann, "e1", "going", "2026-07-26T10:30:00Z");

    await rank.labelPending("events", 100, new Date("2026-07-26T20:00:00Z"));
    const r = rowsFor("e1")[0]!;
    expect(r.label).toBe(1);
    expect(r.label_kind).toBe("rsvp");
    expect(r.labeled_at).not.toBeNull();
  });

  it("an RSVP that PREDATES the impression is not credited to it", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,?,?)")
      .run(ann, "e1", "going", "2026-07-20T10:00:00Z");
    await log(ann, [["e1", 0]], "2026-07-26T10:00:00Z");

    await rank.labelPending("events", 100, new Date("2026-07-26T20:00:00Z"));
    // Showing someone an event they had already committed to is not a win for the feed.
    expect(rowsFor("e1")[0]!.label).toBe(0);
  });

  it("a check-in outranks an RSVP — the ladder upgrades, never downgrades", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    await log(ann, [["e1", 0]], "2026-07-26T10:00:00Z");
    raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,?,?)")
      .run(ann, "e1", "going", "2026-07-26T10:30:00Z");
    await rank.labelPending("events", 100, new Date("2026-07-26T20:00:00Z"));
    expect(rowsFor("e1")[0]!.label_kind).toBe("rsvp");

    // They then actually turned up.
    raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?,?,?,'qr')")
      .run(ann, "e1", "2026-08-01T18:05:00Z");
    await rank.labelPending("events", 100, new Date("2026-08-02T00:00:00Z"));
    expect(rowsFor("e1")[0]!.label_kind).toBe("checkin");
  });

  it("re-running the ladder converges — it does not flip labels back and forth", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    await log(ann, [["e1", 0]], "2026-07-26T10:00:00Z");
    raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?,?,?,'qr')")
      .run(ann, "e1", "2026-07-26T11:00:00Z");

    const at = new Date("2026-07-27T00:00:00Z");
    await rank.labelPending("events", 100, at);
    const first = rowsFor("e1")[0]!.labeled_at;
    await rank.labelPending("events", 100, at);
    await rank.labelPending("events", 100, at);
    const rows = rowsFor("e1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label_kind).toBe("checkin");
    expect(rows[0]!.labeled_at).toBe(first); // idempotent: no churn
  });

  it("does not settle a negative before the user has had time to act", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    await log(ann, [["e1", 0]], "2026-07-26T10:00:00Z");
    // One hour later — well inside the settle window.
    await rank.labelPending("events", 100, new Date("2026-07-26T11:00:00Z"));
    expect(rowsFor("e1")[0]!.label).toBeNull();

    // Past the window: now it is a real negative.
    const after = new Date(Date.parse("2026-07-26T10:00:00Z") + (SETTLE_HOURS + 1) * 3600_000);
    await rank.labelPending("events", 100, after);
    expect(rowsFor("e1")[0]!.label).toBe(0);
    expect(rowsFor("e1")[0]!.label_kind).toBe("none");
  });

  it("labels news by votes and comments", async () => {
    const ann = await mkUser("a@x.com");
    raw.prepare("INSERT INTO stories (id, kind, title, url, author_id, created_at, origin) VALUES ('s1','link','T','https://x/1',?,?,'bay')")
      .run(ann, "2026-07-26T09:00:00Z");
    await rank.logImpressions({
      surface: "news",
      viewerId: ann,
      modelVersion: "v0",
      explored: false,
      items: [{ itemId: "s1", position: 0, features: feats() }],
      now: new Date("2026-07-26T10:00:00Z"),
    });
    raw.prepare("INSERT INTO story_votes (story_id, user_id, created_at) VALUES ('s1',?,?)")
      .run(ann, "2026-07-26T10:05:00Z");

    await rank.labelPending("news", 100, new Date("2026-07-26T20:00:00Z"));
    expect(rowsFor("s1")[0]!.label_kind).toBe("vote");
  });

  it("counts what it has labelled", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    mkEvent("e2");
    await log(ann, [["e1", 0], ["e2", 1]], "2026-07-26T10:00:00Z");
    raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,?,?)")
      .run(ann, "e1", "going", "2026-07-26T10:30:00Z");
    await rank.labelPending("events", 100, new Date("2026-07-27T00:00:00Z"));
    expect(await rank.countLabeled("events")).toEqual({ total: 2, positives: 1 });
  });
});

describe("RankRepo: explicit client feedback", () => {
  it("an open is a positive and a dismiss is a negative", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    mkEvent("e2");
    await log(ann, [["e1", 0], ["e2", 1]], "2026-07-26T10:00:00Z");

    expect(await rank.recordFeedback("events", ann, "e1", "open")).toBe(true);
    expect(await rank.recordFeedback("events", ann, "e2", "dismiss")).toBe(true);
    expect(rowsFor("e1")[0]!.label).toBe(1);
    expect(rowsFor("e1")[0]!.label_kind).toBe("open");
    expect(rowsFor("e2")[0]!.label).toBe(0);
  });

  it("feedback about something never served is a no-op, not an error", async () => {
    const ann = await mkUser("a@x.com");
    expect(await rank.recordFeedback("events", ann, "never-shown", "open")).toBe(false);
  });

  it("a later RSVP upgrades an open", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    await log(ann, [["e1", 0]], "2026-07-26T10:00:00Z");
    await rank.recordFeedback("events", ann, "e1", "open");
    raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,?,?)")
      .run(ann, "e1", "going", "2026-07-26T10:30:00Z");
    await rank.labelPending("events", 100, new Date("2026-07-27T00:00:00Z"));
    expect(rowsFor("e1")[0]!.label_kind).toBe("rsvp");
  });
});

describe("RankRepo: training rows", () => {
  it("returns only labelled rows, newest first, with features intact", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    mkEvent("e2");
    await log(ann, [["e1", 0]], "2026-07-20T10:00:00Z");
    await log(ann, [["e2", 4]], "2026-07-25T10:00:00Z");
    await rank.labelPending("events", 100, new Date("2026-07-26T00:00:00Z"));

    const rows = await rank.trainingRows("events", { sinceDays: 365 });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.features.quality).toBe(0.5); // read back as stored, not recomputed
    expect(rows[0]!.propensity).toBeLessThan(1); // e2 was at slot 4 and is newest
  });

  it("skips a corrupt features blob rather than poisoning the batch", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    mkEvent("e2");
    await log(ann, [["e1", 0], ["e2", 1]], "2026-07-20T10:00:00Z");
    await rank.labelPending("events", 100, new Date("2026-07-26T00:00:00Z"));
    raw.prepare("UPDATE rank_impressions SET features_json = '{not json' WHERE item_id = 'e1'").run();

    const rows = await rank.trainingRows("events", { sinceDays: 365 });
    expect(rows).toHaveLength(1);
  });

  it("records whether a row came from the exploration slice", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    await log(ann, [["e1", 0]], "2026-07-20T10:00:00Z", true);
    await rank.labelPending("events", 100, new Date("2026-07-26T00:00:00Z"));
    expect((await rank.trainingRows("events", { sinceDays: 365 }))[0]!.explored).toBe(true);
  });
});

describe("RankRepo: the model registry", () => {
  it("versions monotonically per surface and starts un-promoted", async () => {
    const a = await rank.saveModel({
      surface: "events", weights: { quality: 1 }, rrf: { bm25: 1 },
      nRows: 100, holdoutAuc: 0.7, incumbentAuc: null, promote: false,
    });
    const b = await rank.saveModel({
      surface: "events", weights: { quality: 2 }, rrf: { bm25: 1 },
      nRows: 200, holdoutAuc: 0.8, incumbentAuc: 0.7, promote: true,
    });
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    // Surfaces version independently.
    expect((await rank.saveModel({
      surface: "news", weights: {}, rrf: {}, nRows: 1, holdoutAuc: null, incumbentAuc: null, promote: false,
    })).version).toBe(1);
  });

  it("activeModel is the highest PROMOTED version, ignoring newer rejects", async () => {
    await rank.saveModel({ surface: "events", weights: { quality: 1 }, rrf: {}, nRows: 1, holdoutAuc: 0.8, incumbentAuc: null, promote: true });
    await rank.saveModel({ surface: "events", weights: { quality: 9 }, rrf: {}, nRows: 1, holdoutAuc: 0.5, incumbentAuc: 0.8, promote: false });
    const live = await rank.activeModel("events");
    expect(live!.version).toBe(1);
    expect(live!.weights.quality).toBe(1); // the reject did NOT go live
  });

  it("is null when nothing has been promoted — the passthrough case", async () => {
    await rank.saveModel({ surface: "events", weights: { quality: 1 }, rrf: {}, nRows: 1, holdoutAuc: 0.5, incumbentAuc: null, promote: false });
    expect(await rank.activeModel("events")).toBeNull();
  });

  it("the schema refuses to promote an unevaluated model", async () => {
    await expect(
      rank.saveModel({ surface: "events", weights: { quality: 1 }, rrf: {}, nRows: 1, holdoutAuc: null, incumbentAuc: null, promote: true }),
    ).rejects.toThrow();
  });

  it("sanitizes weights on read, so a hand-edited row cannot inject a key or a NaN", async () => {
    await rank.saveModel({ surface: "events", weights: { quality: 1 }, rrf: {}, nRows: 1, holdoutAuc: 0.9, incumbentAuc: null, promote: true });
    raw.prepare(`UPDATE rank_models SET weights_json = '{"quality":2,"evil":5}'`).run();
    const live = await rank.activeModel("events");
    expect(live!.weights).toEqual({ quality: 2 });
  });

  it("survives a corrupt weights or rrf blob", async () => {
    await rank.saveModel({ surface: "events", weights: { quality: 1 }, rrf: {}, nRows: 1, holdoutAuc: 0.9, incumbentAuc: null, promote: true });
    raw.prepare("UPDATE rank_models SET weights_json = 'oops', rrf_json = 'oops'").run();
    const live = await rank.activeModel("events");
    expect(live!.weights).toEqual({});
    expect(live!.rrf).toEqual({});
  });

  it("recentModels shows rejections so a stalled loop is visible", async () => {
    for (let i = 0; i < 3; i++) {
      await rank.saveModel({
        surface: "events", weights: {}, rrf: {}, nRows: 1,
        holdoutAuc: 0.5, incumbentAuc: null, promote: false, notes: `nope ${i}`,
      });
    }
    const recent = await rank.recentModels("events");
    expect(recent).toHaveLength(3);
    expect(recent[0]!.promotedAt).toBeNull();
  });
});

describe("RankRepo: viewer context is derived from behaviour, not declarations", () => {
  function mkTagged(id: string, categories: string[], organizer: string | null) {
    raw
      .prepare(
        `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash,
                             first_seen_at, last_seen_at, categories, organizer)
         VALUES (?, ?, ?, '2026-08-01T18:00:00Z', 'America/Los_Angeles', 'SF', ?, ?,
                 '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', ?, ?)`,
      )
      .run(id, `fp-${id}`, `Event ${id}`, `https://x/${id}`, `ch-${id}`, JSON.stringify(categories), organizer);
  }

  it("an anonymous viewer has no affinities at all", async () => {
    const ctx = await rank.viewerContext(null);
    expect(ctx.tagAffinity.size).toBe(0);
    expect(ctx.authorAffinity.size).toBe(0);
    expect(ctx.checkins).toBe(0);
  });

  it("a viewer with no history has no affinities either", async () => {
    const ann = await mkUser("a@x.com");
    const ctx = await rank.viewerContext(ann);
    expect(ctx.tagAffinity.size).toBe(0);
    expect(ctx.checkins).toBe(0);
  });

  it("builds tag + author affinity from RSVPs and check-ins", async () => {
    const ann = await mkUser("a@x.com");
    mkTagged("e1", ["ai", "hardware"], "Frontier Tower");
    mkTagged("e2", ["ai"], "Frontier Tower");
    mkTagged("e3", ["cooking"], "Someone Else");
    raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)")
      .run(ann, "e1", "2026-07-20T10:00:00Z");
    raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?,?,?,'qr')")
      .run(ann, "e2", "2026-07-21T10:00:00Z");

    const ctx = await rank.viewerContext(ann);
    // `ai` appears in both engaged events, `hardware` in one → stronger affinity for ai.
    expect(ctx.tagAffinity.get("ai")!).toBeGreaterThan(ctx.tagAffinity.get("hardware")!);
    // An event they never touched contributes nothing.
    expect(ctx.tagAffinity.has("cooking")).toBe(false);
    expect(ctx.authorAffinity.get("frontier tower")!).toBeGreaterThan(0);
    expect(ctx.authorAffinity.has("someone else")).toBe(false);
    expect(ctx.checkins).toBe(1);
  });

  it("counts an event only once even when both RSVP'd and checked into", async () => {
    const ann = await mkUser("a@x.com");
    mkTagged("e1", ["ai"], "Host");
    raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)")
      .run(ann, "e1", "2026-07-20T10:00:00Z");
    raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?,?,?,'qr')")
      .run(ann, "e1", "2026-07-21T10:00:00Z");
    const one = await rank.viewerContext(ann);

    // A second, genuinely different AI event must move the needle more than the
    // double-counted first one did — that's what UNION (not UNION ALL) buys.
    mkTagged("e2", ["ai"], "Host");
    raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)")
      .run(ann, "e2", "2026-07-22T10:00:00Z");
    const two = await rank.viewerContext(ann);
    expect(two.tagAffinity.get("ai")!).toBeGreaterThan(one.tagAffinity.get("ai")!);
  });

  it("all affinities are bounded to [0,1] however much history there is", async () => {
    const ann = await mkUser("a@x.com");
    for (let i = 0; i < 60; i++) {
      mkTagged(`e${i}`, ["ai"], "Host");
      raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)")
        .run(ann, `e${i}`, "2026-07-20T10:00:00Z");
    }
    const ctx = await rank.viewerContext(ann);
    expect(ctx.tagAffinity.get("ai")!).toBeLessThanOrEqual(1);
    expect(ctx.authorAffinity.get("host")!).toBeLessThanOrEqual(1);
  });

  it("keys affinities lower-case so they match the feature extractor", async () => {
    const ann = await mkUser("a@x.com");
    mkTagged("e1", ["AI"], "Frontier Tower");
    raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)")
      .run(ann, "e1", "2026-07-20T10:00:00Z");
    const ctx = await rank.viewerContext(ann);
    expect(ctx.tagAffinity.has("ai")).toBe(true);
    expect(ctx.authorAffinity.has("frontier tower")).toBe(true);
  });
});

describe("RankRepo: engagement counts", () => {
  it("counts total RSVPs and, separately, the viewer's friends", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    const cat = await mkUser("c@x.com");
    mkEvent("e1");
    await social.requestFriend(ann, bob);
    await social.respondFriend(bob, ann, true);
    for (const u of [bob, cat]) {
      raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)")
        .run(u, "e1", "2026-07-20T10:00:00Z");
    }

    const counts = await rank.engagementCounts(["e1"], ann);
    expect(counts.get("e1")).toEqual({ total: 2, friends: 1 }); // cat is a stranger
  });

  it("reports no friend counts for an anonymous viewer, but still counts totals", async () => {
    const bob = await mkUser("b@x.com");
    mkEvent("e1");
    raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)")
      .run(bob, "e1", "2026-07-20T10:00:00Z");
    expect(await rank.engagementCounts(["e1"], null)).toEqual(new Map([["e1", { total: 1, friends: 0 }]]));
  });

  it("omits events nobody engaged with, rather than inventing zeros", async () => {
    mkEvent("e1");
    expect((await rank.engagementCounts(["e1"], null)).has("e1")).toBe(false);
  });

  it("chunks past D1's bind-parameter cap", async () => {
    const bob = await mkUser("b@x.com");
    const ids = Array.from({ length: 200 }, (_, i) => `e${i}`);
    for (const id of ids) {
      mkEvent(id);
      raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)")
        .run(bob, id, "2026-07-20T10:00:00Z");
    }
    const counts = await rank.engagementCounts(ids, bob);
    expect(counts.size).toBe(200);
  });

  it("ignores a withdrawn RSVP", async () => {
    const bob = await mkUser("b@x.com");
    mkEvent("e1");
    raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)")
      .run(bob, "e1", "2026-07-20T10:00:00Z");
    raw.prepare("DELETE FROM rsvps WHERE user_id = ?").run(bob);
    expect((await rank.engagementCounts(["e1"], null)).has("e1")).toBe(false);
  });
});

describe("RankRepo: retention is enforced, not aspirational", () => {
  it("gc drops impressions past the window and keeps the rest", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    mkEvent("e2");
    const now = new Date("2026-07-26T10:00:00Z");
    await log(ann, [["e1", 0]], "2026-05-01T10:00:00Z"); // ~86 days old
    await log(ann, [["e2", 0]], "2026-07-25T10:00:00Z"); // yesterday

    expect(await rank.gc(RETENTION_DAYS, 5000, now)).toBe(1);
    expect(rowsFor("e1")).toHaveLength(0);
    expect(rowsFor("e2")).toHaveLength(1);
  });

  it("gc is bounded so one tick cannot stall the cron", async () => {
    const ann = await mkUser("a@x.com");
    const ids = Array.from({ length: 10 }, (_, i) => `e${i}`);
    for (const id of ids) mkEvent(id);
    await log(ann, ids.map((id, i) => [id, i] as [string, number]), "2026-01-01T10:00:00Z");
    expect(await rank.gc(RETENTION_DAYS, 4, new Date("2026-07-26T10:00:00Z"))).toBe(4);
  });
});
