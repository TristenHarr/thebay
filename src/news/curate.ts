/**
 * The front page.
 *
 * `?src=bay` is what a first-time visitor sees, so it decides what this site
 * looks like it's *for*. Three failure modes, pulling in different directions:
 *
 *   - ONLY our own content → with no submissions yet, a page of nothing but
 *     event listings. Reads as a calendar, not a news site. (This was the real
 *     front page.)
 *   - EVERYTHING → an aggregator with a local section, and the local voice is
 *     buried under Hacker News.
 *   - One source dominating → 178 event rows will happily eat all 30 slots, or
 *     one busy feed will, and the page looks monotonous either way.
 *
 * So the page is built in two tiers with per-source quotas:
 *
 *   1. HUMAN SUBMISSIONS lead, always, uncapped. That's the site's whole point,
 *      and as real ones arrive they push everything else down automatically —
 *      no flag to flip, the borrowed content just recedes.
 *   2. Everything else fills the rest by rank, subject to a per-source quota and
 *      a quality bar, so the reader always gets a MIX: a few Bay events, fresh
 *      Form D filings, the top of HN, what's being built on GitHub, the best of
 *      the blogs.
 *
 * Pure, so the entire editorial policy is one readable file.
 */
import type { StoryOrigin } from "../../shared/schema";

/** Submitted by a person here. Always leads, never capped, never displaced. */
export const SUBMISSION: StoryOrigin = "bay";

/**
 * What counts as Bay-local.
 *
 * `sec` is here on purpose: a Form D is a Bay Area company raising money. That's
 * local news by any reasonable reading — arguably more so than a Hacker News
 * link — so it belongs with ours rather than in the borrowed pile.
 */
export const LOCAL: StoryOrigin[] = ["bay", "event", "sec"];

/**
 * Share of the page any one source may take, as a fraction of the slots left
 * after human submissions. Tuned so a full page reads as a magazine rather than
 * a feed: substantial HN and blog presence, a real but bounded slice of local
 * events, and enough GitHub/Lobsters/EDGAR to be genuinely interesting.
 */
export const QUOTA: Record<StoryOrigin, number> = {
  bay: 1,          // unused (submissions are uncapped) but keeps the map total
  event: 0.22,     // Bay events — present, never the whole page
  sec: 0.15,       // fresh funding filings
  hn: 0.25,        // the top of Hacker News
  rss: 0.28,       // the publications we chose
  lobsters: 0.12,
  github: 0.12,
  reddit: 0.18,   // large community, deliberately not dominant
};

/**
 * The bar an aggregated story clears to earn a slot, calibrated per source
 * rather than as one global number: 100 points is a genuine HN front-pager,
 * while Lobste.rs is a smaller community where 20 is the equivalent signal, and
 * GitHub is stars. RSS has no score — those are publications chosen
 * deliberately, so inclusion in the feed IS the editorial judgement, and the
 * quota is what keeps them honest.
 */
export const QUALITY_BAR: Record<string, number> = {
  hn: 80,
  lobsters: 15,
  github: 50,
  reddit: 150,   // Reddit scores run high; 150 is a genuinely popular post
  rss: 0,
  event: 0,
  sec: 0,
  bay: 0,
};

export interface Curatable {
  id: string;
  origin: StoryOrigin;
  externalPoints?: number | null;
}

export const isLocal = (origin: StoryOrigin): boolean => LOCAL.includes(origin);

/** Whether a story is good enough for the front page. */
export function qualifies(story: Curatable): boolean {
  const bar = QUALITY_BAR[story.origin];
  if (bar === undefined) return false; // unknown source: not on the front page
  if (bar === 0) return true;
  return (story.externalPoints ?? 0) >= bar;
}

/** Slots a source may take on a page of `limit`, after submissions. */
export function quotaFor(origin: StoryOrigin, remaining: number): number {
  const share = QUOTA[origin] ?? 0;
  return Math.max(1, Math.round(remaining * share));
}

/**
 * Build the front page.
 *
 * `submissions` and `rest` are expected pre-ranked; this decides membership and
 * the balance between sources, not their internal order.
 *
 * A second pass backfills from whatever qualified but hit its quota, so a quiet
 * day never leaves the page short — the quotas shape a full page, they don't
 * shrink it.
 */
export function curateFrontPage<T extends Curatable>(
  submissions: readonly T[],
  rest: readonly T[],
  limit: number,
): T[] {
  const out: T[] = submissions.slice(0, limit);
  if (out.length >= limit) return out;

  const remaining = limit - out.length;

  // Bucket by source, preserving each source's own ranking.
  const buckets = new Map<StoryOrigin, T[]>();
  for (const s of rest) {
    if (!qualifies(s)) continue;
    const b = buckets.get(s.origin);
    if (b) b.push(s); else buckets.set(s.origin, [s]);
  }

  // ROUND-ROBIN, not a single pass in list order. A single pass lets whichever
  // source happens to come first eat the page — with 140 events in the candidate
  // set, sources later in the list were starved to zero. Cycling takes each
  // source's next-best in turn, so every source is represented and the page
  // reads as a mix rather than as blocks of one source at a time.
  const cycle: StoryOrigin[] = (["event", "hn", "rss", "sec", "github", "lobsters", "reddit"] as StoryOrigin[])
    .filter((o) => buckets.has(o));
  // Any source not in the fixed order still gets a turn.
  for (const o of buckets.keys()) if (!cycle.includes(o)) cycle.push(o);

  const taken = new Map<StoryOrigin, number>();
  const cursor = new Map<StoryOrigin, number>();
  let progressed = true;

  while (out.length < limit && progressed) {
    progressed = false;
    for (const origin of cycle) {
      if (out.length >= limit) break;
      const bucket = buckets.get(origin)!;
      const i = cursor.get(origin) ?? 0;
      if (i >= bucket.length) continue;
      if ((taken.get(origin) ?? 0) >= quotaFor(origin, remaining)) continue;
      out.push(bucket[i]!);
      cursor.set(origin, i + 1);
      taken.set(origin, (taken.get(origin) ?? 0) + 1);
      progressed = true;
    }
  }

  // Backfill past the quotas — a quiet day elsewhere shouldn't leave the page
  // short. Quotas shape a full page; they don't shrink it.
  if (out.length < limit) {
    for (const origin of cycle) {
      const bucket = buckets.get(origin)!;
      for (let i = cursor.get(origin) ?? 0; i < bucket.length && out.length < limit; i++) out.push(bucket[i]!);
      if (out.length >= limit) break;
    }
  }
  return out;
}
