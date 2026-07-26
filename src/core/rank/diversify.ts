/**
 * Listwise rescoring — the corrections that are deliberately OUTSIDE the model.
 *
 * A learned ranker scores each candidate independently, so it cannot express "this is a
 * great event, but it's the fourth one from the same host and the page is getting
 * boring". That is a property of the LIST, not of the item, and trying to teach it to a
 * pointwise model produces a model that has learned to dislike prolific hosts.
 *
 * X keeps 21 of these rescorers next to their heavy ranker for exactly this reason, and
 * the most interesting one is `GrokSlopScoreRescorer` — after all the learning, they
 * still needed a non-learned override to stop the feed filling with slop. The lesson
 * generalizes: some corrections belong in a multiplier you can read, not in a weight
 * you have to infer.
 *
 * Two are reimplemented here (from `AuthorBasedListwiseRescoringProvider` and
 * `ImpressedAuthorDecayRescoringProvider` — the algorithms, not the AGPL code):
 *
 *   · `diversityFactor` — exponential discount for repeats from the same host, WITH A
 *     FLOOR. The floor is the whole subtlety: a hard quota (which `src/news/curate.ts`
 *     uses, correctly, for source balance) says "you get 3 slots and no more", which on
 *     a quiet day leaves the page short. A floored decay says "your 5th event still
 *     counts for 25%", so a genuinely dominant host degrades gracefully instead of
 *     falling off a cliff.
 *   · `fatigueFactor` — halve the score each time we've already shown someone a thing.
 *     Without it the top of the feed is frozen: the best item stays the best item and a
 *     daily visitor sees the same row forever.
 *
 * Pure. Multiplicative, so they compose in any order and each one's effect stays legible
 * in isolation.
 */

/** Per-position discount for repeats from one host. X's published defaults, which are
 *  as good a starting point as any and have the virtue of being battle-tested. */
export const DIVERSITY_DECAY = 0.5;
export const DIVERSITY_FLOOR = 0.25;

/**
 * The multiplier for the `index`-th item (0-based) from a repeated host.
 *
 * `(1 − floor) · decay^index + floor` — 1.0 for the first, 0.625 for the second,
 * 0.4375 for the third, asymptotic to the floor. Total for any input.
 */
export function diversityFactor(
  index: number,
  decay: number = DIVERSITY_DECAY,
  floor: number = DIVERSITY_FLOOR,
): number {
  const i = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  const d = Number.isFinite(decay) && decay >= 0 && decay <= 1 ? decay : DIVERSITY_DECAY;
  const f = Number.isFinite(floor) && floor >= 0 && floor <= 1 ? floor : DIVERSITY_FLOOR;
  const v = (1 - f) * Math.pow(d, i) + f;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : f;
}

/** Halve per prior impression. `timesShown` of 0 or 1 means "new to you" → 1.0. */
export function fatigueFactor(timesShown: number | null | undefined, decay: number = 0.5): number {
  const n = Number.isFinite(timesShown as number) ? Math.max(0, Math.floor(timesShown as number) - 1) : 0;
  const d = Number.isFinite(decay) && decay > 0 && decay <= 1 ? decay : 0.5;
  const v = Math.pow(d, n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

export interface Rescorable {
  id: string;
  score: number;
  /** Host / organizer / author — whatever "more of the same" means on this surface.
   *  `null` opts an item out of diversity discounting entirely. */
  groupKey?: string | null;
  timesShown?: number | null;
}

/**
 * Apply both rescorers and re-sort.
 *
 * Walks the list in CURRENT score order, so "index within group" means "how many
 * better-scoring items this host already has" — the same greedy pass X uses. Doing it
 * against the original order rather than iteratively re-sorting keeps it O(n log n) and,
 * more importantly, keeps it deterministic.
 *
 * Ties break on id so paging can't reshuffle rows between requests — the same rule
 * `fuse()` follows in `src/core/search/rank.ts`.
 */
export function rescore<T extends Rescorable>(
  items: readonly T[],
  opts: { decay?: number; floor?: number; fatigue?: boolean } = {},
): Array<T & { score: number; rescoreFactor: number }> {
  const seen = new Map<string, number>();
  const out = items.map((it) => {
    const key = it.groupKey;
    let factor = 1;
    if (key) {
      const index = seen.get(key) ?? 0;
      seen.set(key, index + 1);
      factor *= diversityFactor(index, opts.decay, opts.floor);
    }
    if (opts.fatigue !== false) factor *= fatigueFactor(it.timesShown);
    const base = Number.isFinite(it.score) ? it.score : 0;
    return { ...it, score: base * factor, rescoreFactor: factor };
  });

  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
