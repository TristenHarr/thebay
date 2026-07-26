/**
 * An event's time window, parsed once and NaN-safe.
 *
 * Shared by `presence.ts` (may the door be open?) and `policy.ts` (may an award be
 * made?) so the two cannot disagree about when an event happened. Both are asked to
 * judge a timestamp against `events.start_utc`/`end_utc`, which are TEXT ISO strings
 * that a scraper wrote — so "unparseable" is a real case, not a theoretical one.
 */

export interface EventWindow {
  startUtc: string;
  endUtc: string | null;
}

/**
 * How long an event is assumed to run when `end_utc` is NULL.
 *
 * A large share of the catalog has no end time — `SocialRepo.createHostedEvent` never
 * sets one, and most scraped sources don't publish it. Assuming a duration is better
 * than treating the event as instantaneous (which would shut the door immediately) or
 * as unbounded (which would leave it open forever).
 */
export const ASSUMED_DURATION_MS = 3 * 60 * 60 * 1000;

/** Start as epoch ms, or NaN if the stored string is unusable. */
export function eventStartMs(ev: EventWindow): number {
  return Date.parse(ev.startUtc);
}

/** End as epoch ms — the stored end, or start + the assumed duration. NaN-propagating,
 *  so callers must decide what an unparseable event means rather than being handed a
 *  plausible-looking number. */
export function eventEndMs(ev: EventWindow): number {
  const start = eventStartMs(ev);
  if (ev.endUtc) {
    const end = Date.parse(ev.endUtc);
    // An end before the start is bad data; fall back rather than produce a window
    // that is negative-length and would refuse everything.
    if (Number.isFinite(end) && Number.isFinite(start) && end >= start) return end;
    if (Number.isFinite(end) && !Number.isFinite(start)) return end;
  }
  return start + ASSUMED_DURATION_MS;
}

/** Minutes an event is scheduled to last. 0 when the window is unusable. */
export function eventLengthMinutes(ev: EventWindow): number {
  const ms = eventEndMs(ev) - eventStartMs(ev);
  return Number.isFinite(ms) && ms > 0 ? ms / 60_000 : 0;
}
