/**
 * The learned ranker: logistic regression over the twelve features, plus the training
 * and evaluation it takes to trust one.
 *
 * WHY LOGISTIC REGRESSION AND NOT SOMETHING FASHIONABLE. X's heavy ranker is a ~48M
 * parameter MaskNet, and their 2026 stack replaced it with a transformer. Both need on
 * the order of 10^8–10^9 labelled impressions; a model that large fitted to 10^4 rows
 * memorizes noise and reports excellent training loss while doing it. The published
 * rule of thumb is ~10^4 labelled impressions per objective before a linear model beats
 * a well-tuned formula, and ~10^6 before a neural net beats the linear model. This repo
 * is at zero. So: twelve weights, full-batch gradient descent, trains in milliseconds
 * inside a Worker, and every weight is a number an operator can read and argue with.
 *
 * WHAT WE TOOK FROM X. Not the model — the discipline around it:
 *   · the final score is a weighted sum of predicted engagement probabilities;
 *   · rare-but-meaningful engagements are weighted UP so they aren't drowned by common
 *     weak ones (their `report` weight is −369 because P(report) ≈ 10^-5, not because a
 *     report is 738× worse than a like). Here that lands in `LABEL_WEIGHT`.
 *
 * WHAT WE ADDED, because X's released code has none of it: inverse propensity
 * weighting, and an evaluation gate that must be passed before a model goes live.
 *
 * Everything here is PURE and DETERMINISTIC — full-batch gradient descent, fixed
 * iteration order, no shuffling, no `Math.random`. Same rows in, same weights out,
 * forever. That is what makes an unattended training cron debuggable after the fact.
 */
import type { RankSurface } from "../../../shared/schema";
import { FEATURE_NAMES, type FeatureName, type FeatureVector } from "./features";

/** A trained model. Partial on purpose: a model trained before a feature existed simply
 *  has no opinion about it, and a missing weight scores 0 rather than crashing. */
export type Weights = Partial<Record<FeatureName, number>>;

/**
 * How much one engagement kind counts as evidence, relative to the most common one.
 *
 * This is X's equal-average-mass idea applied where it actually fits our shape: we
 * predict ONE pooled "engaged" label, so the per-kind importance has to live in the row
 * weight instead of in a per-task output weight. Roughly inverse to how often each kind
 * happens, which means a verified physical check-in — the rarest and by far the most
 * meaningful thing a person can do here — is not outvoted by a hundred cheap taps.
 */
export const LABEL_WEIGHT: Record<string, number> = {
  open: 1, // opened the detail view. Common, weak.
  reaction: 3,
  vote: 4,
  rsvp: 8,
  comment: 10,
  checkin: 25, // physically turned up, QR-verified. The ground truth.
  dismiss: 3, // an explicit negative, and rarer than an implicit one
  none: 1, // shown, ignored — the ordinary negative
};

/** Clamp a row weight so one exotic label can't dominate a small training set. */
const MAX_ROW_WEIGHT = 50;

export interface TrainingRow {
  features: FeatureVector;
  /** 1 = engaged, 0 = shown and not engaged. */
  label: 0 | 1;
  /** Combined importance: label kind × inverse propensity. Defaults to 1. */
  weight?: number;
}

export interface TrainOpts {
  /** L2 penalty. Small data overfits fast, so this is deliberately not tiny. */
  l2?: number;
  epochs?: number;
  learningRate?: number;
  /** Starting point. Defaults to `SEED_WEIGHTS[surface]`. */
  init?: Weights;
}

export const DEFAULT_TRAIN: Required<Omit<TrainOpts, "init">> = {
  l2: 0.01,
  epochs: 300,
  learningRate: 0.5,
};

/**
 * Where training starts.
 *
 * These are a PRIOR, not a pretend-model: they encode the direction each feature is
 * believed to point, taken from the hand-tuned constants this repo already ships
 * (`src/news/rank.ts`'s interest boost and network-vote weight, `byQuality`'s reliance
 * on `interest_score`). Training moves them; starting from zero would just make the
 * first few hundred rows decide the signs at random.
 *
 * NOTE these are NOT used as a serving fallback. Until a model has been trained AND has
 * beaten the incumbent on a holdout, the rescoring stage is skipped entirely and the
 * feed behaves exactly as it does today. See `shouldRescore`.
 */
export const SEED_WEIGHTS: Record<RankSurface, Weights> = {
  events: {
    bias: -2, // engagement is the rare case; start pessimistic
    recency: 1.2,
    quality: 0.8,
    tagAffinity: 1.0,
    authorAffinity: 0.6,
    friendEngaged: 1.4, // the local-network advantage a global site can't have
    socialProof: 0.5,
    novelty: 0.4,
    proximity: 0.3,
    isFree: 0.2,
    viewerHistory: 0,
  },
  news: {
    bias: -2,
    recency: 1.8, // matches GRAVITY's steepness in spirit
    quality: 0.4,
    tagAffinity: 0.35, // = INTEREST_BOOST. Modest on purpose: a filter bubble is a
    authorAffinity: 0.3, //  worse failure than a slightly off-topic front page.
    friendEngaged: 2.0, // = NETWORK_VOTE_WEIGHT
    socialProof: 0.6,
    externalPoints: 0.5, // = EXTERNAL_POINT_WEIGHT
    novelty: 0.5,
    viewerHistory: 0,
  },
  shadows: {
    bias: -2,
    recency: 2.5, // the live board is almost entirely about right now
    friendEngaged: 1.5,
    socialProof: 0.4,
    novelty: 0.8,
    proximity: 1.2, // a shadow two blocks away beats one across the Bay
    authorAffinity: 0.5,
  },
};

/** Numerically stable logistic. Saturates rather than overflowing at large |x|. */
export function sigmoid(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x >= 0) {
    const e = Math.exp(-Math.min(x, 60));
    return 1 / (1 + e);
  }
  const e = Math.exp(Math.max(x, -60));
  return e / (1 + e);
}

/** The linear score (log-odds). Missing weights contribute nothing. */
export function score(f: FeatureVector, w: Weights): number {
  let s = 0;
  for (const name of FEATURE_NAMES) {
    const weight = w[name];
    if (weight === undefined || !Number.isFinite(weight)) continue;
    const value = f[name];
    if (!Number.isFinite(value)) continue;
    s += weight * value;
  }
  return Number.isFinite(s) ? s : 0;
}

/** P(engage). Always in (0, 1). */
export function predict(f: FeatureVector, w: Weights): number {
  return sigmoid(score(f, w));
}

/** Row importance: label kind × inverse propensity, clamped. */
export function rowWeight(labelKind: string | null | undefined, propensity: number): number {
  const base = LABEL_WEIGHT[labelKind ?? "none"] ?? 1;
  const p = Number.isFinite(propensity) && propensity > 0 && propensity <= 1 ? propensity : 1;
  return Math.min(MAX_ROW_WEIGHT, base / p);
}

/**
 * Full-batch gradient descent on the weighted log-loss, with L2 on everything but the
 * bias (regularizing the intercept just biases the base rate toward 0.5 for no reason).
 *
 * Full-batch rather than stochastic precisely because it is order-independent: no
 * shuffle, no seed, no "why did last night's run differ". At our row counts the cost
 * difference is irrelevant.
 */
export function trainLogistic(rows: readonly TrainingRow[], surface: RankSurface, opts: TrainOpts = {}): Weights {
  const { l2, epochs, learningRate } = { ...DEFAULT_TRAIN, ...opts };
  const init = opts.init ?? SEED_WEIGHTS[surface];
  const w: Record<FeatureName, number> = {} as Record<FeatureName, number>;
  for (const n of FEATURE_NAMES) w[n] = Number.isFinite(init[n] as number) ? (init[n] as number) : 0;

  if (!rows.length) return { ...w };

  let totalWeight = 0;
  for (const r of rows) totalWeight += Math.max(0, r.weight ?? 1);
  if (totalWeight <= 0) return { ...w };

  const grad = {} as Record<FeatureName, number>;
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (const n of FEATURE_NAMES) grad[n] = 0;

    for (const r of rows) {
      const rw = Math.max(0, r.weight ?? 1);
      if (rw === 0) continue;
      const err = (predict(r.features, w) - r.label) * rw;
      for (const n of FEATURE_NAMES) {
        const v = r.features[n];
        if (Number.isFinite(v) && v !== 0) grad[n] += err * v;
      }
    }

    for (const n of FEATURE_NAMES) {
      let g = grad[n] / totalWeight;
      if (n !== "bias") g += l2 * w[n];
      const next = w[n] - learningRate * g;
      // A diverged run must not persist Infinity as a weight.
      w[n] = Number.isFinite(next) ? next : w[n];
    }
  }
  return { ...w };
}

export interface Evaluation {
  /** Area under the ROC curve. 0.5 = coin flip. The promotion metric. */
  auc: number;
  logLoss: number;
  n: number;
  positives: number;
}

/**
 * Rank-based AUC (Mann–Whitney U), tie-aware.
 *
 * Ties matter more than they look: before a model has learned anything, most candidates
 * score identically, and counting a tie as a win would report a confident 1.0 for a
 * model that orders nothing. Ties count as half, which reports 0.5 — the truth.
 *
 * Deliberately UNWEIGHTED: AUC answers "does this order things correctly", and folding
 * importance weights into it would let the gate be passed by getting a handful of
 * heavily-weighted rows right.
 */
export function evaluate(rows: readonly TrainingRow[], w: Weights): Evaluation {
  const scored = rows.map((r) => ({ s: score(r.features, w), y: r.label }));
  const pos = scored.filter((r) => r.y === 1);
  const neg = scored.filter((r) => r.y === 0);

  let logLoss = 0;
  for (const r of rows) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, predict(r.features, w)));
    logLoss += r.label === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  logLoss = rows.length ? logLoss / rows.length : 0;

  // With only one class present, AUC is undefined. 0.5 is the honest answer, and it
  // also means such a slice can never pass the promotion gate.
  if (!pos.length || !neg.length) {
    return { auc: 0.5, logLoss, n: rows.length, positives: pos.length };
  }

  let wins = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p.s > n.s) wins += 1;
      else if (p.s === n.s) wins += 0.5;
    }
  }
  return { auc: wins / (pos.length * neg.length), logLoss, n: rows.length, positives: pos.length };
}

/* ── the promotion gate ──────────────────────────────────────────────────────── */

/**
 * Minimum LABELLED rows in total before a training run is attempted at all. Applied by
 * `trainSurface` to the whole dataset, not by the gate — the gate sees only the holdout.
 * (Conflating the two is an easy and silent mistake: a 20% holdout of a 700-row set is
 * 140 rows, which would fail a 500-row threshold forever.)
 */
export const MIN_TRAINING_ROWS = 500;
/** Minimum rows in the EVALUATION slice for its AUC to mean anything. Below this, the
 *  score mostly measures which rows happened to land in the holdout. */
export const MIN_HOLDOUT_ROWS = 100;
/** And at least this many positives in it — a holdout of pure negatives teaches nothing. */
export const MIN_POSITIVES = 20;
/** A candidate must beat the incumbent by this much, not merely tie it. Churning the
 *  live model on noise is its own failure mode. */
export const MIN_AUC_GAIN = 0.01;
/** Never promote a model that is barely better than a coin flip, even if the incumbent
 *  is worse still. */
export const MIN_ABSOLUTE_AUC = 0.55;

export interface PromotionDecision {
  promote: boolean;
  reason: string;
}

/**
 * Should this candidate go live?
 *
 * This is the single most important function in the feature. An unattended cron that
 * promotes whatever it just trained will, on some bad night, promote a model that
 * ranks by noise — and nobody finds out, because a recommendation feed has no obvious
 * "wrong". Every condition below is a way that has happened to someone.
 */
export function shouldPromote(
  candidate: Evaluation,
  incumbent: Evaluation | null,
  opts: { minRows?: number; minPositives?: number; minGain?: number; minAuc?: number } = {},
): PromotionDecision {
  // `candidate` is the evaluation on the HOLDOUT, so every threshold here is about the
  // holdout. The training-set size is checked separately, before training starts.
  const minRows = opts.minRows ?? MIN_HOLDOUT_ROWS;
  const minPositives = opts.minPositives ?? MIN_POSITIVES;
  const minGain = opts.minGain ?? MIN_AUC_GAIN;
  const minAuc = opts.minAuc ?? MIN_ABSOLUTE_AUC;

  if (candidate.n < minRows) return { promote: false, reason: `too few rows (${candidate.n} < ${minRows})` };
  if (candidate.positives < minPositives)
    return { promote: false, reason: `too few positives (${candidate.positives} < ${minPositives})` };
  if (!Number.isFinite(candidate.auc)) return { promote: false, reason: "candidate auc is not finite" };
  if (candidate.auc < minAuc) return { promote: false, reason: `auc ${candidate.auc.toFixed(3)} < ${minAuc}` };
  if (incumbent && candidate.auc < incumbent.auc + minGain)
    return {
      promote: false,
      reason: `no gain over incumbent (${candidate.auc.toFixed(3)} vs ${incumbent.auc.toFixed(3)})`,
    };
  return { promote: true, reason: `auc ${candidate.auc.toFixed(3)}` };
}

/**
 * Whether to apply the learned rescore at all.
 *
 * Cold start is a PASSTHROUGH, not a seeded model: with no promoted weights the feed is
 * ordered exactly as it is today, by RRF fusion alone. This is what makes shipping the
 * whole loop safe on day one — the learning machinery is inert until it has earned its
 * place, and `SEED_WEIGHTS` never reaches production as a guess.
 */
export function shouldRescore(model: { weights: Weights } | null | undefined): boolean {
  if (!model) return false;
  return FEATURE_NAMES.some((n) => Number.isFinite(model.weights[n] as number) && model.weights[n] !== 0);
}

/** Keep only known feature names, drop anything non-finite. Applied on read, so a
 *  hand-edited or older `weights_json` can never inject a key the scorer would ignore
 *  silently or a NaN it would propagate. */
export function sanitizeWeights(raw: unknown): Weights {
  const out: Weights = {};
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const n of FEATURE_NAMES) {
    const v = obj[n];
    if (typeof v === "number" && Number.isFinite(v)) out[n] = v;
  }
  return out;
}
