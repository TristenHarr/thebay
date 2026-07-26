/**
 * Hybrid ranking — reciprocal rank fusion (RRF).
 *
 * Four retrievers disagree about what "best" means: BM25 knows about words, the
 * vector index knows about meaning, recency knows that an event next Tuesday beats
 * one in November, and quality knows which events people actually want. Their
 * scores are on wildly different scales (bm25 is a negative log-odds, cosine is
 * [-1,1], recency is a timestamp), so combining the *scores* needs calibration
 * that drifts the moment a model or a corpus changes.
 *
 * RRF combines RANKS instead: `score(e) = Σ_L w_L / (k + rank_L(e))`. It needs no
 * calibration, is robust to a retriever returning garbage (a bad list just adds a
 * small constant to a few items), and encodes the property we actually want —
 * **agreement beats brilliance**. An item two retrievers both place second wins
 * over an item one retriever loves and the others have never heard of.
 *
 * This file is PURE: rank lists in, fused order out. No I/O, no clock (except the
 * `now` you pass), no DB. That's what makes the ranking testable as arithmetic.
 */

/** The classic RRF constant from Cormack et al. 2009. Damps the head of each list
 *  so rank 1 isn't overwhelmingly more valuable than rank 3. */
export const RRF_K = 60;

export type ListName = "bm25" | "vector" | "recency" | "quality";

/** One ordered list of event ids per retriever. Best first. Missing/empty is fine. */
export type RankLists = Partial<Record<ListName, readonly string[]>>;
export type FusionWeights = Partial<Record<ListName, number>>;

/**
 * Lexical and semantic relevance lead; recency and quality are tie-breakers that
 * shape the ordering rather than decide it. (When there is no text query the
 * caller simply passes no bm25/vector list and these two become the whole signal.)
 */
export const DEFAULT_WEIGHTS: Required<FusionWeights> = {
  bm25: 1,
  vector: 1,
  recency: 0.5,
  quality: 0.35,
};

export interface Fused {
  id: string;
  score: number;
  /** What each retriever contributed — enough to explain a result in the UI or a log. */
  contributions: Partial<Record<ListName, number>>;
}

const LIST_NAMES: ListName[] = ["bm25", "vector", "recency", "quality"];

/**
 * Fuse rank lists into one ordered result set.
 *
 * Ties are broken lexically by id, never by insertion order, so paging through a
 * fused list can't reshuffle rows between requests.
 */
export function fuse(lists: RankLists, weights: FusionWeights = {}, k: number = RRF_K): Fused[] {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const acc = new Map<string, Fused>();

  for (const name of LIST_NAMES) {
    const ids = lists[name];
    if (!ids?.length) continue;
    const weight = w[name];
    if (!weight) continue; // a zero-weight list must not even introduce its ids
    let rank = 0;
    const seen = new Set<string>();
    for (const id of ids) {
      if (!id || seen.has(id)) continue; // duplicates keep their first (best) rank
      seen.add(id);
      rank++;
      const contribution = weight / (k + rank);
      const prev = acc.get(id);
      if (prev) {
        prev.score += contribution;
        prev.contributions[name] = contribution;
      } else {
        acc.set(id, { id, score: contribution, contributions: { [name]: contribution } });
      }
    }
  }

  return [...acc.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** `fuse`, but you only care about the order. */
export function fuseIds(lists: RankLists, weights: FusionWeights = {}, k: number = RRF_K): string[] {
  return fuse(lists, weights, k).map((r) => r.id);
}

/** A "soonest first" rank list. Events that already happened sink to the bottom
 *  (most-recently-past first) rather than being dropped — the caller decides
 *  whether past events are in the candidate set at all. */
export function byRecency(
  rows: ReadonlyArray<{ id: string; startUtc: string }>,
  now: number = Date.now(),
): string[] {
  const cutoff = now - 6 * 3600_000; // same 6h grace the rest of the app uses
  const t = (r: { startUtc: string }) => Date.parse(r.startUtc) || 0;
  const upcoming = rows.filter((r) => t(r) >= cutoff).sort((a, b) => t(a) - t(b) || a.id.localeCompare(b.id));
  const past = rows.filter((r) => t(r) < cutoff).sort((a, b) => t(b) - t(a) || a.id.localeCompare(b.id));
  return [...upcoming, ...past].map((r) => r.id);
}

/** A "most interesting first" rank list. Unscored events go last (unknown is not
 *  the same as bad, but it must not outrank a known-good event). */
export function byQuality(
  rows: ReadonlyArray<{ id: string; interestScore: number | null | undefined }>,
): string[] {
  return [...rows]
    .sort((a, b) => {
      const av = a.interestScore ?? -1;
      const bv = b.interestScore ?? -1;
      return bv - av || a.id.localeCompare(b.id);
    })
    .map((r) => r.id);
}
