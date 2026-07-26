import { describe, it, expect } from "vitest";
import {
  FEATURE_NAMES,
  extractFeatures,
  emptyFeatures,
  recencyFeature,
  tagAffinityFeature,
  saturate,
  unit,
  ageHours,
  ANON_VIEWER,
  type RankItem,
  type ViewerCtx,
} from "../src/core/rank/features";
import {
  sigmoid,
  score,
  predict,
  trainLogistic,
  evaluate,
  shouldPromote,
  shouldRescore,
  sanitizeWeights,
  rowWeight,
  SEED_WEIGHTS,
  MIN_TRAINING_ROWS,
  type TrainingRow,
} from "../src/core/rank/model";
import {
  prng,
  hashSeed,
  seedFor,
  epsilonShuffle,
  positionPropensity,
  epsilonFrom,
  DEFAULT_EPSILON,
  MIN_PROPENSITY,
} from "../src/core/rank/explore";
import { diversityFactor, fatigueFactor, rescore } from "../src/core/rank/diversify";
import { sanitizeFusionWeights } from "../src/core/search/rank";

const NOW = Date.parse("2026-07-26T12:00:00Z");
const viewer = (over: Partial<ViewerCtx> = {}): ViewerCtx => ({
  tagAffinity: new Map(),
  authorAffinity: new Map(),
  checkins: 0,
  ...over,
});

/* ── features ─────────────────────────────────────────────────────────────────── */

describe("features: bounded and total", () => {
  it("every feature of every surface stays in [0,1]", () => {
    const nasty: RankItem[] = [
      { id: "a" },
      { id: "b", at: "not-a-date", quality: 99999, engagements: -5, externalPoints: 1e12 },
      { id: "c", at: "2026-07-26T12:00:00Z", quality: -100, distanceKm: -50, timesShown: -3 },
      { id: "d", at: "1999-01-01T00:00:00Z", quality: Number.NaN, engagements: Number.POSITIVE_INFINITY },
    ];
    for (const surface of ["events", "news", "shadows"] as const) {
      for (const item of nasty) {
        const f = extractFeatures(item, ANON_VIEWER, surface, NOW);
        for (const name of FEATURE_NAMES) {
          expect(Number.isFinite(f[name]), `${surface}/${item.id}/${name}`).toBe(true);
          expect(f[name], `${surface}/${item.id}/${name}`).toBeGreaterThanOrEqual(0);
          expect(f[name], `${surface}/${item.id}/${name}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("emptyFeatures has every name, and only the bias set", () => {
    const f = emptyFeatures();
    expect(Object.keys(f).sort()).toEqual([...FEATURE_NAMES].sort());
    expect(f.bias).toBe(1);
    expect(f.recency).toBe(0);
  });

  it("saturate is 0 at 0, 0.5 at the knee, and asymptotic", () => {
    expect(saturate(0, 3)).toBe(0);
    expect(saturate(3, 3)).toBeCloseTo(0.5, 10);
    expect(saturate(1e9, 3)).toBeGreaterThan(0.999);
    expect(saturate(-5, 3)).toBe(0);
    expect(saturate(Number.NaN, 3)).toBe(0);
  });

  it("unit clamps and never returns NaN", () => {
    expect(unit(Number.NaN)).toBe(0);
    expect(unit(-1)).toBe(0);
    expect(unit(2)).toBe(1);
    expect(unit(0.4)).toBe(0.4);
  });

  it("ageHours distinguishes unknown from old", () => {
    expect(ageHours(null, NOW)).toBeNull();
    expect(ageHours("garbage", NOW)).toBeNull();
    expect(ageHours("2026-07-26T11:00:00Z", NOW)).toBeCloseTo(1, 6);
  });
});

describe("features: recency runs forward for events, backward for news", () => {
  it("an event starting now beats one next month", () => {
    const soon = recencyFeature({ id: "a", at: "2026-07-26T13:00:00Z" }, "events", NOW);
    const later = recencyFeature({ id: "b", at: "2026-08-26T13:00:00Z" }, "events", NOW);
    expect(soon).toBeGreaterThan(later);
  });

  it("an event that already happened scores 0, but keeps the 6h grace", () => {
    // Two hours ago: still joinable, so still scored.
    expect(recencyFeature({ id: "a", at: "2026-07-26T10:00:00Z" }, "events", NOW)).toBeGreaterThan(0);
    // Two days ago: gone.
    expect(recencyFeature({ id: "b", at: "2026-07-24T12:00:00Z" }, "events", NOW)).toBe(0);
  });

  it("for news, fresher is better and the future is not penalised", () => {
    const fresh = recencyFeature({ id: "a", at: "2026-07-26T11:00:00Z" }, "news", NOW);
    const stale = recencyFeature({ id: "b", at: "2026-07-20T11:00:00Z" }, "news", NOW);
    expect(fresh).toBeGreaterThan(stale);
    expect(stale).toBeGreaterThan(0);
  });

  it("shadows decay far faster than news", () => {
    const at = "2026-07-26T06:00:00Z"; // 6 hours old
    expect(recencyFeature({ id: "a", at }, "shadows", NOW)).toBeLessThan(
      recencyFeature({ id: "a", at }, "news", NOW),
    );
  });

  it("an unknown date sinks rather than floating", () => {
    expect(recencyFeature({ id: "a", at: null }, "events", NOW)).toBe(0);
    expect(recencyFeature({ id: "a", at: "nope" }, "news", NOW)).toBe(0);
  });
});

describe("features: tag affinity is a mean, so tag-spam cannot win", () => {
  const v = viewer({ tagAffinity: new Map([["topic:ai", 1], ["topic:hardware", 1]]) });

  it("a focused match beats a shotgun match", () => {
    const focused = tagAffinityFeature({ id: "a", tags: ["topic:ai"] }, v);
    const shotgun = tagAffinityFeature(
      { id: "b", tags: ["topic:ai", "topic:x", "topic:y", "topic:z", "topic:w"] },
      v,
    );
    expect(focused).toBe(1);
    expect(shotgun).toBeLessThan(focused);
  });

  it("no tags, or no affinity, is 0 rather than NaN", () => {
    expect(tagAffinityFeature({ id: "a" }, v)).toBe(0);
    expect(tagAffinityFeature({ id: "a", tags: ["topic:ai"] }, ANON_VIEWER)).toBe(0);
  });

  it("an anonymous viewer falls back to global quality only", () => {
    const f = extractFeatures({ id: "a", quality: 80, tags: ["topic:ai"], authorKey: "acme" }, ANON_VIEWER, "events", NOW);
    expect(f.quality).toBeCloseTo(0.8, 10);
    expect(f.tagAffinity).toBe(0);
    expect(f.authorAffinity).toBe(0);
  });
});

/* ── model ────────────────────────────────────────────────────────────────────── */

describe("model: arithmetic is stable", () => {
  it("sigmoid saturates instead of overflowing", () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 10);
    expect(sigmoid(1e6)).toBeCloseTo(1, 10);
    expect(sigmoid(-1e6)).toBeCloseTo(0, 10);
    expect(Number.isFinite(sigmoid(Number.NaN))).toBe(true);
  });

  it("a weight the model has never heard of contributes nothing", () => {
    const f = emptyFeatures();
    f.quality = 1;
    expect(score(f, { quality: 2 })).toBe(2);
    expect(score(f, {})).toBe(0); // no opinion → no contribution, not a crash
    expect(predict(f, {})).toBeCloseTo(0.5, 10);
  });

  it("sanitizeWeights drops unknown keys and non-finite values", () => {
    const w = sanitizeWeights({ quality: 1.5, bogus: 9, recency: Number.NaN, bias: "x" });
    expect(w).toEqual({ quality: 1.5 });
  });

  it("rowWeight is inverse-propensity, clamped", () => {
    expect(rowWeight("open", 1)).toBe(1);
    expect(rowWeight("checkin", 1)).toBe(25);
    // A deep-rank engagement is upweighted, but the clamp stops it dominating.
    expect(rowWeight("checkin", 0.02)).toBe(50);
    expect(rowWeight("nonsense", 1)).toBe(1);
  });
});

describe("model: training actually learns, and does so deterministically", () => {
  /** Rows where `quality` alone decides the label. */
  const rows: TrainingRow[] = [];
  for (let i = 0; i < 200; i++) {
    const high = i % 2 === 0;
    const f = emptyFeatures();
    f.quality = high ? 0.9 : 0.1;
    f.recency = 0.5;
    rows.push({ features: f, label: high ? 1 : 0 });
  }

  it("separates a learnable signal", () => {
    const w = trainLogistic(rows, "events");
    const before = evaluate(rows, { bias: 0 });
    const after = evaluate(rows, w);
    expect(after.auc).toBeGreaterThan(0.9);
    expect(after.auc).toBeGreaterThan(before.auc);
    expect(w.quality!).toBeGreaterThan(SEED_WEIGHTS.events.quality!);
  });

  it("is deterministic — identical rows give byte-identical weights", () => {
    expect(trainLogistic(rows, "events")).toEqual(trainLogistic(rows, "events"));
  });

  it("does not depend on row order (full-batch, not stochastic)", () => {
    const a = trainLogistic(rows, "events");
    const b = trainLogistic([...rows].reverse(), "events");
    for (const n of FEATURE_NAMES) expect(b[n]!).toBeCloseTo(a[n]!, 9);
  });

  it("no training data returns the prior untouched, not NaN", () => {
    const w = trainLogistic([], "news");
    for (const n of FEATURE_NAMES) expect(Number.isFinite(w[n]!)).toBe(true);
    expect(w.recency).toBe(SEED_WEIGHTS.news.recency);
  });

  it("survives a pathological training set without emitting NaN weights", () => {
    const f = emptyFeatures();
    f.quality = 1;
    const w = trainLogistic(
      [
        { features: f, label: 1, weight: 1e9 },
        { features: f, label: 0, weight: 1e9 },
      ],
      "events",
    );
    for (const n of FEATURE_NAMES) expect(Number.isFinite(w[n]!)).toBe(true);
  });
});

describe("model: evaluate reports the truth about ordering", () => {
  const mk = (quality: number, label: 0 | 1): TrainingRow => {
    const f = emptyFeatures();
    f.quality = quality;
    return { features: f, label };
  };

  it("a perfect ranking is 1 and an inverted one is 0", () => {
    const rows = [mk(1, 1), mk(0.9, 1), mk(0.1, 0), mk(0, 0)];
    expect(evaluate(rows, { quality: 1 }).auc).toBe(1);
    expect(evaluate(rows, { quality: -1 }).auc).toBe(0);
  });

  it("a model that orders nothing reports 0.5, not 1", () => {
    // This is the trap: counting ties as wins makes an untrained model look perfect.
    const rows = [mk(1, 1), mk(0.5, 0)];
    expect(evaluate(rows, { bias: 3 }).auc).toBe(0.5);
  });

  it("a single-class slice is 0.5 and therefore ungatable", () => {
    expect(evaluate([mk(1, 1), mk(0.5, 1)], { quality: 1 }).auc).toBe(0.5);
  });
});

describe("model: the promotion gate is the safety property", () => {
  const good = { auc: 0.8, logLoss: 0.4, n: 5000, positives: 500 };

  it("promotes a clear winner when there is no incumbent", () => {
    expect(shouldPromote(good, null).promote).toBe(true);
  });

  it("REJECTS a worse model than the incumbent", () => {
    const d = shouldPromote(good, { auc: 0.85, logLoss: 0.3, n: 5000, positives: 500 });
    expect(d.promote).toBe(false);
    expect(d.reason).toMatch(/no gain/);
  });

  it("rejects a tie — churning the live model on noise is its own failure", () => {
    expect(shouldPromote(good, { ...good }).promote).toBe(false);
  });

  it("rejects on too little data however good the number looks", () => {
    const d = shouldPromote({ auc: 0.99, logLoss: 0.1, n: 10, positives: 5 }, null);
    expect(d.promote).toBe(false);
    expect(d.reason).toMatch(/too few rows/);
  });

  it("rejects when there are rows but almost no positives", () => {
    const d = shouldPromote({ auc: 0.99, logLoss: 0.1, n: MIN_TRAINING_ROWS + 1, positives: 2 }, null);
    expect(d.promote).toBe(false);
    expect(d.reason).toMatch(/too few positives/);
  });

  it("rejects a coin flip even with no incumbent to beat", () => {
    expect(shouldPromote({ auc: 0.5, logLoss: 0.7, n: 9000, positives: 900 }, null).promote).toBe(false);
  });

  it("rejects a non-finite auc", () => {
    expect(shouldPromote({ auc: Number.NaN, logLoss: 0, n: 9000, positives: 900 }, null).promote).toBe(false);
  });
});

describe("model: cold start is a passthrough, not a guess", () => {
  it("no model means no rescoring at all", () => {
    expect(shouldRescore(null)).toBe(false);
    expect(shouldRescore(undefined)).toBe(false);
    expect(shouldRescore({ weights: {} })).toBe(false);
  });

  it("an all-zero weight vector is still a passthrough", () => {
    expect(shouldRescore({ weights: { quality: 0, recency: 0 } })).toBe(false);
  });

  it("a trained model rescores", () => {
    expect(shouldRescore({ weights: { quality: 0.3 } })).toBe(true);
  });

  it("SEED_WEIGHTS are a training prior and never a serving fallback", () => {
    // Every surface has a prior...
    for (const s of ["events", "news", "shadows"] as const) {
      expect(Object.keys(SEED_WEIGHTS[s]).length).toBeGreaterThan(0);
    }
    // ...and every key in it is a real feature name.
    for (const s of ["events", "news", "shadows"] as const) {
      for (const k of Object.keys(SEED_WEIGHTS[s])) {
        expect(FEATURE_NAMES as readonly string[]).toContain(k);
      }
    }
  });
});

/* ── exploration ──────────────────────────────────────────────────────────────── */

describe("explore: randomness is seeded, never ambient", () => {
  it("the same seed gives the same stream", () => {
    const a = prng(42);
    const b = prng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("different seeds diverge", () => {
    expect(prng(1)()).not.toBe(prng(2)());
  });

  it("values stay in [0,1)", () => {
    const r = prng(hashSeed("the-bay"));
    for (let i = 0; i < 500; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("the seed is stable within a day and changes across days", () => {
    const day1 = seedFor("events", "u1", Date.parse("2026-07-26T01:00:00Z"));
    const day1Later = seedFor("events", "u1", Date.parse("2026-07-26T23:00:00Z"));
    const day2 = seedFor("events", "u1", Date.parse("2026-07-27T01:00:00Z"));
    expect(day1).toBe(day1Later); // a refresh must not reshuffle the feed
    expect(day1).not.toBe(day2);
  });
});

describe("explore: epsilonShuffle", () => {
  const ranked = Array.from({ length: 20 }, (_, i) => `i${i}`);

  it("epsilon 0 never explores and never reorders", () => {
    const r = epsilonShuffle(ranked, "events", "u1", NOW, { epsilon: 0 });
    expect(r.explored).toBe(false);
    expect(r.items).toEqual(ranked);
  });

  it("epsilon 1 always explores and shuffles only the head", () => {
    const r = epsilonShuffle(ranked, "events", "u1", NOW, { epsilon: 1, window: 5, seed: 7 });
    expect(r.explored).toBe(true);
    expect(r.items.slice(5)).toEqual(ranked.slice(5)); // the tail is untouched
    expect(new Set(r.items)).toEqual(new Set(ranked)); // a permutation, nothing lost
  });

  it("never drops or duplicates an item", () => {
    for (let seed = 0; seed < 40; seed++) {
      const r = epsilonShuffle(ranked, "events", "u1", NOW, { epsilon: 1, seed });
      expect(r.items).toHaveLength(ranked.length);
      expect(new Set(r.items).size).toBe(ranked.length);
    }
  });

  it("explores roughly epsilon of renders", () => {
    let explored = 0;
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      if (epsilonShuffle(ranked, "events", `u${i}`, NOW, { epsilon: 0.1 }).explored) explored++;
    }
    expect(explored / trials).toBeGreaterThan(0.05);
    expect(explored / trials).toBeLessThan(0.16);
  });

  it("a list too short to shuffle is returned untouched", () => {
    expect(epsilonShuffle(["only"], "events", "u1", NOW, { epsilon: 1 }).items).toEqual(["only"]);
  });
});

describe("explore: the epsilon dial", () => {
  it("defaults ON when unset, blank or unparseable", () => {
    // Failing open matters: a typo in a config value must not silently stop the loop
    // learning, which is a failure nobody would ever see.
    for (const v of [undefined, null, "", "abc", "NaN"]) {
      expect(epsilonFrom(v as any), String(v)).toBe(DEFAULT_EPSILON);
    }
  });

  it('only an explicit "0" turns exploration off', () => {
    expect(epsilonFrom("0")).toBe(0);
    expect(epsilonFrom("0.0")).toBe(0);
  });

  it("clamps out-of-range values instead of trusting them", () => {
    expect(epsilonFrom("5")).toBe(1);
    expect(epsilonFrom("-1")).toBe(0);
    expect(epsilonFrom("0.25")).toBe(0.25);
  });
});

describe("explore: position propensity", () => {
  it("decreases with depth", () => {
    expect(positionPropensity(0)).toBe(1);
    expect(positionPropensity(1)).toBeLessThan(positionPropensity(0));
    expect(positionPropensity(9)).toBeLessThan(positionPropensity(1));
  });

  it("is floored, so IPW weights cannot explode", () => {
    expect(positionPropensity(100_000)).toBe(MIN_PROPENSITY);
    expect(1 / positionPropensity(100_000)).toBe(50);
  });

  it("is total for nonsense input", () => {
    expect(positionPropensity(Number.NaN)).toBe(1);
    expect(positionPropensity(-5)).toBe(1);
  });
});

/* ── learned fusion weights ───────────────────────────────────────────────────── */

describe("sanitizeFusionWeights: a stored blob can never poison the fusion", () => {
  it("keeps the known list names", () => {
    expect(sanitizeFusionWeights({ bm25: 2, vector: 0.5, recency: 1, quality: 0.1 })).toEqual({
      bm25: 2, vector: 0.5, recency: 1, quality: 0.1,
    });
  });

  it("drops unknown keys, NaN, and non-numbers", () => {
    expect(sanitizeFusionWeights({ bm25: 1, social: 5, vector: Number.NaN, quality: "1" })).toEqual({ bm25: 1 });
  });

  it("is total for garbage input", () => {
    for (const junk of [null, undefined, "nope", 42, []]) {
      expect(sanitizeFusionWeights(junk)).toEqual({});
    }
  });

  it("an empty result means fuse() falls back to the hand-tuned defaults", () => {
    // `fuse` spreads DEFAULT_WEIGHTS under whatever it is given, so {} is the passthrough.
    expect(Object.keys(sanitizeFusionWeights({}))).toHaveLength(0);
  });
});

/* ── listwise rescoring ───────────────────────────────────────────────────────── */

describe("diversify: repeats decay to a floor rather than falling off a cliff", () => {
  it("the first from a host is undiscounted", () => {
    expect(diversityFactor(0)).toBe(1);
  });

  it("later ones decay monotonically toward the floor", () => {
    const f = [0, 1, 2, 3, 10].map((i) => diversityFactor(i));
    for (let i = 1; i < f.length; i++) expect(f[i]!).toBeLessThan(f[i - 1]!);
    expect(f.at(-1)!).toBeGreaterThanOrEqual(0.25);
  });

  it("matches the published formula exactly", () => {
    expect(diversityFactor(1, 0.5, 0.25)).toBeCloseTo(0.625, 10);
    expect(diversityFactor(2, 0.5, 0.25)).toBeCloseTo(0.4375, 10);
  });

  it("fatigue halves per prior impression", () => {
    expect(fatigueFactor(0)).toBe(1);
    expect(fatigueFactor(1)).toBe(1);
    expect(fatigueFactor(2)).toBe(0.5);
    expect(fatigueFactor(4)).toBe(0.125);
    expect(fatigueFactor(null)).toBe(1);
  });

  it("rescore demotes a host's repeats without erasing them", () => {
    const out = rescore([
      { id: "a", score: 1.0, groupKey: "acme" },
      { id: "b", score: 0.95, groupKey: "acme" },
      { id: "c", score: 0.9, groupKey: "acme" },
      { id: "d", score: 0.8, groupKey: "other" },
    ]);
    // The single event from `other` climbs past acme's third.
    expect(out.map((r) => r.id)).toEqual(["a", "d", "b", "c"]);
    // But acme's third is still on the page, not dropped.
    expect(out.find((r) => r.id === "c")!.score).toBeGreaterThan(0);
  });

  it("items with no group key are never discounted for diversity", () => {
    const out = rescore([
      { id: "a", score: 1, groupKey: null },
      { id: "b", score: 1, groupKey: null },
    ]);
    expect(out.every((r) => r.rescoreFactor === 1)).toBe(true);
  });

  it("already-seen items sink", () => {
    const out = rescore([
      { id: "seen", score: 1, timesShown: 4 },
      { id: "fresh", score: 0.5, timesShown: 1 },
    ]);
    expect(out[0]!.id).toBe("fresh");
  });

  it("ties break on id so paging is stable", () => {
    const a = rescore([{ id: "b", score: 1 }, { id: "a", score: 1 }]);
    const b = rescore([{ id: "a", score: 1 }, { id: "b", score: 1 }]);
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });
});
