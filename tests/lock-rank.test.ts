import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { makeTestApp, call, login } from "./helpers/app";
import { RankRepo, RETENTION_DAYS } from "../src/storage/d1/rank-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { ANON_VIEWER, FEATURE_NAMES, emptyFeatures } from "../src/core/rank/features";
import { rerank, eventToRankItem } from "../src/core/rank/rerank";
import {
  SEED_WEIGHTS,
  LABEL_WEIGHT,
  shouldPromote,
  shouldRescore,
  trainLogistic,
  evaluate,
  MIN_TRAINING_ROWS,
  MIN_HOLDOUT_ROWS,
  type TrainingRow,
} from "../src/core/rank/model";
import { HOLDOUT_FRACTION } from "../src/core/rank/train";
import { RANK_SURFACES } from "../shared/schema";

/**
 * LOCK-IN TESTS — the learning loop.
 *
 * Same contract as `tests/lock-schema.test.ts`: these don't test a feature, they close a
 * class of mistake. Two of them close mistakes that were actually made while building
 * this, and the rest close the ones that a self-training ranker fails by DEFAULT —
 * silently, with no error and no obvious wrong answer.
 */

let d1: any, raw: Database.Database, rank: RankRepo, social: SocialRepo;
beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  rank = new RankRepo(d1);
  social = new SocialRepo(d1);
});

const migration = readFileSync(resolve(process.cwd(), "migrations/0024_rank.sql"), "utf8");

const mkUser = async (email: string) =>
  (await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: email })).id;

/* ── 1. cold start must be a passthrough ─────────────────────────────────────── */

describe("lock: shipping the loop cannot change today's ordering", () => {
  it("no promoted model means no rescoring", async () => {
    // The whole safety argument for merging this rests on it. If someone later makes
    // `activeModel` fall back to SEED_WEIGHTS, the feed silently changes for everyone.
    expect(await rank.activeModel("events")).toBeNull();
    expect(shouldRescore(await rank.activeModel("events"))).toBe(false);
  });

  it("an un-promoted candidate does not go live", async () => {
    await rank.saveModel({
      surface: "events", weights: { quality: 5 }, rrf: {}, nRows: 9000,
      holdoutAuc: 0.99, incumbentAuc: null, promote: false,
    });
    expect(await rank.activeModel("events")).toBeNull();
  });

  it("SEED_WEIGHTS is a training prior only — never returned as a live model", async () => {
    const live = await rank.activeModel("events");
    expect(live).toBeNull();
    // And it is not smuggled in via shouldRescore either.
    expect(shouldRescore({ weights: SEED_WEIGHTS.events })).toBe(true); // it IS a real vector...
    expect(shouldRescore(null)).toBe(false); // ...but absence is absence.
  });
});

/* ── 2. the promotion gate ───────────────────────────────────────────────────── */

describe("lock: a worse model can never be promoted", () => {
  const strong = { auc: 0.9, logLoss: 0.2, n: 4000, positives: 800 };

  it("rejects a candidate that loses to the incumbent", () => {
    expect(shouldPromote({ ...strong, auc: 0.7 }, strong).promote).toBe(false);
  });

  it("rejects a candidate that merely ties", () => {
    expect(shouldPromote(strong, strong).promote).toBe(false);
  });

  it("rejects a coin flip with no incumbent", () => {
    expect(shouldPromote({ ...strong, auc: 0.5 }, null).promote).toBe(false);
  });

  it("rejects a thin holdout however good the number", () => {
    expect(shouldPromote({ auc: 1, logLoss: 0, n: 5, positives: 5 }, null).promote).toBe(false);
  });

  it("every rejection explains itself", () => {
    for (const c of [
      { auc: 0.7, logLoss: 0, n: 4000, positives: 800 },
      { auc: 1, logLoss: 0, n: 5, positives: 5 },
      { auc: 0.5, logLoss: 0, n: 4000, positives: 800 },
      { auc: Number.NaN, logLoss: 0, n: 4000, positives: 800 },
    ]) {
      const d = shouldPromote(c, strong);
      expect(d.promote).toBe(false);
      expect(d.reason.length, JSON.stringify(c)).toBeGreaterThan(0);
    }
  });

  it("the schema — not just the code — refuses an unevaluated promotion", async () => {
    // Belt and braces: even a future caller that bypasses `shouldPromote` cannot write a
    // promoted model with no holdout score.
    expect(migration).toMatch(/CHECK\s*\(\s*promoted_at IS NULL OR holdout_auc IS NOT NULL\s*\)/);
    await expect(
      rank.saveModel({
        surface: "events", weights: {}, rrf: {}, nRows: 1,
        holdoutAuc: null, incumbentAuc: null, promote: true,
      }),
    ).rejects.toThrow();
  });
});

/* ── 3. the holdout threshold is NOT the training threshold ──────────────────── */

describe("lock: holdout size and training size are different thresholds", () => {
  it("a holdout of the default fraction of MIN_TRAINING_ROWS can still pass the gate", () => {
    // This was a real bug: the gate was handed the HOLDOUT evaluation but compared its
    // `n` against MIN_TRAINING_ROWS. A 20% holdout of the minimum viable dataset is 100
    // rows, so nothing could ever be promoted — and it failed silently, as a permanent
    // run of "too few rows" that looks exactly like "not enough traffic yet".
    const holdoutOfMinimum = Math.floor(MIN_TRAINING_ROWS * HOLDOUT_FRACTION);
    expect(MIN_HOLDOUT_ROWS).toBeLessThanOrEqual(holdoutOfMinimum);
    expect(
      shouldPromote({ auc: 0.9, logLoss: 0.2, n: holdoutOfMinimum, positives: 30 }, null).promote,
    ).toBe(true);
  });

  it("the two thresholds have not been collapsed into one", () => {
    expect(MIN_HOLDOUT_ROWS).toBeLessThan(MIN_TRAINING_ROWS);
  });
});

/* ── 4. feature-name drift ───────────────────────────────────────────────────── */

describe("lock: feature names are the contract between serving and training", () => {
  it("has no duplicates", () => {
    expect(new Set(FEATURE_NAMES).size).toBe(FEATURE_NAMES.length);
  });

  it("every SEED_WEIGHTS key is a real feature — a rename cannot orphan a prior", () => {
    // Renaming a feature without updating the priors leaves a weight that is never read
    // and a feature that is never weighted. Both are invisible at runtime.
    for (const surface of RANK_SURFACES) {
      for (const key of Object.keys(SEED_WEIGHTS[surface])) {
        expect(FEATURE_NAMES as readonly string[], `${surface}.${key}`).toContain(key);
      }
    }
  });

  it("emptyFeatures covers exactly the declared names", () => {
    expect(Object.keys(emptyFeatures()).sort()).toEqual([...FEATURE_NAMES].sort());
  });

  it("a stored vector missing a newer feature still scores, rather than crashing", async () => {
    await rank.saveModel({
      surface: "events", weights: { quality: 1 }, rrf: {}, nRows: 900,
      holdoutAuc: 0.8, incumbentAuc: null, promote: true,
    });
    const live = await rank.activeModel("events");
    const f = emptyFeatures();
    f.quality = 0.5;
    expect(evaluate([{ features: f, label: 1 }], live!.weights).logLoss).toBeGreaterThan(0);
  });

  it("every label kind the ladder can write has a training weight", () => {
    // A label kind with no entry in LABEL_WEIGHT silently falls back to 1, which
    // quietly discards the whole point of weighting a check-in above a tap.
    const kindsInRepo = [...migration.matchAll(/'(checkin|rsvp|vote|comment|reaction|open|dismiss|none)'/g)]
      .map((m) => m[1]!);
    for (const kind of new Set(kindsInRepo)) {
      expect(LABEL_WEIGHT[kind], kind).toBeGreaterThan(0);
    }
  });
});

/* ── 5. determinism ──────────────────────────────────────────────────────────── */

describe("lock: training is reproducible", () => {
  const rows: TrainingRow[] = Array.from({ length: 300 }, (_, i) => {
    const f = emptyFeatures();
    f.quality = i % 2 ? 0.9 : 0.1;
    f.recency = (i % 7) / 7;
    return { features: f, label: (i % 2 ? 1 : 0) as 0 | 1, weight: 1 + (i % 3) };
  });

  it("the same rows give byte-identical weights", () => {
    expect(trainLogistic(rows, "events")).toEqual(trainLogistic(rows, "events"));
  });

  it("row order does not matter — the trainer is full-batch, not stochastic", () => {
    const a = trainLogistic(rows, "events");
    const b = trainLogistic([...rows].reverse(), "events");
    for (const n of FEATURE_NAMES) expect(b[n]!).toBeCloseTo(a[n]!, 9);
  });

  it("no ambient randomness anywhere in src/core/rank", () => {
    // `src/` has zero Math.random CALLS by design; exploration must use the seeded PRNG.
    // Matches an invocation rather than the name, so the comments that explain why it is
    // banned don't trip the check that bans it.
    for (const file of ["features", "model", "explore", "diversify", "train"]) {
      const src = readFileSync(resolve(process.cwd(), `src/core/rank/${file}.ts`), "utf8");
      expect(src, file).not.toMatch(/Math\s*\.\s*random\s*\(/);
    }
  });

  it("and none in the repo or route either", () => {
    for (const path of ["src/storage/d1/rank-repo.ts", "src/worker/routes/rank.ts"]) {
      expect(readFileSync(resolve(process.cwd(), path), "utf8"), path).not.toMatch(/Math\s*\.\s*random\s*\(/);
    }
  });

  it("never emits a NaN weight, whatever it is fed", () => {
    const f = emptyFeatures();
    f.quality = Number.NaN; // a poisoned row must not poison the model
    const w = trainLogistic([{ features: f, label: 1 }, { features: emptyFeatures(), label: 0 }], "events");
    for (const n of FEATURE_NAMES) expect(Number.isFinite(w[n]!), n).toBe(true);
  });
});

/* ── 6. the log is bounded ───────────────────────────────────────────────────── */

describe("lock: the impression log cannot grow without bound", () => {
  it("retention is enforced by gc, not by intent", async () => {
    const ann = await mkUser("a@x.com");
    raw.prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at)
       VALUES ('e1','fp1','T','2027-01-01T18:00:00Z','America/Los_Angeles','SF','https://x/1','ch1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    ).run();
    const now = new Date("2026-07-26T00:00:00Z");
    await rank.logImpressions({
      surface: "events", viewerId: ann, modelVersion: "v0", explored: false,
      items: [{ itemId: "e1", position: 0, features: emptyFeatures() }],
      now: new Date(now.getTime() - (RETENTION_DAYS + 1) * 86_400_000),
    });
    expect(await rank.gc(RETENTION_DAYS, 5000, now)).toBe(1);
  });

  it("a viewer's impressions die with their account", async () => {
    // Deleting a user must not leave their behavioural log behind. Enforced by the FK,
    // so no cleanup job can forget to run.
    expect(migration).toMatch(/viewer_id\s+TEXT\s+NOT NULL\s+REFERENCES\s+users\(id\)\s+ON DELETE CASCADE/);
  });

  it("gc is bounded, so one tick cannot stall the cron", async () => {
    const ann = await mkUser("a@x.com");
    const mk = raw.prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at)
       VALUES (?, ?, 'T', '2027-01-01T18:00:00Z', 'America/Los_Angeles', 'SF', ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    const ids = Array.from({ length: 12 }, (_, i) => `e${i}`);
    for (const id of ids) mk.run(id, `fp-${id}`, `https://x/${id}`, `ch-${id}`);
    await rank.logImpressions({
      surface: "events", viewerId: ann, modelVersion: "v0", explored: false,
      items: ids.map((id, i) => ({ itemId: id, position: i, features: emptyFeatures() })),
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(await rank.gc(RETENTION_DAYS, 5, new Date("2026-07-26T00:00:00Z"))).toBe(5);
  });
});

/* ── 7. logged features must actually describe the candidate ─────────────────── */

describe("lock: the impression log cannot fill up with degenerate vectors", () => {
  /**
   * This closes the exact mistake that shipped once already: an endpoint that accepted
   * ids and positions from the client and stamped `emptyFeatures()` on them. It looked
   * like a working loop — rows appeared, the cron ran, the gate reported "waiting for
   * data" — but every row was all-zeros-plus-bias, so no model could ever have been
   * trained from it. The failure is invisible without a test like this.
   */
  it("a served feed logs vectors that vary with the candidate", async () => {
    const t = makeTestApp();
    const mk = (id: string, score: number, organizer: string) =>
      t.raw
        .prepare(
          `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash,
                               first_seen_at, last_seen_at, interest_score, organizer, categories)
           VALUES (?, ?, ?, '2027-01-01T18:00:00Z', 'America/Los_Angeles', 'SF', ?, ?,
                   '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?, ?, '["ai"]')`,
        )
        .run(id, `fp-${id}`, `E ${id}`, `https://x/${id}`, `ch-${id}`, score, organizer);
    mk("a", 20, "Host A");
    mk("b", 90, "Host B");

    const ann = await login(t, "ann@x.com", "Ann");
    const res = await call(t, "/api/events/foryou", { cookie: ann.cookie });
    expect(res.status).toBe(200);

    const rows = t.raw.prepare("SELECT item_id, features_json FROM rank_impressions").all() as any[];
    expect(rows).toHaveLength(2);
    const vectors = rows.map((r) => JSON.parse(r.features_json));

    // Not the empty vector: something other than the bias is set.
    for (const v of vectors) {
      const nonBias = FEATURE_NAMES.filter((n) => n !== "bias").map((n) => v[n]);
      expect(nonBias.some((x) => x !== 0)).toBe(true);
    }
    // And the two candidates are DISTINGUISHABLE — a log where every row is identical
    // carries no information however non-zero it is.
    expect(JSON.stringify(vectors[0])).not.toBe(JSON.stringify(vectors[1]));
  });

  it("an anonymous impression is unrepresentable, not merely avoided", async () => {
    // Two independent bugs, both invisible at runtime, which is why the SCHEMA forbids it
    // rather than a handler remembering to:
    //   · the row can never be labelled positive (every engagement needs an account), so
    //     it is a guaranteed negative that says nothing about interest;
    //   · its dedup_key would be shared by every logged-out visitor, so `times_shown`
    //     would accumulate across all of them and fatigue-suppress popular items for
    //     someone who had never seen them.
    expect(migration).toMatch(/viewer_id\s+TEXT\s+NOT NULL\s+REFERENCES\s+users\(id\)/);
    raw.prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at)
       VALUES ('e1','fp1','T','2027-01-01T18:00:00Z','America/Los_Angeles','SF','https://x/1','ch1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    ).run();
    await expect(
      rank.logImpressions({
        surface: "events",
        viewerId: null as any,
        modelVersion: "v0",
        explored: false,
        items: [{ itemId: "e1", position: 0, features: emptyFeatures() }],
      }),
    ).rejects.toThrow();
  });

  it("exploration never fires without a viewer to attribute it to", () => {
    // An anonymous seed is shared, so an "exploring" day would shuffle the page
    // identically for every logged-out visitor at once — a visible glitch, not a trial.
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, startUtc: "2027-01-01T18:00:00Z" }));
    for (let i = 0; i < 50; i++) {
      const out = rerank({
        items,
        toRankItem: (e) => eventToRankItem(e),
        viewer: ANON_VIEWER,
        surface: "events",
        nowMs: Date.parse("2026-07-26T12:00:00Z") + i * 86_400_000,
        explore: true,
        epsilon: 1, // would always fire if a viewer were present
        viewerId: null,
      });
      expect(out.explored).toBe(false);
    }
  });

  it("there is no client-supplied impressions endpoint to re-introduce the trap", async () => {
    const t = makeTestApp();
    const ann = await login(t, "ann@x.com", "Ann");
    const r = await call(t, "/api/rank/impressions", {
      method: "POST",
      cookie: ann.cookie,
      body: { surface: "events", items: [{ itemId: "e1", position: 0 }] },
    });
    // 404: impressions are recorded by the serving path, which is the only party that
    // knows the feature vector it scored with.
    expect(r.status).toBe(404);
  });
});

/* ── 8. code and schema agree on the surfaces ────────────────────────────────── */

describe("lock: the surface list in code matches the schema's CHECK", () => {
  it("every RANK_SURFACES value is accepted by both tables", async () => {
    // Reconciles the enum against the live schema rather than trusting two hand-kept
    // lists to stay in step — the same technique lock-schema.test.ts uses.
    for (const surface of RANK_SURFACES) {
      await expect(
        rank.saveModel({
          surface, weights: {}, rrf: {}, nRows: 0, holdoutAuc: null, incumbentAuc: null, promote: false,
        }),
      ).resolves.toBeTruthy();
    }
  });

  it("a surface the enum does not know is rejected by the schema", async () => {
    await expect(
      rank.saveModel({
        surface: "timeline" as any, weights: {}, rrf: {}, nRows: 0,
        holdoutAuc: null, incumbentAuc: null, promote: false,
      }),
    ).rejects.toThrow();
  });

  it("surfaces train and promote independently", async () => {
    // An events model must never rank news and vice versa. They share the feature vector
    // and the trainer, but an event feed and a news front page have different engagement
    // economics — one pooled model would learn their average and serve neither. Nothing
    // enforces this except `activeModel` being keyed by surface, so it is ratcheted.
    await rank.saveModel({
      surface: "events", weights: { quality: 3 }, rrf: {}, nRows: 900,
      holdoutAuc: 0.9, incumbentAuc: null, promote: true,
    });
    expect((await rank.activeModel("events"))!.weights.quality).toBe(3);
    expect(await rank.activeModel("news")).toBeNull();
    expect(await rank.activeModel("shadows")).toBeNull();
  });

  it("the labelling ladder covers every surface", async () => {
    // A surface with no ladder entry would log impressions forever and never label a
    // positive — a feed that trains exclusively on negatives.
    for (const surface of RANK_SURFACES) {
      await expect(rank.labelPending(surface, 10)).resolves.toBeTruthy();
    }
  });
});
