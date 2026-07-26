import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { RankRepo } from "../src/storage/d1/rank-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { trainSurface, rankTick } from "../src/core/rank/train";
import { emptyFeatures } from "../src/core/rank/features";

let d1: any, raw: Database.Database, rank: RankRepo, social: SocialRepo;
beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  rank = new RankRepo(d1);
  social = new SocialRepo(d1);
});

const mkUser = async (email: string) =>
  (await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: email })).id;

/** Impressions are seeded hourly from here; the clock below is well past all of them. */
const SEED_BASE = Date.parse("2026-01-01T10:00:00Z");
const AT = (n: number) => new Date(SEED_BASE + (n + 48) * 3_600_000);
/** Pinned clock + a wide window, so the fixture is reproducible whatever today is. */
const opts = (n: number, extra: Record<string, unknown> = {}) => ({ now: AT(n), sinceDays: 365, ...extra });

/**
 * Seed `n` impressions in which `quality` genuinely predicts engagement, spread over
 * `n` days so the time-based holdout split has something to split on.
 */
async function seedLearnable(viewerId: string, n: number, opts: { signal?: boolean } = {}) {
  const signal = opts.signal !== false;
  const mkEvent = raw.prepare(
    `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, '2027-01-01T18:00:00Z', 'America/Los_Angeles', 'San Francisco', ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );
  const mkRsvp = raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)");
  const base = SEED_BASE;

  for (let i = 0; i < n; i++) {
    const id = `e${i}`;
    mkEvent.run(id, `fp-${id}`, `Event ${id}`, `https://x/${id}`, `ch-${id}`);
    const engaged = i % 3 === 0; // a third engage — a realistic-ish positive rate
    const f = emptyFeatures();
    // With signal, quality tracks the label. Without, it is constant and there is
    // nothing for the model to find.
    f.quality = signal ? (engaged ? 0.9 : 0.1) : 0.5;
    f.recency = 0.5;
    const servedAt = new Date(base + i * 3_600_000); // one per hour, so order is stable
    await rank.logImpressions({
      surface: "events",
      viewerId,
      modelVersion: "v0",
      explored: false,
      items: [{ itemId: id, position: i % 20, features: f }],
      now: servedAt,
    });
    if (engaged) mkRsvp.run(viewerId, id, new Date(servedAt.getTime() + 60_000).toISOString());
  }
  // Well past every impression's settle window.
  await rank.labelPending("events", 10_000, AT(n));
}

const modelRows = () => raw.prepare("SELECT * FROM rank_models ORDER BY version").all() as any[];

describe("trainSurface: day one is a no-op", () => {
  it("declines with no data, and writes nothing", async () => {
    const r = await trainSurface(rank, "events", opts(0));
    expect(r.trained).toBe(false);
    expect(r.promoted).toBe(false);
    expect(r.rows).toBe(0);
    expect(r.reason).toMatch(/waiting for data/);
    expect(modelRows()).toHaveLength(0); // nothing to say yet, so nothing is said
    expect(await rank.activeModel("events")).toBeNull();
  });

  it("still declines just below the real threshold", async () => {
    const ann = await mkUser("a@x.com");
    await seedLearnable(ann, 120);
    const r = await trainSurface(rank, "events", opts(120)); // real MIN_TRAINING_ROWS = 500
    expect(r.trained).toBe(false);
    expect(r.reason).toMatch(/waiting for data/);
  });
});

describe("trainSurface: with real data it learns and promotes", () => {
  it("trains, beats a coin flip, and goes live", async () => {
    const ann = await mkUser("a@x.com");
    await seedLearnable(ann, 700);

    const r = await trainSurface(rank, "events", opts(700));
    expect(r.trained).toBe(true);
    expect(r.rows).toBeGreaterThanOrEqual(600);
    expect(r.candidateAuc!).toBeGreaterThan(0.9);
    expect(r.incumbentAuc).toBeNull(); // nothing to beat the first time
    expect(r.promoted).toBe(true);
    expect(r.version).toBe(1);

    const live = await rank.activeModel("events");
    expect(live!.version).toBe(1);
    expect(live!.weights.quality!).toBeGreaterThan(0);
    expect(live!.holdoutAuc!).toBeGreaterThan(0.9);
    // The fusion weights ride along, so the row fully describes a serving policy.
    expect(live!.rrf.bm25).toBe(1);
  });

  it("REFUSES to promote a re-train on identical data — no gain is not an improvement", async () => {
    const ann = await mkUser("a@x.com");
    await seedLearnable(ann, 700);
    const first = await trainSurface(rank, "events", opts(700));
    expect(first.promoted).toBe(true);

    const second = await trainSurface(rank, "events", opts(700));
    expect(second.trained).toBe(true);
    expect(second.promoted).toBe(false);
    expect(second.reason).toMatch(/no gain/);
    // The candidate is still recorded, so a stalled loop is visible to an operator.
    expect(modelRows()).toHaveLength(2);
    expect(modelRows()[1]!.promoted_at).toBeNull();
    // And the live model is untouched.
    expect((await rank.activeModel("events"))!.version).toBe(1);
  });

  it("refuses to promote when there is no signal to find", async () => {
    const ann = await mkUser("a@x.com");
    await seedLearnable(ann, 700, { signal: false });
    const r = await trainSurface(rank, "events", opts(700));
    expect(r.trained).toBe(true);
    // Every candidate scores identically, so AUC is 0.5 and the gate holds.
    expect(r.candidateAuc!).toBeLessThan(0.55);
    expect(r.promoted).toBe(false);
    expect(await rank.activeModel("events")).toBeNull();
  });

  it("holds out the NEWEST rows, so the evaluation is a forecast", async () => {
    const ann = await mkUser("a@x.com");
    await seedLearnable(ann, 700);
    const r = await trainSurface(rank, "events", opts(700, { holdoutFraction: 0.2 }));
    // 700 rows, 20% held out → ~560 trained on.
    expect(modelRows()[0]!.n_rows).toBeGreaterThan(400);
    expect(modelRows()[0]!.n_rows).toBeLessThan(700);
    expect(r.trained).toBe(true);
  });
});

describe("trainSurface: a bad model can never displace a good one", () => {
  it("keeps the incumbent when the candidate is worse on the same holdout", async () => {
    const ann = await mkUser("a@x.com");
    await seedLearnable(ann, 700);
    await trainSurface(rank, "events", opts(700));
    const before = await rank.activeModel("events");

    // Hand-install a deliberately excellent incumbent, then retrain. The candidate
    // cannot beat it, so nothing changes.
    await rank.saveModel({
      surface: "events",
      weights: { quality: 50 },
      rrf: {},
      nRows: 999,
      holdoutAuc: 0.999,
      incumbentAuc: null,
      promote: true,
    });
    const after = await trainSurface(rank, "events", opts(700));
    expect(after.promoted).toBe(false);
    expect((await rank.activeModel("events"))!.weights.quality).toBe(50);
    expect(before!.version).toBeLessThan((await rank.activeModel("events"))!.version);
  });
});

describe("rankTick: the cron entry point", () => {
  it("labels then trains every surface, and tolerates empty ones", async () => {
    const ann = await mkUser("a@x.com");
    await seedLearnable(ann, 700);
    const results = await rankTick(rank, ["events", "news", "shadows"], opts(700));
    expect(results.map((r) => r.surface)).toEqual(["events", "news", "shadows"]);
    expect(results.find((r) => r.surface === "events")!.trained).toBe(true);
    // No news or shadows traffic yet — that is the normal state, not an error.
    expect(results.find((r) => r.surface === "news")!.trained).toBe(false);
    expect(results.find((r) => r.surface === "shadows")!.trained).toBe(false);
  });

  it("labels unlabelled rows as a side effect", async () => {
    const ann = await mkUser("a@x.com");
    const mkEvent = raw.prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at)
       VALUES ('e1','fp1','T','2027-01-01T18:00:00Z','America/Los_Angeles','SF','https://x/1','ch1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    );
    mkEvent.run();
    await rank.logImpressions({
      surface: "events",
      viewerId: ann,
      modelVersion: "v0",
      explored: false,
      items: [{ itemId: "e1", position: 0, features: emptyFeatures() }],
      now: new Date(Date.now() - 48 * 3600_000),
    });
    expect((raw.prepare("SELECT label FROM rank_impressions").get() as any).label).toBeNull();
    await rankTick(rank, ["events"]);
    expect((raw.prepare("SELECT label FROM rank_impressions").get() as any).label).toBe(0);
  });
});
