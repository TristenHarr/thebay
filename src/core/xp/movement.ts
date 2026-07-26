/**
 * Movement → XP — the pure core of "mobbing" (turn on live movement, gain
 * Experience for actually moving through the city). Server-authoritative: the
 * Worker computes distance between your consecutive pings (haversine) and calls
 * this; the client's claimed distance is never trusted.
 *
 * By design the game is SEMI-CHEATABLE — someone faking their GPS still earns XP
 * (we're not fighting spoofers). But every segment records its implied speed and a
 * `flagged` bit, so the movement tracker can show who's teleporting. Two caps keep
 * it sane: a per-segment distance ceiling (one giant jump can't farm unlimited XP)
 * and a daily total (enforced in the repo).
 */
export const XP_PER_METRE = 1 / 25; // 25 m walked = 1 XP
export const MAX_SEGMENT_M = 1500; // a single ping counts at most this toward XP
export const IMPLAUSIBLE_MPS = 15; // ~54 km/h — faster than running/cycling ⇒ flag
export const DAILY_MOVEMENT_XP_CAP = 500; // ≈ 12.5 km/day earns the ceiling

export interface Segment {
  xp: number; // XP earned for this segment (after the per-segment cap)
  counted: number; // metres that counted toward XP (≤ MAX_SEGMENT_M)
  mps: number; // implied speed, m/s (for the tracker)
  flagged: boolean; // implausible speed OR beyond the per-segment cap
}

/** XP + telemetry for one movement segment (distance since the last ping, and dt). */
export function segmentXp(distanceMeters: number, dtMs: number): Segment {
  const dist = Math.max(0, Number.isFinite(distanceMeters) ? distanceMeters : 0);
  const counted = Math.min(dist, MAX_SEGMENT_M);
  const xp = Math.floor(counted * XP_PER_METRE);
  const mps = dtMs > 0 ? dist / (dtMs / 1000) : 0;
  const flagged = mps > IMPLAUSIBLE_MPS || dist > MAX_SEGMENT_M;
  return { xp, counted, mps: Math.round(mps * 10) / 10, flagged };
}
