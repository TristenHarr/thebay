import { DateTime } from "luxon";
import { haversineKm } from "../geofence";
import { decayFactor, trustScore, HALF_LIFE, type Vouchable } from "./trust";

/**
 * Parking — the headline pain point of the crowd city map, and the only place
 * kind whose *legality is a function of time*. Pure, no I/O: the same code runs
 * in the Worker (the "parking near this venue" endpoint) and in the browser (the
 * live string on the map pin).
 *
 * Two things break every naive implementation of this, so both are load-bearing
 * here and both are tested:
 *
 *  1. **DST.** Everything is wall-clock in `America/Los_Angeles`. "Sunday 8am"
 *     from Saturday 11pm is 9 hours on the wall and 8 (or 10) real hours across
 *     a transition. All arithmetic goes through luxon in the zone, never
 *     `+ n * 3600_000`.
 *  2. **Week wraparound.** It's Saturday, sweeping is Monday, the month rolls
 *     over, and SF sweeps "1st & 3rd Tuesday" — so occurrences are searched
 *     forward day by day, honouring week-of-month, not computed by modular
 *     arithmetic on a weekday index.
 *
 * The output is one sentence — "Legal for 2h 15m, then street sweeping" — which
 * is the single most useful string this whole feature produces.
 */

export const PARKING_ZONE = "America/Los_Angeles";

/** The declarative attrs a `parking` place carries (mirrors its kind's `fields_json`). */
export interface ParkingAttrs {
  type?: "street" | "garage" | "lot";
  /**
   * When the meter is enforced, e.g. "09:00-18:00" or "Mon-Sat 09:00-18:00".
   * NB: only the TIME component is honoured today — a day prefix is parsed past,
   * not applied — so a Sunday reads as metered where the sign says otherwise.
   * A meter is a cost, never a legality, so the worst case is an over-cautious
   * note; street sweeping (which IS a legality) is fully day-aware below.
   */
  meterHours?: string | null;
  /** Residential permit zone letter. Non-permit holders get a capped stay. */
  rppZone?: string | null;
  /** When the permit rule applies (time of day). Absent ⇒ all day. */
  rppHours?: string | null;
  /** Non-permit maximum stay inside `rppHours`. Absent ⇒ 120 minutes (the SF norm). */
  rppLimitMinutes?: number | null;
  /** Street-sweeping weekday: "Tue", "Tues", "Tuesday" — all accepted. */
  sweepDay?: string | null;
  /** Street-sweeping window, e.g. "08:00-10:00". */
  sweepWindow?: string | null;
  /** Weeks of the month it actually sweeps (1–5). Absent ⇒ every week. */
  sweepWeeks?: number[] | null;
  /** Free-text price, shown verbatim ("$3.50/hr", "$25/day"). */
  priceHint?: string | null;
  evCharging?: boolean | null;
  /** Clearance in feet — the thing that ruins a van owner's evening. */
  maxHeight?: number | null;
  /** Garage/lot opening hours, e.g. "05:00-20:00". Absent ⇒ 24h. */
  hours?: string | null;
}

export interface ParkingVerdict {
  legal: boolean;
  /** ISO instant at which this verdict stops holding, or null if nothing changes. */
  until: string | null;
  /** The sentence to show. Always non-empty. */
  reason: string;
}

const RPP_DEFAULT_MINUTES = 120;
const MIN = 60_000;

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const iso = (d: DateTime): string => new Date(d.toMillis()).toISOString();

/** Human duration, the way a person says it: "45m", "2h 15m", "1d 18h". */
export function formatDuration(minutes: number): string {
  const m = Number.isFinite(minutes) ? Math.round(minutes) : 0;
  if (m <= 0) return "0m";
  if (m < 60) return `${m}m`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  }
  const d = Math.floor(m / 1440);
  const rh = Math.round((m % 1440) / 60);
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/** Luxon weekday (Mon=1 … Sun=7) from anything a human or DataSF writes. */
function parseWeekday(raw: unknown): number | null {
  if (!isStr(raw)) return null;
  const k = raw.trim().toLowerCase().replace(/[^a-z]/g, "").slice(0, 3);
  const map: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
  return map[k] ?? null;
}

interface Window { fromH: number; fromM: number; toH: number; toM: number }

/** "08:00-10:00", "8-10", "Mon-Sat 09:00-18:00" → the time window (day prefix ignored). */
function parseWindow(raw: unknown): Window | null {
  if (!isStr(raw)) return null;
  const m = /(\d{1,2}):?(\d{2})?\s*(?:-|–|—|to|until)\s*(\d{1,2}):?(\d{2})?/i.exec(raw);
  if (!m) return null;
  const fromH = Number(m[1]), fromM = Number(m[2] ?? 0), toH = Number(m[3]), toM = Number(m[4] ?? 0);
  const ok = (h: number, mi: number) => Number.isFinite(h) && Number.isFinite(mi) && h >= 0 && h <= 24 && mi >= 0 && mi < 60;
  return ok(fromH, fromM) && ok(toH, toM) ? { fromH, fromM, toH, toM } : null;
}

/** SF's convention: the 1st Tuesday is the Tuesday in days 1–7, and so on. */
const weekOfMonth = (dayOfMonth: number): number => Math.floor((dayOfMonth - 1) / 7) + 1;

function nowIn(at: string | Date): DateTime {
  const dt = at instanceof Date ? DateTime.fromJSDate(at, { zone: PARKING_ZONE }) : DateTime.fromISO(at, { zone: PARKING_ZONE });
  return dt.isValid ? dt : DateTime.now().setZone(PARKING_ZONE);
}

/** Apply a window to a local calendar day, rolling an overnight window's end forward. */
function windowOn(day: DateTime, w: Window): { start: DateTime; end: DateTime } {
  const start = day.set({ hour: w.fromH % 24, minute: w.fromM, second: 0, millisecond: 0 });
  let end = day.set({ hour: w.toH % 24, minute: w.toM, second: 0, millisecond: 0 });
  if (w.toH === 24) end = day.plus({ days: 1 }).startOf("day");
  if (end <= start) end = end.plus({ days: 1 });
  return { start, end };
}

export interface SweepOccurrence {
  /** ISO instant the window opens. */
  start: string;
  /** ISO instant it closes. */
  end: string;
  /** True when `at` is inside the window right now. */
  active: boolean;
}

/**
 * The current-or-next street-sweeping occurrence, searched forward day by day in
 * local wall-clock (so DST and month/week rollover are free), honouring
 * `sweepWeeks`. Null when the schedule is missing or unparseable — an unknown
 * schedule must never be reported as a restriction.
 */
export function nextSweeping(attrs: ParkingAttrs | null | undefined, at: string | Date): SweepOccurrence | null {
  const a = attrs ?? {};
  const wd = parseWeekday(a.sweepDay);
  const win = parseWindow(a.sweepWindow);
  if (!wd || !win) return null;
  const weeks = Array.isArray(a.sweepWeeks) ? a.sweepWeeks.filter((n) => Number.isFinite(n)) : null;
  const now = nowIn(at);
  // 9 days covers "today is the 4th Tuesday, next is the 1st of next month" too,
  // because we keep scanning until we've seen 5 candidate weekdays.
  let seen = 0;
  for (let i = 0; i <= 40 && seen < 6; i++) {
    const day = now.startOf("day").plus({ days: i });
    if (day.weekday !== wd) continue;
    seen++;
    if (weeks && weeks.length && !weeks.includes(weekOfMonth(day.day))) continue;
    const { start, end } = windowOn(day, win);
    if (end <= now) continue;
    return { start: iso(start), end: iso(end), active: start <= now };
  }
  return null;
}

/** Is `at` inside a daily window (no weekday component)? */
function insideDailyWindow(raw: unknown, at: string | Date): { inside: boolean; start: DateTime; end: DateTime } | null {
  const win = parseWindow(raw);
  if (!win) return null;
  const now = nowIn(at);
  const today = windowOn(now.startOf("day"), win);
  if (now >= today.start && now < today.end) return { inside: true, ...today };
  // an overnight window may still be running from yesterday
  const yest = windowOn(now.startOf("day").minus({ days: 1 }), win);
  if (now >= yest.start && now < yest.end) return { inside: true, ...yest };
  const next = now < today.start ? today : windowOn(now.startOf("day").plus({ days: 1 }), win);
  return { inside: false, start: next.start, end: next.end };
}

const clock = (isoStr: string): string => DateTime.fromISO(isoStr, { zone: PARKING_ZONE }).toFormat("h:mm a");
const minutesBetween = (fromIso: string | Date, toIso: string): number =>
  (Date.parse(toIso) - (fromIso instanceof Date ? fromIso.getTime() : Date.parse(fromIso))) / MIN;

/**
 * "Can I park here right now?" — the one call the pin, the detail sheet and the
 * event page all make. Total: any attrs, however malformed, produce a usable
 * sentence rather than an exception.
 */
export function canIParkHere(place: { attrs?: ParkingAttrs | null } | null | undefined, at: string | Date = new Date()): ParkingVerdict {
  const a: ParkingAttrs = (place?.attrs && typeof place.attrs === "object" ? place.attrs : {}) as ParkingAttrs;
  const notes: string[] = [];
  const price = isStr(a.priceHint) ? a.priceHint.trim() : null;
  if (a.evCharging) notes.push("EV charging");
  if (typeof a.maxHeight === "number" && Number.isFinite(a.maxHeight)) notes.push(`max height ${a.maxHeight} ft`);
  const decorate = (head: string): string => [head, ...notes].join(" · ");

  // ── off-street: the only question is whether it's open ──────────────────────
  if (a.type === "garage" || a.type === "lot") {
    const label = a.type === "garage" ? "Garage" : "Lot";
    if (price) notes.unshift(price);
    const w = insideDailyWindow(a.hours, at);
    if (!w) return { legal: true, until: null, reason: decorate(`${label} — open 24h`) };
    if (!w.inside) return { legal: false, until: iso(w.start), reason: decorate(`${label} closed — opens ${clock(iso(w.start))}`) };
    return { legal: true, until: iso(w.end), reason: decorate(`${label} open until ${clock(iso(w.end))}`) };
  }

  // ── street: sweeping is the hard rule, RPP is the soft one ──────────────────
  const sweep = nextSweeping(a, at);
  if (sweep?.active) {
    return { legal: false, until: sweep.end, reason: decorate(`Street sweeping until ${clock(sweep.end)} — you will be ticketed`) };
  }

  const meter = insideDailyWindow(a.meterHours, at);
  if (meter?.inside) notes.unshift(`metered until ${clock(iso(meter.end))}${price ? ` (${price})` : ""}`);
  else if (price) notes.unshift(price);

  // Residential permit: a non-permit car gets a capped stay while the rule runs.
  let rppDeadline: string | null = null;
  if (isStr(a.rppZone)) {
    const hours = insideDailyWindow(a.rppHours, at);
    const applies = !hours || hours.inside;
    if (applies) {
      const cap = Number.isFinite(a.rppLimitMinutes as number) && (a.rppLimitMinutes as number) > 0 ? (a.rppLimitMinutes as number) : RPP_DEFAULT_MINUTES;
      const from = at instanceof Date ? at.getTime() : Date.parse(at);
      rppDeadline = new Date((Number.isNaN(from) ? Date.now() : from) + cap * MIN).toISOString();
    }
  }

  const candidates: Array<{ until: string; cause: string }> = [];
  if (sweep) candidates.push({ until: sweep.start, cause: "street sweeping" });
  if (rppDeadline) candidates.push({ until: rppDeadline, cause: `permit zone ${String(a.rppZone).trim()} only` });
  candidates.sort((x, y) => Date.parse(x.until) - Date.parse(y.until));

  const first = candidates[0];
  if (!first) return { legal: true, until: null, reason: decorate("Legal — no posted restriction") };
  return {
    legal: true,
    until: first.until,
    reason: decorate(`Legal for ${formatDuration(minutesBetween(at, first.until))}, then ${first.cause}`),
  };
}

/* ────────────────────────── live difficulty (crowd tips) ────────────────────── */

export interface DifficultyTip {
  createdAt: string;
  attrs?: { difficulty?: number; minutesToFind?: number } | null;
}
export interface DifficultySignal {
  /** 1 (empty street) … 5 (circle for twenty minutes). Null with no usable tips. */
  difficulty: number | null;
  minutesToFind: number | null;
  samples: number;
}

/**
 * The block-level heat signal: `verdict:'tip'` reports, decayed so a report from
 * twenty minutes ago drowns out one from Tuesday. Same decay curve as trust, at
 * parking's half-life — how hard it was to park is exactly as perishable as
 * whether the spot exists.
 */
export function parkingDifficulty(tips: DifficultyTip[], at: string | Date = new Date(), halfLifeHours: number = HALF_LIFE.parking): DifficultySignal {
  const now = at instanceof Date ? at.getTime() : Date.parse(at);
  const base = Number.isNaN(now) ? Date.now() : now;
  let wSum = 0, dSum = 0, mWSum = 0, mSum = 0, samples = 0;
  for (const t of tips ?? []) {
    const d = t?.attrs?.difficulty;
    if (typeof d !== "number" || !Number.isFinite(d) || d < 1 || d > 5) continue;
    const ts = Date.parse(t.createdAt);
    const ageH = Number.isNaN(ts) ? 0 : Math.max(0, (base - ts) / 3_600_000);
    const w = decayFactor(ageH, halfLifeHours);
    samples++;
    wSum += w;
    dSum += w * d;
    const mtf = t?.attrs?.minutesToFind;
    if (typeof mtf === "number" && Number.isFinite(mtf) && mtf >= 0) { mWSum += w; mSum += w * mtf; }
  }
  return {
    difficulty: wSum > 0 ? dSum / wSum : null,
    minutesToFind: mWSum > 0 ? mSum / mWSum : null,
    samples,
  };
}

/* ────────────────────────── event-aware ranking ─────────────────────────────── */

export interface RankablePlace extends Vouchable {
  id: string;
  lat: number;
  lng: number;
  attrs?: ParkingAttrs | null;
}
export interface RankOpts {
  lat: number;
  lng: number;
  /** The instant to judge legality at — for an event, its start. */
  at: string | Date;
  radiusKm?: number;
  limit?: number;
}
export type RankedParking<T extends RankablePlace> = T & {
  km: number;
  trust: number;
  legal: boolean;
  until: string | null;
  reason: string;
  score: number;
};

/** 300m is the "would I walk it in heels" reference distance. */
const DIST_REF_KM = 0.3;
/** An illegal spot isn't removed — sometimes it's the only option and the sweep
 *  ends before you leave — but it must never outrank a legal one nearby. */
const ILLEGAL_PENALTY = 0.15;

/**
 * "Parking near this venue", ranked by distance × trust × legality **at the
 * event's start time**. Deterministic: ties break on distance then id, so the
 * same inputs always produce the same list.
 */
export function rankParking<T extends RankablePlace>(places: T[], opts: RankOpts): Array<RankedParking<T>> {
  const radius = Number.isFinite(opts.radiusKm as number) ? (opts.radiusKm as number) : 1.2;
  const limit = Number.isFinite(opts.limit as number) ? Math.max(1, Math.trunc(opts.limit as number)) : 20;
  const out: Array<RankedParking<T>> = [];
  for (const p of places ?? []) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lng)) continue;
    const km = haversineKm(opts.lat, opts.lng, p.lat, p.lng);
    if (km > radius) continue;
    const verdict = canIParkHere(p, opts.at);
    const trust = trustScore({ ...p, halfLifeHours: p.halfLifeHours ?? HALF_LIFE.parking }, opts.at);
    const score = Math.max(0.05, 1 + trust) * (1 / (1 + km / DIST_REF_KM)) * (verdict.legal ? 1 : ILLEGAL_PENALTY);
    out.push({ ...p, km, trust, legal: verdict.legal, until: verdict.until, reason: verdict.reason, score });
  }
  out.sort((a, b) => b.score - a.score || a.km - b.km || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.slice(0, limit);
}
