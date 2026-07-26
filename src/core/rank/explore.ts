/**
 * Exploration and position-bias correction — the two things that keep an unattended
 * learning loop from eating itself.
 *
 * THE PROBLEM. A ranker trained on its own logs learns its own prior. If the model puts
 * an item at rank 40, nobody scrolls that far, so it gets no engagement, so the next
 * training round confirms it belongs at rank 40. Nothing in the loop can ever discover
 * it was wrong, and the feed narrows until it is showing one kind of thing to everyone.
 * X's released code contains no mechanism for this at all — they can afford to absorb
 * the bias and out-scale it. We cannot.
 *
 * TWO CORRECTIONS, doing different jobs:
 *
 *   1. POSITION BIAS (`positionPropensity`). Rank 1 is engaged with partly BECAUSE it is
 *      rank 1. Training rows are therefore weighted by 1/P(examined | position), the
 *      standard inverse-propensity estimator from unbiased learning-to-rank, so a click
 *      at rank 20 counts for much more than a click at rank 1.
 *   2. EXPLORATION (`epsilonShuffle`). Randomizing a slice of traffic is what makes the
 *      position-bias curve identifiable in the first place, and it is the only source of
 *      evidence about items the incumbent model would never have shown. Rows served this
 *      way are flagged `explored` in the log.
 *
 * DETERMINISM. `src/` contains zero `Math.random` calls and this file does not break
 * that. Randomness comes from a seeded PRNG, and the seed is derived from the viewer and
 * the day — so a viewer's exploration is stable across a page refresh (re-rolling every
 * request would make the feed visibly jitter), reproducible in a test, and replayable
 * when someone asks in three weeks why they saw what they saw.
 */

/** FNV-1a. A small, fast, well-distributed string hash — used only to derive a seed. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32 — a 32-bit PRNG that is small, has good statistical properties for this
 * purpose, and (unlike `Math.random`) is a pure function of its seed.
 * Returns a generator of floats in [0, 1).
 */
export function prng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable per-viewer, per-day, per-surface seed. Anonymous viewers share a seed per day,
 *  which is fine — we want a fraction of *impressions* randomized, not of people. */
export function seedFor(surface: string, viewerId: string | null, nowMs: number): number {
  const day = Math.floor(nowMs / 86_400_000);
  return hashSeed(`${surface}:${viewerId ?? "anon"}:${day}`);
}

/** Fraction of feed renders that get a randomized head. 10% is the usual starting point:
 *  enough to learn from within weeks, small enough that most users never notice. */
export const DEFAULT_EPSILON = 0.1;
/** How deep the randomization reaches. Only the head is worth exploring — shuffling
 *  ranks 40–60 teaches us nothing because nobody looks at either. */
export const DEFAULT_WINDOW = 10;

/**
 * Read the exploration rate from configuration.
 *
 * Total: an absent, blank or unparseable value falls back to the default rather than
 * disabling exploration by accident, and anything outside [0,1] is clamped. `"0"` is the
 * one way to switch it off, and it has to be said explicitly.
 */
export function epsilonFrom(raw: string | undefined | null): number {
  if (raw == null || raw === "") return DEFAULT_EPSILON;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_EPSILON;
  return Math.min(1, Math.max(0, n));
}

/**
 * Examination-probability model: P(the viewer actually looked at this slot).
 *
 * A power law in rank, which is the standard shape observed in click logs. `eta = 1`
 * makes slot 10 about a tenth as likely to be seen as slot 1 — steep, and roughly right
 * for a scrolling feed.
 *
 * FLOORED at 0.02, and that floor is load-bearing rather than cosmetic: IPW weights are
 * 1/propensity, so an unfloored tail produces weights in the thousands and a single deep
 * engagement would swamp the entire training set. Clipping propensities is the standard
 * bias-variance trade in IPW, and this floor is the clip.
 */
export const POSITION_BIAS_EXPONENT = 1.0;
export const MIN_PROPENSITY = 0.02;

export function positionPropensity(position: number, eta: number = POSITION_BIAS_EXPONENT): number {
  const p = Number.isFinite(position) && position > 0 ? position : 0;
  const raw = 1 / Math.pow(1 + p, Number.isFinite(eta) && eta >= 0 ? eta : POSITION_BIAS_EXPONENT);
  if (!Number.isFinite(raw)) return 1;
  return Math.min(1, Math.max(MIN_PROPENSITY, raw));
}

export interface ExploreResult<T> {
  items: T[];
  /** True when the head was randomized — recorded per impression so training can weight
   *  or filter on it. */
  explored: boolean;
}

export interface ExploreOpts {
  epsilon?: number;
  window?: number;
  /** Provide directly in tests; otherwise derived from surface + viewer + day. */
  seed?: number;
}

/**
 * With probability ε, uniformly shuffle the first `window` items; otherwise return the
 * ranking untouched.
 *
 * Shuffling the whole head on a fraction of renders (rather than perturbing every render
 * a little) keeps the bookkeeping honest: an impression is either from the randomized
 * policy or from the model, never a blend, so its propensity is knowable rather than
 * estimated. It also means 90% of viewers get the model's best ordering, undiluted.
 */
export function epsilonShuffle<T>(
  ranked: readonly T[],
  surface: string,
  viewerId: string | null,
  nowMs: number,
  opts: ExploreOpts = {},
): ExploreResult<T> {
  const epsilon = clamp01(opts.epsilon ?? DEFAULT_EPSILON);
  const window = Math.max(2, Math.floor(opts.window ?? DEFAULT_WINDOW));
  const items = [...ranked];
  if (epsilon === 0 || items.length < 2) return { items, explored: false };

  const rand = prng(opts.seed ?? seedFor(surface, viewerId, nowMs));
  // First draw decides whether this render explores at all.
  if (rand() >= epsilon) return { items, explored: false };

  // Fisher–Yates over the head only.
  const end = Math.min(window, items.length);
  for (let i = end - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = items[i]!;
    const b = items[j]!;
    items[i] = b;
    items[j] = a;
  }
  return { items, explored: true };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return x > 1 ? 1 : x;
}
