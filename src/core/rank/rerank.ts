/**
 * The serving side of the loop, as one pure function.
 *
 * This is where the four stages meet: candidates arrive already fused (stage 1+2), get
 * scored by the learned model (stage 3), get listwise-corrected for diversity and fatigue
 * (stage 4), and a slice of traffic gets randomized so tomorrow's training set isn't
 * simply a record of today's opinions.
 *
 * It is generic over the row type and takes an adapter, so events, news and shadows share
 * one implementation instead of three that drift. Nothing here touches a database or a
 * clock — `nowMs` is a parameter — which is what makes a feed ordering reproducible from
 * a logged impression months later.
 *
 * TWO PROPERTIES WORTH NOT BREAKING:
 *
 *   1. FEATURES ARE ALWAYS COMPUTED, even when no model exists. They are the training
 *      data; if we only computed them once a model was live, no model could ever become
 *      live. This is the bootstrap, and it is why `rescored` and `features` are separate
 *      concerns in the result.
 *   2. NO MODEL MEANS NO REORDERING. With no promoted weights the input order is returned
 *      untouched, so shipping this changes nothing until something has been learned and
 *      has passed the promotion gate.
 */
import type { RankSurface } from "../../../shared/schema";
import { extractFeatures, type FeatureVector, type RankItem, type ViewerCtx } from "./features";
import { predict, shouldRescore, type Weights } from "./model";
import { rescore } from "./diversify";
import { DEFAULT_EPSILON, DEFAULT_WINDOW, epsilonShuffle } from "./explore";

export interface RerankInput<T> {
  /** Candidates in their baseline (fused) order — best first. */
  items: readonly T[];
  /** Adapt a row into the ranking's view of it. Must return a stable `id`. */
  toRankItem: (item: T) => RankItem;
  viewer: ViewerCtx;
  surface: RankSurface;
  nowMs: number;
  /** The live model's weights, or null/`{}` for the passthrough. */
  weights?: Weights | null;
  /** Needed only to seed exploration; never used as a feature. */
  viewerId?: string | null;
  /** Whether this request is allowed to randomize. Off by default: exploration is a
   *  visible change to ordering and belongs only on surfaces that opted into learning. */
  explore?: boolean;
  epsilon?: number;
  window?: number;
  /** id → prior impression count for this viewer, for the fatigue rescorer. */
  timesShown?: ReadonlyMap<string, number>;
  /**
   * What "more of the same" means for the diversity rescorer, independent of `authorKey`.
   *
   * Defaults to `authorKey`, which is right for events (repeats from one host). News needs
   * them separated: its author-ish key is the SOURCE, so origin affinity is a useful
   * feature — but `src/news/curate.ts` already enforces per-source quotas, and applying an
   * exponential same-source decay on top would penalize a source twice for the same
   * property. Returning `null` opts an item out of diversity discounting entirely.
   */
  groupKeyOf?: (item: T) => string | null;
}

export interface RerankResult<T> {
  /** Final order, ready to serve. */
  items: T[];
  /** id → the vector that produced the score. Log this verbatim — recomputing it later
   *  pairs today's features with yesterday's label. */
  features: Map<string, FeatureVector>;
  /** Did the exploration slice fire on this request? */
  explored: boolean;
  /** Did the learned model actually reorder, or was this the passthrough? */
  rescored: boolean;
  /** Per-item detail, for `GET /api/rank/model`-style explainability. */
  detail: Array<{ id: string; score: number; rescoreFactor: number }>;
}

export function rerank<T>(input: RerankInput<T>): RerankResult<T> {
  const { items, toRankItem, viewer, surface, nowMs } = input;
  const weights = input.weights ?? null;

  // One pass to adapt + extract. `timesShown` is folded in here so the fatigue rescorer
  // and the `novelty` feature see the same number.
  const prepared = items.map((item) => {
    const ranked = toRankItem(item);
    const seen = input.timesShown?.get(ranked.id);
    const withSeen: RankItem = seen == null ? ranked : { ...ranked, timesShown: seen };
    return { item, ranked: withSeen, features: extractFeatures(withSeen, viewer, surface, nowMs) };
  });

  const features = new Map<string, FeatureVector>();
  for (const p of prepared) features.set(p.ranked.id, p.features);

  const rescored = shouldRescore(weights ? { weights } : null);

  let ordered: typeof prepared;
  let detail: RerankResult<T>["detail"];

  if (rescored) {
    // P(engage) per candidate, then the listwise corrections the model cannot express.
    const scored = prepared.map((p) => ({
      id: p.ranked.id,
      score: predict(p.features, weights!),
      groupKey: input.groupKeyOf ? input.groupKeyOf(p.item) : p.ranked.authorKey ?? null,
      timesShown: p.ranked.timesShown ?? 1,
      p,
    }));
    const out = rescore(scored);
    ordered = out.map((r) => r.p);
    detail = out.map((r) => ({ id: r.id, score: r.score, rescoreFactor: r.rescoreFactor }));
  } else {
    // Passthrough: the fused order, exactly as it arrived.
    ordered = prepared;
    detail = prepared.map((p) => ({ id: p.ranked.id, score: 0, rescoreFactor: 1 }));
  }

  // Exploration last, so it perturbs what would actually have been served.
  //
  // REQUIRES A SIGNED-IN VIEWER, for two independent reasons. Its whole purpose is to
  // produce rows free of the incumbent model's prior, and an anonymous row can never be
  // labelled positive — every engagement we learn from needs an account — so exploring it
  // buys nothing. And the seed is per (surface, viewer, day): with no viewer they all
  // share one seed, so an "exploring" day would shuffle the page identically for every
  // logged-out visitor at once, which on a public front page is a visible glitch rather
  // than an experiment.
  const shuffled = input.explore && input.viewerId
    ? epsilonShuffle(ordered, surface, input.viewerId, nowMs, {
        epsilon: input.epsilon ?? DEFAULT_EPSILON,
        window: input.window ?? DEFAULT_WINDOW,
      })
    : { items: ordered, explored: false };

  return {
    items: shuffled.items.map((p) => p.item),
    features,
    explored: shuffled.explored,
    rescored,
    detail,
  };
}

/**
 * Adapt a stored event into a `RankItem`.
 *
 * Lives here rather than in the route so the mapping is testable on its own and so the
 * three surfaces' adapters sit side by side. `categories` is used for tags because that
 * is the column the candidate query already returns — see `RankRepo.viewerContext` on why
 * that matches the affinity map's keys.
 */
export interface EventLike {
  id: string;
  startUtc: string;
  organizer?: string | null;
  categories?: string[] | null;
  interestScore?: number | null;
  isFree?: boolean | null;
}

export function eventToRankItem(
  e: EventLike,
  engagement?: { total: number; friends: number },
): RankItem {
  return {
    id: e.id,
    at: e.startUtc,
    quality: e.interestScore ?? null,
    tags: (e.categories ?? []).map((c) => String(c).toLowerCase()),
    authorKey: e.organizer && e.organizer.trim() ? e.organizer.toLowerCase() : null,
    engagements: engagement?.total ?? 0,
    friendEngagements: engagement?.friends ?? 0,
    isFree: e.isFree ?? null,
  };
}

/**
 * Adapt a news story into a `RankItem`.
 *
 * Three mappings deserve a note:
 *
 *   · `at` is the FRESHNESS timestamp, not `createdAt`. Lagging origins (SEC, FDA,
 *     research, GitHub) are judged from when they reached us — the same instant
 *     `src/news/rank.ts` decays from — or a filing that clears the window scores ~0 on
 *     arrival and sits at the bottom forever: reachable in theory, invisible in practice.
 *   · `authorKey` is the ORIGIN, not the submitter. Almost every story is ingested and has
 *     no local author, so the meaningful "who made this" is the source it came from, and
 *     "reads a lot of Lobsters" is a real preference worth learning.
 *   · `quality` is left null. Stories have no equivalent of `events.interest_score`; what
 *     a source thought of a story is `externalPoints`, which has its own feature and its
 *     own sqrt compression, and folding one into the other would double-count it.
 */
export interface StoryLike {
  id: string;
  origin?: string | null;
  topics?: string[] | null;
  voteCount?: number | null;
  commentCount?: number | null;
  externalPoints?: number | null;
  createdAt: string;
  firstSeenAt?: string | null;
}

export function storyToRankItem(
  s: StoryLike,
  opts: { freshnessAt?: string; networkVotes?: number } = {},
): RankItem {
  return {
    id: s.id,
    at: opts.freshnessAt ?? s.createdAt,
    quality: null,
    tags: (s.topics ?? []).map((t) => String(t).toLowerCase()),
    authorKey: s.origin ? String(s.origin).toLowerCase() : null,
    // Votes and comments are both "someone bothered", so they pool into social proof.
    engagements: (Number(s.voteCount) || 0) + (Number(s.commentCount) || 0),
    friendEngagements: opts.networkVotes ?? 0,
    externalPoints: s.externalPoints ?? 0,
    isFree: null,
  };
}
