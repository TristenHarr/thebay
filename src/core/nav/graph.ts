/**
 * The pedestrian walking graph, in CSR (compressed sparse row) form.
 *
 * PURE — no I/O, no browser, no Worker APIs. The exact same structure is produced
 * by `scripts/build-walk-graph.mjs` (from a Geofabrik .osm.pbf), shipped as a
 * binary pack (see ./format.ts), read back in the browser's routing Web Worker,
 * and exercised by the unit tests on hand-built synthetic graphs.
 *
 * Why CSR: a Bay-wide footpath graph is millions of nodes. Object graphs would be
 * hundreds of megabytes of GC pressure; six flat typed arrays are a single
 * contiguous download that the router walks with zero allocation.
 *
 * The graph is UNDIRECTED BY CONSTRUCTION — every way contributes two directed
 * arcs. Pedestrians ignore `oneway` (the rare `oneway:foot` escalator is modelled
 * as a one-way *way* upstream by simply not emitting the reverse arc there; the
 * router only assumes that if an arc u→v exists, an arc v→u with the same length
 * and flags exists too, which the builder guarantees). That symmetry is what lets
 * the backward half of the bidirectional search reuse the same adjacency.
 */
import { haversineKm } from "../geofence";

/** Edge flag bits (Uint8 per arc). */
export const FLAG_STEPS = 1 << 0;
export const FLAG_CROSSING = 1 << 1;
export const FLAG_INDOOR = 1 << 2;
export const FLAG_LIT = 1 << 3;

/** Coordinates are stored as integers ×1e7 (≈1.1 cm precision) — Int32 range covers ±214°. */
export const COORD_SCALE = 1e7;
/** Uint16 decimetres ⇒ the longest single arc we can represent. Longer ways are split. */
export const MAX_EDGE_M = 6553.5;

export interface WalkGraph {
  nodeCount: number;
  edgeCount: number;
  /** 2n Int32s, interleaved [lat0, lng0, lat1, lng1, …] ×1e7. */
  coords: Int32Array;
  /** n Uint16s, metres above sea level (clamped to ≥ 0). */
  elevation: Uint16Array;
  /** n+1 Uint32s — arcs of node i are [offsets[i], offsets[i+1]). */
  offsets: Uint32Array;
  /** m Uint32s — the destination node of each arc. */
  targets: Uint32Array;
  /** m Uint16s — ground length of each arc in DECIMETRES. */
  cost: Uint16Array;
  /** m Uint8s — FLAG_* bitset per arc. */
  flags: Uint8Array;
  /** m Uint32s — index into nameDict (0 ⇒ unnamed). */
  names: Uint32Array;
  /** The compact street-name dictionary. Slot 0 is always "". */
  nameDict: string[];
}

export const nodeLat = (g: WalkGraph, i: number): number => g.coords[2 * i]! / COORD_SCALE;
export const nodeLng = (g: WalkGraph, i: number): number => g.coords[2 * i + 1]! / COORD_SCALE;
export const nodeElevation = (g: WalkGraph, i: number): number => g.elevation[i]!;
export const edgeMetres = (g: WalkGraph, e: number): number => g.cost[e]! / 10;
export const edgeName = (g: WalkGraph, e: number): string => g.nameDict[g.names[e]!] ?? "";
export const metresBetween = (aLat: number, aLng: number, bLat: number, bLng: number): number =>
  haversineKm(aLat, aLng, bLat, bLng) * 1000;
/** Great-circle metres between two graph nodes — the A* heuristic. */
export const nodeMetres = (g: WalkGraph, a: number, b: number): number =>
  metresBetween(nodeLat(g, a), nodeLng(g, a), nodeLat(g, b), nodeLng(g, b));

export interface BuildNode { lat: number; lng: number; elev?: number }
export interface BuildEdge {
  a: number;
  b: number;
  /** Ground length. Defaults to the great-circle distance; never stored SHORTER
   *  than that, because the A* heuristic (straight-line metres) must stay
   *  admissible or the router silently returns non-optimal paths. */
  lengthM?: number;
  flags?: number;
  name?: string;
  /** Set for the rare pedestrian one-way (escalator / turnstile). Default false. */
  oneway?: boolean;
}

/** Build a CSR graph from a node list + way list. Used by the tests and by
 *  `scripts/build-walk-graph.mjs`; both get the identical structure. */
export function buildWalkGraph(nodes: BuildNode[], edges: BuildEdge[]): WalkGraph {
  const n = nodes.length;
  const coords = new Int32Array(2 * n);
  const elevation = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const nd = nodes[i]!;
    coords[2 * i] = Math.round(nd.lat * COORD_SCALE);
    coords[2 * i + 1] = Math.round(nd.lng * COORD_SCALE);
    elevation[i] = Math.max(0, Math.min(65535, Math.round(nd.elev ?? 0)));
  }

  const nameDict: string[] = [""];
  const nameIds = new Map<string, number>([["", 0]]);
  const nameId = (s?: string) => {
    const key = s?.trim() || "";
    let id = nameIds.get(key);
    if (id === undefined) { id = nameDict.length; nameDict.push(key); nameIds.set(key, id); }
    return id;
  };

  // Materialise directed arcs first, then bucket them into CSR.
  type Arc = { from: number; to: number; dm: number; flags: number; name: number };
  const arcs: Arc[] = [];
  for (const e of edges) {
    if (e.a === e.b) continue; // self-loops are never useful to a pedestrian
    if (e.a < 0 || e.b < 0 || e.a >= n || e.b >= n) continue;
    const straight = metresBetween(coords[2 * e.a]! / COORD_SCALE, coords[2 * e.a + 1]! / COORD_SCALE, coords[2 * e.b]! / COORD_SCALE, coords[2 * e.b + 1]! / COORD_SCALE);
    const len = Math.min(MAX_EDGE_M, Math.max(e.lengthM ?? straight, straight));
    // ceil, never round: a stored length even a centimetre BELOW the great-circle
    // distance makes the A* heuristic inadmissible and silently costs optimality.
    const dm = Math.max(1, Math.ceil(len * 10));
    const f = e.flags ?? 0;
    const nm = nameId(e.name);
    arcs.push({ from: e.a, to: e.b, dm, flags: f, name: nm });
    if (!e.oneway) arcs.push({ from: e.b, to: e.a, dm, flags: f, name: nm });
  }

  const offsets = new Uint32Array(n + 1);
  for (const a of arcs) offsets[a.from + 1]!++;
  for (let i = 0; i < n; i++) offsets[i + 1]! += offsets[i]!;

  const m = arcs.length;
  const targets = new Uint32Array(m);
  const cost = new Uint16Array(m);
  const flags = new Uint8Array(m);
  const names = new Uint32Array(m);
  const cursor = Uint32Array.from(offsets.subarray(0, n));
  for (const a of arcs) {
    const slot = cursor[a.from]!++;
    targets[slot] = a.to;
    cost[slot] = a.dm;
    flags[slot] = a.flags;
    names[slot] = a.name;
  }

  return { nodeCount: n, edgeCount: m, coords, elevation, offsets, targets, cost, flags, names, nameDict };
}

/** The arc index from `a` to `b` (cheapest, if the pair is parallel), or -1. */
export function findArc(g: WalkGraph, a: number, b: number): number {
  let best = -1, bestDm = Infinity;
  for (let e = g.offsets[a]!; e < g.offsets[a + 1]!; e++) {
    if (g.targets[e] === b && g.cost[e]! < bestDm) { bestDm = g.cost[e]!; best = e; }
  }
  return best;
}
