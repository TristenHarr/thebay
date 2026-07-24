import { DateTime } from "luxon";

function hasOffset(s: string): boolean {
  return /([zZ])$|([+-]\d{2}:?\d{2})$/.test(s.trim());
}

function parse(raw: string | Date, zone: string): DateTime {
  if (raw instanceof Date) {
    // A JS Date is an absolute instant; keep the instant, express in UTC.
    return DateTime.fromJSDate(raw, { zone: "utc" });
  }
  const s = raw.trim();
  // If the string carries its own offset, respect it; otherwise interpret the
  // wall-clock time in the intended zone (city/hint).
  let dt = hasOffset(s)
    ? DateTime.fromISO(s, { setZone: true })
    : DateTime.fromISO(s, { zone });
  if (dt.isValid) return dt;
  dt = DateTime.fromRFC2822(s, { setZone: true });
  if (dt.isValid) return dt;
  const ms = Date.parse(s);
  if (!Number.isNaN(ms)) return DateTime.fromMillis(ms, { zone: "utc" });
  return DateTime.invalid("unparseable-datetime");
}

export interface ResolvedTimes {
  startUtc: string;
  endUtc: string | null;
  timezone: string;
}

/**
 * Resolve raw start/end into an absolute UTC instant plus the IANA timezone to
 * display it in. Display zone prefers an explicit source hint, then the city's
 * timezone (so events render in local wall-clock time).
 */
export function resolveTimes(input: {
  startRaw: string | Date;
  endRaw?: string | Date | null;
  timezoneHint?: string | null;
  cityTimezone: string;
}): ResolvedTimes | null {
  const zone = input.timezoneHint || input.cityTimezone || "UTC";
  const start = parse(input.startRaw, zone);
  if (!start.isValid) return null;
  const end = input.endRaw ? parse(input.endRaw, zone) : null;
  const iso = (d: DateTime) => d.toUTC().toISO({ suppressMilliseconds: true });
  return {
    startUtc: iso(start)!,
    endUtc: end && end.isValid ? iso(end) : null,
    timezone: input.timezoneHint || input.cityTimezone || "UTC",
  };
}

/** Local calendar date (YYYY-MM-DD) of an instant, in the given zone. */
export function localDay(startUtc: string, timezone: string): string {
  const d = DateTime.fromISO(startUtc, { zone: "utc" }).setZone(timezone);
  return d.isValid ? d.toISODate()! : startUtc.slice(0, 10);
}
