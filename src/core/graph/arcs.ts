/**
 * Arc geometry for the graph drawn over the real Bay — pure, so the browser imports it
 * directly (the pattern `City.tsx` already uses for `inBay` and `cellsInBbox`).
 *
 * ## Why a lifted Bézier and not a great circle
 *
 * `BAY_BOUNDS` spans ~120 km. At that scale a great circle is visually indistinguishable from
 * a straight line, so geodesic accuracy buys nothing. What the picture actually needs is
 * VERTICAL SEPARATION: without a bend, three edges between the same two venues draw as one
 * line and the weight information is lost.
 *
 * ## Why this function is allowed to return null
 *
 * **One NaN coordinate makes MapLibre silently drop the ENTIRE source.** Not the feature — the
 * source. Every arc vanishes and nothing is logged. There are two realistic ways to produce
 * one, and this module exists to stop both:
 *
 *   · a `(0, 0)` geocode. `events.latitude` comes from a geocoder, and Null Island is what a
 *     failed lookup looks like. An arc to it would be drawn straight through the Atlantic.
 *   · two events at the SAME venue. The chord is zero-length, its perpendicular is undefined,
 *     and the control point comes out NaN.
 *
 * So callers get `null` and skip the arc, rather than a plausible-looking geometry that takes
 * the whole layer down with it.
 */
import { inBay } from "../geo";

export type LngLat = [number, number];

export interface ArcOpts {
  /** Perpendicular offset as a fraction of the chord. 0.18 separates overlapping edges without
   *  making short arcs look like balloons. */
  bend?: number;
  steps?: number;
}

export const DEFAULT_BEND = 0.18;
const MIN_CHORD_DEG = 1e-7;

/**
 * Deterministic bend direction from the id pair.
 *
 * Without this, a↔b and b↔a bend opposite ways and render as a lens rather than one arc — the
 * same failure `friendships.user_low` prevents by ordering the pair. Cheap FNV-style hash so
 * the choice is stable across processes, not just within one.
 */
export function bendSign(aId: string, bId: string): 1 | -1 {
  const key = aId <= bId ? `${aId}|${bId}` : `${bId}|${aId}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // FNV's LOW bit is almost unmixed — the prime is odd, so bit 0 of h*prime is just bit 0 of
  // h, and the final bit ends up depending only on the parity of the odd character codes. For
  // ids as regular as `event:a1|event:b1` that is CONSTANT, and every arc bends the same way:
  // a fan, not a graph. The murmur3 fmix32 finalizer is what makes bit 0 usable.
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h & 1) === 0 ? 1 : -1;
}

/** Points along an arc, scaled to its length. A 1 km hop must not cost 48 coordinates. */
export function arcSteps(chordKm: number): number {
  if (!Number.isFinite(chordKm) || chordKm <= 0) return 8;
  return Math.max(8, Math.min(48, Math.round(chordKm)));
}

/**
 * Quadratic Bézier from `a` to `b`, in GeoJSON order (`[lng, lat]`, matching
 * `WalkRoute.polyline`).
 *
 * The perpendicular is computed in a local equirectangular frame — `dx = Δlng · cos(lat)` —
 * because at 37.7°N a degree of longitude is only ~79% of a degree of latitude. Skip that and
 * the bend visibly skews with the arc's orientation: north–south edges bow far more than
 * east–west ones.
 */
export function bezierArc(a: LngLat, b: LngLat, o: ArcOpts = {}): LngLat[] | null {
  const [aLng, aLat] = a;
  const [bLng, bLat] = b;
  if (![aLng, aLat, bLng, bLat].every(Number.isFinite)) return null;
  // A bad geocode must not draw a line to Null Island.
  if (!inBay(aLat, aLng) || !inBay(bLat, bLng)) return null;

  const latScale = Math.cos(((aLat + bLat) / 2) * (Math.PI / 180)) || 1;
  const dx = (bLng - aLng) * latScale;
  const dy = bLat - aLat;
  const chord = Math.hypot(dx, dy);
  // Two events at the same venue: the perpendicular is undefined and the control point would
  // be NaN, which would take the entire MapLibre source down with it.
  if (chord < MIN_CHORD_DEG) return null;

  const bend = Number.isFinite(o.bend as number) ? (o.bend as number) : DEFAULT_BEND;
  const sign = bend >= 0 ? 1 : -1;
  const mag = Math.abs(bend) * chord;
  // Rotate the chord 90° in the local frame, then convert back to degrees of longitude.
  const px = (-dy / chord) * mag * sign;
  const py = (dx / chord) * mag * sign;
  const cLng = (aLng + bLng) / 2 + px / latScale;
  const cLat = (aLat + bLat) / 2 + py;

  // ~111 km per degree is plenty precise for choosing a sample count.
  const steps = o.steps ?? arcSteps(chord * 111);
  const out: LngLat[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const lng = mt * mt * aLng + 2 * mt * t * cLng + t * t * bLng;
    const lat = mt * mt * aLat + 2 * mt * t * cLat + t * t * bLat;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null; // belt and braces
    out.push([lng, lat]);
  }
  return out;
}
