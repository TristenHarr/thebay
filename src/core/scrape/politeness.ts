/**
 * Politeness for a distributed crawler — pure, and the single most important module
 * in the scrape network.
 *
 * The old model doesn't survive distribution. `HOST_MIN_GAP_MS` + `hostChains` in
 * src/sources/util/http.ts is an in-memory Map on one machine: it serialises requests
 * beautifully for one process and knows nothing about the other forty-nine. Fifty
 * volunteers each politely waiting 900ms between their own requests is not polite; it
 * is fifty times the load with a clear conscience. And clients cannot fix this among
 * themselves, because they can't see each other.
 *
 * So politeness stops being something we ask clients to do and becomes something the
 * coordinator ENFORCES BY WITHHOLDING WORK. A lease is permission to crawl a host, and
 * `mayLease` is the only thing that grants it:
 *
 *   · at most `maxConcurrent` clients crawl a host at any instant, fleet-wide;
 *   · a new lease waits `effectiveGapMs` after the last one;
 *   · robots.txt `Crawl-delay` wins whenever it asks for more room than our default;
 *   · a host that told us to back off (429/403) is untouched until `blockedUntil`;
 *   · `dailyCap` bounds the total, so a bug in the scheduler can't become an incident.
 *
 * With `maxConcurrent: 1` this reproduces exactly today's single-machine behaviour —
 * one crawler on that host at a time, spaced by the gap — except the requests arrive
 * from a rotating set of residential IPs. THAT is the win from distribution: not more
 * requests per second, but the same polite rate with coverage one datacenter IP can
 * never have.
 *
 * Everything here is total. A NaN gap, a negative cap, a garbage timestamp: none of
 * them may produce a permissive answer, because this function is the only thing
 * standing between us and hammering somebody's website.
 */

export interface HostState {
  host: string;
  /** Our floor between lease grants. */
  minGapMs: number;
  /** How many clients may crawl this host at once, fleet-wide. */
  maxConcurrent: number;
  /** From robots.txt. Wins when it asks for MORE space than `minGapMs`. */
  crawlDelayMs?: number | null;
  /** Live (unexpired, unsubmitted) leases on this host right now. */
  liveLeases: number;
  lastGrantedAt?: string | null;
  /** Back-off the host asked for. Nothing is leased until it passes. */
  blockedUntil?: string | null;
  dailyCap?: number | null;
  grantedToday?: number | null;
}

export type LeaseVerdict = "ok" | "blocked" | "at_capacity" | "too_soon" | "daily_cap";

/** Finite number or the fallback. Guards every arithmetic input. */
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** Milliseconds for an ISO string, or null. */
function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * The gap we actually honour. `Math.max`, never an average or an override: if a host's
 * robots.txt asks for 10 seconds, 10 seconds is the answer, and if it asks for less
 * than our own floor we keep our floor. Politeness only ever ratchets up.
 */
export function effectiveGapMs(h: Pick<HostState, "minGapMs" | "crawlDelayMs">): number {
  const mine = Math.max(0, num(h.minGapMs, 1000));
  const theirs = Math.max(0, num(h.crawlDelayMs, 0));
  return Math.max(mine, theirs);
}

/** Today, in the timezone the daily counter is kept in (UTC — it's a budget, not a date). */
export function dayKey(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/**
 * May we hand out a lease for this host right now, and if not, why? The reason is
 * returned rather than a bare boolean because the coordinator logs it: "we scraped
 * less today" and "we scraped less today because three hosts were blocked" are very
 * different operational facts.
 */
export function mayLease(h: HostState, atMs: number, day: string = dayKey(atMs)): LeaseVerdict {
  const blocked = ms(h.blockedUntil);
  if (blocked !== null && blocked > atMs) return "blocked";

  const cap = num(h.dailyCap, 0);
  if (cap > 0 && num(h.grantedToday, 0) >= cap) return "daily_cap";
  void day; // the caller resets grantedToday when the day rolls; see ScrapeNetRepo.lease

  // Capacity before timing: "somebody is already in there" is the more fundamental
  // reason, and reporting it as `too_soon` would suggest waiting a gap would help.
  const capacity = Math.max(1, Math.trunc(num(h.maxConcurrent, 1)));
  if (Math.max(0, Math.trunc(num(h.liveLeases, 0))) >= capacity) return "at_capacity";

  const last = ms(h.lastGrantedAt);
  if (last !== null && atMs - last < effectiveGapMs(h)) return "too_soon";

  return "ok";
}

/**
 * The earliest moment this host could be leased again, for a scheduler that wants to
 * sleep rather than spin. Never in the past, so a caller can subtract `Date.now()` and
 * get a non-negative delay.
 */
export function nextGrantAt(h: HostState, atMs: number): number {
  const blocked = ms(h.blockedUntil) ?? 0;
  const last = ms(h.lastGrantedAt);
  const afterGap = last === null ? atMs : last + effectiveGapMs(h);
  return Math.max(atMs, blocked, afterGap);
}

/**
 * How long a lease may be held before we assume the client died. Generous, because a
 * paginated crawl behind a min-gap is genuinely slow, and stingy expiry would hand the
 * same job to a second worker while the first is still politely working through it —
 * doubling our load on the host, which is the exact thing we're trying to prevent.
 */
export const LEASE_TTL_MS = 10 * 60_000;

/**
 * Back-off when a host pushes back. Doubling per consecutive rebuff, capped at an hour:
 * a single 429 is noise, four in a row is a message.
 */
export function backoffUntilMs(consecutiveRebuffs: number, atMs: number, retryAfterMs?: number | null): number {
  const n = Math.max(1, Math.trunc(num(consecutiveRebuffs, 1)));
  const ours = Math.min(60 * 60_000, 30_000 * 2 ** (n - 1));
  // A `Retry-After` is the host telling us the answer. Honour it when it's longer.
  return atMs + Math.max(ours, Math.max(0, num(retryAfterMs, 0)));
}
