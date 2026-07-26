/**
 * Turning "tonight" / "this weekend" into a UTC range.
 *
 * This has to be done in the BAY's timezone, not the server's and not UTC. At
 * 20:00Z it is 13:00 in San Francisco: a UTC-day implementation would answer
 * "tonight" with events starting at 4pm today and cut off at 5pm — and on the
 * flip side would call a 9pm Friday event "Saturday". The whole product is one
 * metro area, so a single IANA zone is the correct model here, not a per-user one.
 *
 * Pure: `now` is injected, so every window is testable against a pinned clock.
 * DST is handled by reading the offset at `now`; a window that straddles a
 * transition is off by an hour at its far edge, which no one can perceive in an
 * event listing.
 */
import type { SearchWindow } from "./parse";

export const BAY_TZ = "America/Los_Angeles";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Events already under way still count as "upcoming" for six hours. Same grace
 *  the events API and the Discover filter already use. */
const GRACE_MS = 6 * HOUR;

/** Local hour the evening starts / the night is considered over. */
const EVENING_START_H = 17;
const NIGHT_END_H = 4;

export interface DateRange {
  from?: string;
  to?: string;
}

/** Milliseconds to add to a UTC instant to get the wall clock in `tz`. */
export function tzOffsetMs(at: number, tz: string = BAY_TZ): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * Resolve a parsed window to an absolute `[from, to]` in ISO-8601 UTC.
 * No window ⇒ "upcoming": everything from six hours ago, no upper bound.
 */
export function windowRange(
  window: SearchWindow | undefined,
  now: number = Date.now(),
  tz: string = BAY_TZ,
): DateRange {
  const iso = (ms: number) => new Date(ms).toISOString();
  const grace = now - GRACE_MS;
  if (!window) return { from: iso(grace) };

  const offset = tzOffsetMs(now, tz);
  const localNow = now + offset;
  const localDayStart = Math.floor(localNow / DAY) * DAY;
  /** A wall-clock instant in `tz` → the real UTC instant. */
  const toUtc = (localMs: number) => localMs - offset;
  const localDow = new Date(localDayStart).getUTCDay(); // 0=Sun … 6=Sat

  switch (window) {
    case "today":
      return { from: iso(grace), to: iso(toUtc(localDayStart + DAY)) };

    case "tonight":
      return {
        // Never rewind past the present: asked at 11pm, "tonight" starts now.
        from: iso(Math.max(toUtc(localDayStart + EVENING_START_H * HOUR), now - HOUR)),
        to: iso(toUtc(localDayStart + DAY + NIGHT_END_H * HOUR)),
      };

    case "weekend": {
      // Fri/Sat/Sun ⇒ the weekend we're already in; otherwise the next one.
      const toFriday = localDow === 0 ? -2 : localDow === 6 ? -1 : localDow === 5 ? 0 : 5 - localDow;
      const friday = localDayStart + toFriday * DAY;
      return {
        from: iso(toFriday > 0 ? toUtc(friday) : grace),
        to: iso(toUtc(friday + 3 * DAY + NIGHT_END_H * HOUR)), // through Monday 4am
      };
    }

    case "7d":
      return { from: iso(grace), to: iso(now + 7 * DAY) };

    case "30d":
      return { from: iso(grace), to: iso(now + 30 * DAY) };
  }
}
