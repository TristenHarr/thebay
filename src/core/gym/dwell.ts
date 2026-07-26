/**
 * Dwell time — what "you were there" is actually worth.
 *
 * The product rule the user asked for: host awards are capped **by time attended**. So
 * the per-recipient ceiling from `budget.ts` is multiplied by this, and the only way to
 * raise your own multiplier is to still be inside the geofence when the door code
 * rotates — which is to say, to still be at the event.
 *
 * Pure and total. The inputs are `event_presence.first_at` / `last_at`, both TEXT
 * timestamps, and a clock skew or a bad row must degrade to "no extra credit" rather
 * than to a NaN that silently makes a cap `NaN` and an award unbounded.
 */
import { eventLengthMinutes, type EventWindow } from "./window";

/** Below this, a presence is a drive-by and earns no multiplier at all. */
export const DWELL_FLOOR_MIN = 10;

/** At or above this, the full per-recipient cap is available. */
export const DWELL_FULL_MIN = 90;

/**
 * What clearing the floor is worth, before any ramp.
 *
 * Non-zero deliberately. A multiplier that is 0 both *below* and *at* the floor means
 * someone who stayed exactly the minimum gets nothing, which reads as a broken feature
 * rather than as a rule. A quarter of the cap for showing up properly, rising to all of
 * it for staying, is a gradient people can understand from one glance at the meter.
 */
export const DWELL_FLOOR_SHARE = 0.25;

const clean = (x: number): number => (Number.isNaN(x) ? 0 : x > 0 ? x : 0);

/**
 * 0 below the floor; `DWELL_FLOOR_SHARE` at the floor; ramping linearly to 1.0 at
 * `DWELL_FULL_MIN` and clamped there.
 */
export function dwellMultiplier(minutes: number): number {
  const m = clean(minutes);
  if (m < DWELL_FLOOR_MIN) return 0;
  if (m >= DWELL_FULL_MIN) return 1;
  const ramp = (m - DWELL_FLOOR_MIN) / (DWELL_FULL_MIN - DWELL_FLOOR_MIN);
  return DWELL_FLOOR_SHARE + (1 - DWELL_FLOOR_SHARE) * ramp;
}

/** Minutes between the first and last verified scan. 0 for a single scan, for reversed
 *  timestamps, and for anything unparseable. */
export function dwellMinutes(firstAt: string, lastAt: string): number {
  const a = Date.parse(firstAt);
  const b = Date.parse(lastAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (b - a) / 60_000);
}

/**
 * Minutes to actually credit a presence record.
 *
 * Two adjustments to the raw span, in this order:
 *
 *  · **floored at `DWELL_FLOOR_MIN`.** A presence row cannot exist without a live,
 *    geofenced scan inside the event's window, so simply having one is worth the floor
 *    tier. Otherwise an honest attendee who scans once and never again — which is most
 *    of them — would be worth nothing, and hosts would be unable to reward the people
 *    who actually turned up.
 *
 *  · **capped at the event's own scheduled length** when a window is supplied. Without
 *    this, a last scan that lands hours after the event ended (a phone left open, a
 *    clock skew, a rotating door screen nobody switched off) would credit the gap.
 */
export function creditedMinutes(firstAt: string, lastAt: string, ev?: EventWindow): number {
  const raw = dwellMinutes(firstAt, lastAt);
  const length = ev ? eventLengthMinutes(ev) : 0;
  const capped = length > 0 ? Math.min(raw, length) : raw;
  return Math.max(DWELL_FLOOR_MIN, capped);
}
