/**
 * Ranking. The shape is Hacker News' gravity curve — votes lifted, age pulling
 * down — with three deliberate departures:
 *
 *   1. NETWORK WEIGHT. An upvote from someone in your graph counts for more than
 *      one from a stranger. A local site's whole advantage is knowing who is
 *      voting; a global site can't do this.
 *   2. INTEREST MATCH. Stories on the axes a reader follows (hardware, early-stage
 *      VC, math, software) get a modest lift. Modest on purpose — a filter bubble
 *      is a worse failure than a slightly off-topic front page.
 *   3. ORIGIN WEIGHT. In a Bay-leaning view, aggregated stories are discounted so
 *      that a busy HN day can't bury the local conversation.
 *
 * SQLite has no POW(), and these need per-viewer inputs, so ranking happens in JS
 * over a bounded candidate set rather than in an ORDER BY. Pure — the clock is a
 * parameter, so every case here is reproducible.
 */
import type { StoryOrigin, NewsSort } from "../../shared/schema";

/** Tunables, named and in one place rather than sprinkled as magic numbers. */
export const GRAVITY = 1.8;
export const AGE_OFFSET_HOURS = 2;
/** A vote from your network is worth this many stranger-votes. */
export const NETWORK_VOTE_WEIGHT = 2;
/** Multiplier when a story matches an interest the reader follows. */
export const INTEREST_BOOST = 0.35;
/** Multiplier applied to aggregated stories in a Bay-leaning view. */
export const EXTERNAL_PENALTY = 0.6;
/**
 * How much a source's own score counts, after sqrt compression.
 *
 * Without this the ranking collapses: almost every aggregated story has zero
 * LOCAL votes, so `votes - 1` clamps to 0 and every story scores exactly 0 —
 * at which point the tie-break decides the whole front page. A 400-point HN
 * front-pager and an unread RSS item are not equally interesting, and pretending
 * otherwise is what makes an aggregator feel random.
 *
 * sqrt compresses hard so a 2000-point story doesn't bury everything local:
 * 400 → 20 → 10 effective, 100 → 10 → 5, 25 → 5 → 2.5.
 */
export const EXTERNAL_POINT_WEIGHT = 0.5;
/** Unparseable timestamps sink instead of floating to the top. */
const UNKNOWN_AGE_HOURS = 10_000;

/** What scoring needs. No id — a score is a property of the story, not the row. */
export interface Scorable {
  votes: number;
  createdAt: string;
  origin?: StoryOrigin;
  topics?: string[];
  /** Votes that came from the viewer's friends/communities. */
  networkVotes?: number;
  commentCount?: number;
  /** Best score this story has on the source it was aggregated from. */
  externalPoints?: number;
}

/** What ORDERING needs: a score, plus a stable id to break ties on. */
export interface Rankable extends Scorable {
  id: string;
}

export interface RankOpts {
  /** Topic axes the viewer follows. */
  interests?: string[];
  /** Discount aggregated sources (the Bay-leaning front page). */
  bayView?: boolean;
}

const LOCAL: StoryOrigin[] = ["bay", "event"];

function ageHours(createdAt: string, nowMs: number): number {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return UNKNOWN_AGE_HOURS;
  return Math.max(0, (nowMs - t) / 3_600_000); // clamp: a future date is "now"
}

/** The hot score. Always finite and >= 0, whatever the row contains. */
export function hotScore(s: Scorable, nowMs: number, opts: RankOpts = {}): number {
  const votes = Number.isFinite(s.votes) ? s.votes : 0;
  const network = Number.isFinite(s.networkVotes as number) ? (s.networkVotes as number) : 0;
  // -1 discounts the submitter's own implicit vote, as HN does; clamped so an
  // unvoted story scores 0 rather than negative.
  const external = Number.isFinite(s.externalPoints as number) ? Math.max(0, s.externalPoints as number) : 0;
  const weighted =
    Math.max(0, votes - 1) +
    NETWORK_VOTE_WEIGHT * network +
    EXTERNAL_POINT_WEIGHT * Math.sqrt(external);

  let score = weighted / Math.pow(ageHours(s.createdAt, nowMs) + AGE_OFFSET_HOURS, GRAVITY);

  if (opts.interests?.length && s.topics?.length) {
    const wanted = new Set(opts.interests.map((t) => t.toLowerCase()));
    if (s.topics.some((t) => wanted.has(String(t).toLowerCase()))) score *= 1 + INTEREST_BOOST;
  }

  if (opts.bayView && s.origin && !LOCAL.includes(s.origin)) score *= EXTERNAL_PENALTY;

  return Number.isFinite(score) ? Math.max(0, score) : 0;
}

/**
 * Sort a candidate set. Returns a NEW array — callers frequently hold the input
 * in a cache, and an in-place sort would quietly reorder it under them.
 * Ties break on id so the order is total and stable across identical requests.
 */
export function rankStories<T extends Rankable>(
  stories: readonly T[],
  sort: NewsSort,
  nowMs: number,
  opts: RankOpts = {},
): T[] {
  const key = (s: T): number => {
    switch (sort) {
      case "new": return Date.parse(s.createdAt) || 0;
      case "top": return Number.isFinite(s.votes) ? s.votes : 0;
      case "discussed": return Number.isFinite(s.commentCount as number) ? (s.commentCount as number) : 0;
      default: return hotScore(s, nowMs, opts);
    }
  };
  // Ties break toward RECENCY, then id. Sorting ties by ascending id would order
  // by ULID — i.e. oldest first — which silently turns a front page backwards the
  // moment scores are equal (as they are when nothing has been voted on yet).
  return [...stories]
    .map((s) => ({ s, k: key(s), t: Date.parse(s.createdAt) || 0 }))
    .sort((a, b) =>
      (b.k - a.k) ||
      (b.t - a.t) ||
      (a.s.id < b.s.id ? 1 : a.s.id > b.s.id ? -1 : 0))
    .map(({ s }) => s);
}
