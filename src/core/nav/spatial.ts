/**
 * Snapping a tap / a venue's lat-lng to the nearest walkable graph node — PURE.
 *
 * A linear scan over a Bay-wide graph is millions of haversines per tap, on the
 * UI's critical path. A flat lat/lng bucket grid turns it into "look in this cell,
 * then widen the ring until the ring's own minimum possible distance exceeds the
 * best hit so far" — which is exact, not approximate.
 */
import { COORD_SCALE, nodeLat, nodeLng, metresBetween, type WalkGraph } from "./graph";

export interface NodeIndex {
  /** Cell size in degrees (both axes). */
  cellDeg: number;
  /** cellKey → node ids. */
  buckets: Map<number, number[]>;
  minLatCell: number;
  minLngCell: number;
  latCells: number;
  lngCells: number;
}

/** ~0.002° ≈ 220 m — a couple of city blocks, so a populated cell holds tens of nodes. */
export const DEFAULT_CELL_DEG = 0.002;

const keyOf = (latCell: number, lngCell: number) => latCell * 4_000_000 + lngCell;

export function buildNodeIndex(g: WalkGraph, cellDeg = DEFAULT_CELL_DEG): NodeIndex {
  const buckets = new Map<number, number[]>();
  let minLatCell = Infinity, maxLatCell = -Infinity, minLngCell = Infinity, maxLngCell = -Infinity;
  for (let i = 0; i < g.nodeCount; i++) {
    const la = Math.floor(g.coords[2 * i]! / COORD_SCALE / cellDeg);
    const lo = Math.floor(g.coords[2 * i + 1]! / COORD_SCALE / cellDeg);
    minLatCell = Math.min(minLatCell, la); maxLatCell = Math.max(maxLatCell, la);
    minLngCell = Math.min(minLngCell, lo); maxLngCell = Math.max(maxLngCell, lo);
    const k = keyOf(la, lo);
    const b = buckets.get(k);
    if (b) b.push(i); else buckets.set(k, [i]);
  }
  if (!Number.isFinite(minLatCell)) { minLatCell = 0; maxLatCell = 0; minLngCell = 0; maxLngCell = 0; }
  return { cellDeg, buckets, minLatCell, minLngCell, latCells: maxLatCell - minLatCell + 1, lngCells: maxLngCell - minLngCell + 1 };
}

export interface NearestOptions {
  index?: NodeIndex | null;
  /** Give up past this radius (metres). Default 2 km — beyond that you're not walking. */
  maxMetres?: number;
}

/** Index of the closest node, or -1 if nothing is within `maxMetres`. */
export function nearestNode(g: WalkGraph, lat: number, lng: number, opts: NearestOptions = {}): number {
  const maxMetres = opts.maxMetres ?? 2000;
  if (g.nodeCount === 0) return -1;
  const idx = opts.index;
  if (!idx) {
    let best = -1, bestM = maxMetres;
    for (let i = 0; i < g.nodeCount; i++) {
      const m = metresBetween(lat, lng, nodeLat(g, i), nodeLng(g, i));
      if (m <= bestM) { bestM = m; best = i; }
    }
    return best;
  }

  const { cellDeg } = idx;
  const la0 = Math.floor(lat / cellDeg), lo0 = Math.floor(lng / cellDeg);
  // Metres per cell, worst case, at this latitude — used to bound the ring search.
  const mPerLatCell = cellDeg * 111_320;
  const mPerLngCell = cellDeg * 111_320 * Math.max(0.05, Math.cos(lat * (Math.PI / 180)));
  const mPerRing = Math.min(mPerLatCell, mPerLngCell);
  const maxRing = Math.max(idx.latCells, idx.lngCells) + 1;

  let best = -1, bestM = Infinity;
  for (let ring = 0; ring <= maxRing; ring++) {
    // Everything in this ring is at least (ring − 1) cells away; once that floor
    // beats our best hit, no wider ring can improve it.
    if (best >= 0 && (ring - 1) * mPerRing > bestM) break;
    if ((ring - 1) * mPerRing > maxMetres) break;
    for (let dla = -ring; dla <= ring; dla++) {
      const edge = Math.abs(dla) === ring;
      for (let dlo = -ring; dlo <= ring; dlo++) {
        if (!edge && Math.abs(dlo) !== ring) continue; // interior already scanned
        const b = idx.buckets.get(keyOf(la0 + dla, lo0 + dlo));
        if (!b) continue;
        for (const i of b) {
          const m = metresBetween(lat, lng, nodeLat(g, i), nodeLng(g, i));
          if (m < bestM) { bestM = m; best = i; }
        }
      }
    }
  }
  return best >= 0 && bestM <= maxMetres ? best : -1;
}
