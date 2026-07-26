/**
 * Consensus windows — pure. Tumbling buckets of wall-clock time, absolute (epoch-based)
 * so every participant computes the same boundaries with nothing to negotiate.
 *
 * Why a window exists at all: two workers are only comparable if they looked at the same
 * thing at roughly the same time. Comparing an observation from 09:00 against one from
 * 15:00 doesn't measure honesty, it measures how fast the site changes — and it would
 * punish whichever worker happened to look later. So a job is (recipe × window), and
 * only observations inside one window are ever weighed against each other.
 *
 * The window length is a per-recipe trade-off, not a constant: a fast-moving discovery
 * feed wants a short window so agreement means something, while a monthly conference
 * calendar wants a long one so we don't demand six pointless re-scrapes a day.
 */

/** 6 hours. Four scrapes a day per source is plenty for an events catalog. */
export const DEFAULT_WINDOW_MS = 6 * 60 * 60_000;

/** Floor to nothing shorter than a minute — a window below the lease TTL can't be covered. */
const MIN_WINDOW_MS = 60_000;

export function normalizeWindowMs(windowMs: unknown): number {
  const n = typeof windowMs === "number" && Number.isFinite(windowMs) ? Math.trunc(windowMs) : DEFAULT_WINDOW_MS;
  return Math.max(MIN_WINDOW_MS, n);
}

/** The start of the bucket containing `atMs`, as an ISO string (the DB's key form). */
export function windowStart(atMs: number, windowMs: number = DEFAULT_WINDOW_MS): string {
  const w = normalizeWindowMs(windowMs);
  const at = Number.isFinite(atMs) ? atMs : 0;
  return new Date(Math.floor(at / w) * w).toISOString();
}

/** When the bucket that started at `windowStartIso` ends. */
export function windowEndMs(windowStartIso: string, windowMs: number = DEFAULT_WINDOW_MS): number {
  const start = Date.parse(windowStartIso);
  return (Number.isNaN(start) ? 0 : start) + normalizeWindowMs(windowMs);
}

/** Is this window still open for new observations? */
export function windowIsOpen(windowStartIso: string, windowMs: number, atMs: number): boolean {
  return atMs < windowEndMs(windowStartIso, windowMs);
}
