/**
 * The feature vector — the one contract between serving and training.
 *
 * Three rules, each of which exists because breaking it produces a silently bad
 * model rather than an error:
 *
 *   1. EVERY FEATURE IS BOUNDED to [0, 1]. Logistic regression on unbounded inputs
 *      is dominated by whichever feature happens to have the largest units, and one
 *      2000-point Hacker News story would otherwise decide the whole weight vector.
 *      `saturate` (the same curve `src/core/xp/stats.ts` uses for founder axes) is how
 *      counts become bounded without a cliff.
 *   2. EVERY FUNCTION IS TOTAL. No input — NaN, a garbage date, a null, a negative
 *      count — may produce NaN. A NaN in a feature vector poisons the gradient and
 *      then every subsequent prediction, and unlike a crash it leaves no trace.
 *   3. `bias` IS A FEATURE. Carrying the intercept in the vector means the trainer,
 *      the scorer and the persisted weights all agree on one shape, with no special
 *      case for "and also add b".
 *
 * X's heavy ranker consumes ~6,000 features and hand-engineers none of them. We have
 * twelve and hand-engineer all of them, because at our data volume the model cannot
 * afford to discover what a date means — it has enough to do learning how much a date
 * matters. That trade flips somewhere around 10^6 labelled impressions.
 */
import type { RankSurface } from "../../../shared/schema";

/**
 * The feature names, in a fixed order. Persisted weight vectors are keyed by these
 * strings, so ADDING one is safe (an old model simply has no opinion about it and it
 * scores 0) but RENAMING one silently orphans a trained weight. `tests/lock-rank.test.ts`
 * ratchets this list against every stored model.
 */
export const FEATURE_NAMES = [
  "bias",
  "recency",
  "quality",
  "tagAffinity",
  "authorAffinity",
  "friendEngaged",
  "socialProof",
  "externalPoints",
  "novelty",
  "proximity",
  "isFree",
  "viewerHistory",
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureVector = Record<FeatureName, number>;

/** Half-lives (hours) for the `recency` feature, per surface. A conference next week
 *  is still interesting; a shadow from this morning already isn't. */
export const RECENCY_HALF_LIFE: Record<RankSurface, number> = {
  events: 24 * 7, // a week out still reads as "soon"
  news: 12, // the news cycle, matching src/news/rank.ts's gravity in spirit
  shadows: 3, // the live board is about right now
};

/** Counts at which a signal is "half as good as it can get" — the `saturate` knees. */
export const HALF = {
  friends: 3, // three friends going is a strong signal; the tenth adds little
  social: 25, // total RSVPs / votes
  external: 100, // HN-style points
  history: 8, // verified check-ins before we claim to know someone's taste
} as const;

/** Saturating curve: 0 at 0, 0.5 at n = half, asymptotic to 1. Total for any input. */
export function saturate(n: number, half: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (!Number.isFinite(half) || half <= 0) return 1;
  return n / (n + half);
}

/** Clamp anything to [0, 1]. NaN and non-numbers become 0, never NaN. */
export function unit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** What a surface must adapt its rows into. Deliberately small: anything that needs a
 *  query per candidate does not belong in a feature. */
export interface RankItem {
  id: string;
  /** For events, when it STARTS (the future matters). For news/shadows, when it was
   *  created (the past decays). `null` when unknown, which scores 0 rather than now. */
  at?: string | null;
  /** Global 0–100 quality — `events.interest_score`, or a per-surface equivalent. */
  quality?: number | null;
  /** Tag ids (`facet:slug`) or topic slugs. */
  tags?: readonly string[];
  /** Who made this: organizer, story author, shadow author. */
  authorKey?: string | null;
  /** Total engagement we've recorded (RSVPs, votes, reactions). */
  engagements?: number | null;
  /** Of those, how many came from the viewer's accepted friends. */
  friendEngagements?: number | null;
  /** The score this item has on the source it was aggregated from. */
  externalPoints?: number | null;
  isFree?: boolean | null;
  distanceKm?: number | null;
  /** How many times this viewer has already been shown this item. */
  timesShown?: number | null;
}

/** Per-viewer state, built once per request — never per candidate. */
export interface ViewerCtx {
  /** tag id → affinity in [0, 1]. */
  tagAffinity: ReadonlyMap<string, number>;
  /** author/organizer key → affinity in [0, 1]. */
  authorAffinity: ReadonlyMap<string, number>;
  /** Verified check-ins. How much we actually know about this person's taste. */
  checkins: number;
}

/** A signed-out viewer. Personalized features go to 0, so the model falls back to
 *  global quality — which is the correct behaviour, not a degraded one. */
export const ANON_VIEWER: ViewerCtx = Object.freeze({
  tagAffinity: new Map<string, number>(),
  authorAffinity: new Map<string, number>(),
  checkins: 0,
});

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Hours between `iso` and `nowMs`. Positive = in the past. `null` when unparseable,
 *  so callers can distinguish "old" from "we don't know". */
export function ageHours(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 3_600_000;
}

/**
 * Recency, in [0, 1].
 *
 * For `events` the axis runs FORWARD: an event starting soon scores high, one further
 * out decays, and one that already happened scores 0 — with the same 6h grace the rest
 * of the app uses (`byRecency` in `src/core/search/rank.ts`), because an event that
 * started an hour ago is still joinable.
 *
 * For `news` and `shadows` the axis runs BACKWARD: fresh is good, old decays.
 */
export function recencyFeature(item: RankItem, surface: RankSurface, nowMs: number): number {
  const age = ageHours(item.at, nowMs);
  if (age === null) return 0; // unknown date sinks; it must not float to the top
  const halfLife = RECENCY_HALF_LIFE[surface];

  if (surface === "events") {
    const hoursUntil = -age;
    if (hoursUntil < -6) return 0; // already happened, past the grace window
    // Starting now is the peak; further out decays on the surface's half-life.
    return unit(Math.pow(0.5, Math.max(0, hoursUntil) / halfLife));
  }
  return unit(Math.pow(0.5, Math.max(0, age) / halfLife));
}

/**
 * Tag affinity: how much of this item's tag set the viewer actually cares about.
 *
 * The MEAN of the matched affinities rather than the sum, so a broadly-tagged event
 * can't win by tagging everything — which is exactly the engagement-bait failure mode
 * that a sum would reward.
 */
export function tagAffinityFeature(item: RankItem, viewer: ViewerCtx): number {
  const tags = item.tags;
  if (!tags?.length || viewer.tagAffinity.size === 0) return 0;
  let sum = 0;
  let n = 0;
  for (const t of tags) {
    if (typeof t !== "string" || !t) continue;
    n++;
    sum += unit(num(viewer.tagAffinity.get(t.toLowerCase()) ?? viewer.tagAffinity.get(t)));
  }
  return n === 0 ? 0 : unit(sum / n);
}

/**
 * Extract the full vector.
 *
 * Pure and total: same inputs, same output; no clock, no I/O, no throw.
 */
export function extractFeatures(
  item: RankItem,
  viewer: ViewerCtx,
  surface: RankSurface,
  nowMs: number,
): FeatureVector {
  const author = item.authorKey;
  return {
    bias: 1,
    recency: recencyFeature(item, surface, nowMs),
    quality: unit(num(item.quality) / 100),
    tagAffinity: tagAffinityFeature(item, viewer),
    authorAffinity: author ? unit(num(viewer.authorAffinity.get(author))) : 0,
    friendEngaged: saturate(num(item.friendEngagements), HALF.friends),
    socialProof: saturate(num(item.engagements), HALF.social),
    externalPoints: saturate(num(item.externalPoints), HALF.external),
    // Fresh-to-this-viewer. The 4th time we show something, it is 12% as novel.
    novelty: unit(Math.pow(0.5, Math.max(0, num(item.timesShown) - 1))),
    // 1 at the door, decaying over ~10km. Unknown distance is neutral-ish, not zero:
    // most of our events have no coordinates yet and shouldn't all be penalized.
    proximity:
      item.distanceKm == null || !Number.isFinite(item.distanceKm)
        ? 0.5
        : unit(Math.pow(0.5, Math.max(0, item.distanceKm) / 10)),
    isFree: item.isFree === true ? 1 : 0,
    viewerHistory: saturate(viewer.checkins, HALF.history),
  };
}

/** A zero vector with the bias set — the shape, for tests and for empty candidates. */
export function emptyFeatures(): FeatureVector {
  const v = {} as FeatureVector;
  for (const n of FEATURE_NAMES) v[n] = 0;
  v.bias = 1;
  return v;
}
