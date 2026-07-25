/**
 * Relative time for metadata lines. Compact by design ("3h", "2d") — the meta row
 * is dense mono and a full date would dominate the title it sits under.
 * Pure: the clock is a parameter, so every case is testable.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function timeAgo(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = nowMs - t;
  if (d < 0) return "now"; // clock skew shouldn't render "-3h"
  if (d < MIN) return "now";
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 30 * DAY) return `${Math.floor(d / DAY)}d`;
  if (d < 365 * DAY) return `${Math.floor(d / (30 * DAY))}mo`;
  return `${Math.floor(d / (365 * DAY))}y`;
}

/** Human date for the item page byline, e.g. "25 Jul 2026". */
export function longDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("en-US", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

/** RFC-822 date for RSS <pubDate>. */
export function rfc822(iso: string): string {
  const t = Date.parse(iso);
  return new Date(Number.isFinite(t) ? t : Date.now()).toUTCString();
}
