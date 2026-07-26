/**
 * The pedestrian cost model — PURE, one tunable constant, fully tested.
 *
 * "Avoid hills" is a real San Francisco feature, not a checkbox: the flat detour
 * around Nob Hill is genuinely the faster and far pleasanter walk. The model is
 * deliberately the simplest thing that captures that:
 *
 *     cost = length × (1 + k · max(0, grade)²)
 *
 * — quadratic so a gentle rise is nearly free and a 20 % SF block hurts, one-sided
 * so descents are never penalised (they're not free in real life, but penalising
 * them makes the router prefer *staying* high, which is wrong for a v1), and with
 * a single constant `k` so the behaviour is explainable and tunable from the UI.
 *
 * k = 0 turns hills off entirely; the cost is then exactly the ground length, so
 * the router degenerates to shortest-distance. DEFAULT_HILL_K = 25 makes a 20 %
 * grade cost double — i.e. the router will walk up to twice as far to avoid it.
 */
import { FLAG_STEPS } from "./graph";

/** A 20 % grade doubles the effective length (1 + 25 × 0.2² = 2). */
export const DEFAULT_HILL_K = 25;
/** Grades above this are noise or stairs; clamp so a bad DEM can't explode the cost. */
export const MAX_GRADE = 0.6;
/**
 * Metre-equivalents added per stairs arc when "avoid stairs" is on. Read it as
 * "I'd walk 400 m out of my way rather than carry this up a flight" — a soft
 * preference, so a route that ONLY exists via stairs is still returned rather
 * than failing. Pass a huge `stairsPenaltyM` to make step-free a hard constraint.
 */
export const STAIRS_PENALTY_M = 400;
/** Comfortable flat walking pace. 1.35 m/s ≈ 4.9 km/h ≈ 13 min/mile. */
export const WALK_SPEED_MPS = 1.35;
/** Naismith's rule, metricised: +1 minute per 10 m of climb. */
export const ASCENT_SECONDS_PER_M = 6;
/** Stairs slow you down beyond their length — one flight ≈ 8 s of fumbling. */
export const STAIRS_SECONDS = 8;

export interface CostOptions {
  /** Hill aversion. 0 = shortest distance. Defaults to 0 (the router passes it explicitly). */
  hillK?: number;
  /** Step-free routing (wheelchair, luggage, a scooter). */
  avoidStairs?: boolean;
  stairsPenaltyM?: number;
}

/** Rise over run, clamped and NaN-safe. */
export function slope(lengthM: number, riseM: number): number {
  if (!(lengthM > 0) || !Number.isFinite(riseM)) return 0;
  const g = riseM / lengthM;
  if (!Number.isFinite(g)) return 0;
  return Math.max(-MAX_GRADE, Math.min(MAX_GRADE, g));
}

/** The one-sided quadratic hill multiplier. Always ≥ 1 — which is exactly what
 *  keeps the straight-line A* heuristic admissible. */
export function hillMultiplier(grade: number, k: number): number {
  const up = Math.max(0, Math.min(MAX_GRADE, grade));
  return 1 + k * up * up;
}

/** Traversal cost of one arc, in "metre-equivalents" (always ≥ its ground length). */
export function edgeCostM(lengthM: number, riseM: number, flags: number, opts: CostOptions = {}): number {
  const k = opts.hillK ?? 0;
  let c = lengthM * hillMultiplier(slope(lengthM, riseM), k);
  if (opts.avoidStairs && (flags & FLAG_STEPS)) c += opts.stairsPenaltyM ?? STAIRS_PENALTY_M;
  return c;
}

/** Wall-clock estimate for a finished route. Distance + climb + stairs fumbling. */
export function etaSeconds(distanceM: number, ascentM: number, stairsArcs: number): number {
  return distanceM / WALK_SPEED_MPS + ascentM * ASCENT_SECONDS_PER_M + stairsArcs * STAIRS_SECONDS;
}
