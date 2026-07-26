/**
 * Freshness decay for crowd-sourced places — pure, no I/O, shared by the repo
 * (ranking), the routes (what the map shows) and the client (the badge).
 *
 * A confirmation is a statement about a MOMENT, not a fact forever. "There's
 * parking on this block" is worthless six hours later; "this café has free wifi"
 * is still true in three months. So every place kind carries its own
 * `half_life_hours` and trust is the vouch balance scaled by an exponential:
 *
 *     trust = (confirms − 1.5·disputes) · exp(−ageHours / halfLifeHours)
 *
 * Disputes outweigh confirms 1.5:1 because a wrong pin costs a user a wasted
 * trip, while a missing pin costs them nothing they didn't already lack.
 *
 * Everything here is total: no input — NaN, a garbage date, a zero half-life —
 * can produce NaN, because this number sorts the map and a NaN comparator
 * silently scrambles the whole list.
 */

/** Sensible half-lives (hours) for the seeded kinds. The DB column is the
 *  authority per kind; these are the defaults it's seeded with and the fallback
 *  when a caller has no kind row to hand. */
export const HALF_LIFE = {
  /** Street legality changes by the hour — a 6h-old "spots here" is a guess. */
  parking: 6,
  /** Restrooms/water/outlets: the building doesn't move, but policies drift. */
  default: 720,
  /** Amenities that change only when a business does. */
  amenity: 2160,
} as const;

const DISPUTE_WEIGHT = 1.5;

/** Coerce to a finite number, else `fallback`. Guards every arithmetic input. */
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** Milliseconds for an ISO string, or null if it isn't a date. */
function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * exp(−age / halfLife), clamped to [0, 1]. Age below zero (a clock skew, a
 * future-dated import) is treated as brand new rather than amplified into a
 * score above its vouch count.
 */
export function decayFactor(ageHours: number, halfLifeHours: number): number {
  const age = Math.max(0, num(ageHours, 0));
  const hl = Math.max(1e-6, num(halfLifeHours, HALF_LIFE.default));
  const f = Math.exp(-age / hl);
  return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
}

export interface Vouchable {
  confirms: number;
  disputes: number;
  /** When the pin was first dropped — the clock until someone re-confirms it. */
  createdAt: string;
  /** The last time a human stood there and said "still true". Wins when present. */
  lastConfirmedAt?: string | null;
  /** From the place's kind. Falsy ⇒ the generic default. */
  halfLifeHours?: number | null;
}

/** Hours since the place was last vouched for (or created). Never negative. */
export function ageHours(p: Vouchable, at: string | Date = new Date()): number {
  const now = at instanceof Date ? at.getTime() : (ms(at) ?? Date.now());
  const anchor = ms(p.lastConfirmedAt) ?? ms(p.createdAt) ?? now;
  return Math.max(0, (now - anchor) / 3_600_000);
}

/** The one score that ranks a place. See the module doc for the formula. */
export function trustScore(p: Vouchable, at: string | Date = new Date()): number {
  const balance = num(p.confirms) - DISPUTE_WEIGHT * num(p.disputes);
  const hl = num(p.halfLifeHours, HALF_LIFE.default) || HALF_LIFE.default;
  const score = balance * decayFactor(ageHours(p, at), hl);
  return Number.isFinite(score) ? score : 0;
}

export type Freshness = "fresh" | "aging" | "stale" | "disputed";

/**
 * The human label the map badge shows. Thresholds are in half-lives, not hours,
 * so "fresh" means the same thing for parking (6h) as for free wifi (90 days).
 */
export function freshness(p: Vouchable, at: string | Date = new Date()): Freshness {
  if (num(p.confirms) - DISPUTE_WEIGHT * num(p.disputes) <= 0) return "disputed";
  const hl = num(p.halfLifeHours, HALF_LIFE.default) || HALF_LIFE.default;
  const halfLives = ageHours(p, at) / hl;
  if (halfLives < 1) return "fresh";
  if (halfLives < 4) return "aging";
  return "stale";
}
