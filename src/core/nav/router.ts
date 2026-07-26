/**
 * Bidirectional A* over the CSR walking graph — PURE and SYNCHRONOUS.
 *
 * Pure and synchronous on purpose: it unit-tests on hand-built synthetic graphs
 * with no browser, no fixtures and no OSM extract, and the *same* function runs
 * inside `web/src/features/nav/router.worker.ts` so the UI thread never blocks.
 *
 * Why bidirectional: a Bay-wide footpath graph is millions of nodes, and a
 * unidirectional A* on a grid-like street network still settles an area
 * proportional to the ellipse between the endpoints. Searching from both ends
 * roughly halves the exponent.
 *
 * The heuristic is made *consistent for both halves at once* with the standard
 * balanced potential
 *
 *     p(v) = ( h(v, target) − h(source, v) ) / 2 ,  h = great-circle metres
 *
 * The forward search runs Dijkstra on reduced weights w − p(u) + p(v), the
 * backward search on w + p(v) − p(u); both are non-negative because every edge
 * cost is ≥ its ground length ≥ the great-circle distance (see cost.ts —
 * the hill multiplier is ≥ 1 by construction, which is exactly why it's
 * one-sided). Reduced path length differs from the true one by the constant
 * −p(s) + p(t) = −h(s,t), so the classic "stop when topF + topB ≥ best" rule
 * applies unchanged and the recovered cost is `best + h(s,t)`.
 */
import {
  FLAG_STEPS, edgeMetres, nodeLat, nodeLng, nodeMetres,
  type WalkGraph,
} from "./graph";
import { DEFAULT_HILL_K, edgeCostM, etaSeconds, slope, type CostOptions } from "./cost";
import { buildSteps, type RouteStep } from "./turns";

/** Grades at or above this earn a "steep" warning (8% is the ADA ramp ceiling). */
export const STEEP_GRADE = 0.08;

export interface RouteOptions extends CostOptions {
  /** Shorthand for hillK = DEFAULT_HILL_K. An explicit `hillK` always wins. */
  avoidHills?: boolean;
  /** Abort (return null) after this many settled nodes. Guards the UI against a
   *  pathological query on a huge graph. */
  maxSettled?: number;
  /** Reusable working memory — see createScratch. Optional; omit and one is made. */
  scratch?: RouterScratch;
}

export interface WalkRoute {
  /** The node chain, source first. */
  nodes: number[];
  /** The arc chain (nodes.length − 1 entries). */
  arcs: number[];
  /** True ground distance in metres. */
  distanceM: number;
  /** Model cost in metre-equivalents (== distanceM when hills are off). */
  costM: number;
  seconds: number;
  ascentM: number;
  descentM: number;
  /** Steepest positive grade on the route (0.08 = 8%). */
  maxGrade: number;
  /** Number of stairs arcs traversed. */
  stairs: number;
  warnings: string[];
  /** GeoJSON order — [lng, lat] pairs, ready for a MapLibre LineString. */
  polyline: [number, number][];
  steps: RouteStep[];
}

/* ── a tiny binary min-heap (key, value) ─────────────────────────────────────*/
class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number { return this.v.length; }
  clear(): void { this.k.length = 0; this.v.length = 0; }
  /** +Infinity when empty, so the stopping rule needs no special case. */
  peek(): number { return this.k.length ? this.k[0]! : Infinity; }
  push(key: number, val: number): void {
    this.k.push(key); this.v.push(val);
    let i = this.v.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p]! <= this.k[i]!) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    const top = this.v[0]!;
    const lastK = this.k.pop()!, lastV = this.v.pop()!;
    if (this.v.length) {
      this.k[0] = lastK; this.v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let s = i;
        if (l < this.v.length && this.k[l]! < this.k[s]!) s = l;
        if (r < this.v.length && this.k[r]! < this.k[s]!) s = r;
        if (s === i) break;
        this.swap(i, s); i = s;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const tk = this.k[a]!; this.k[a] = this.k[b]!; this.k[b] = tk;
    const tv = this.v[a]!; this.v[a] = this.v[b]!; this.v[b] = tv;
  }
}

/** Reusable per-graph working memory. Allocating 6 arrays of `nodeCount` per query
 *  would dominate the runtime on a Bay-sized graph, so the worker makes ONE of
 *  these and passes it every time; a monotonically increasing generation stamp
 *  replaces clearing. */
export interface RouterScratch {
  nodeCount: number;
  gen: number;
  stampF: Int32Array; stampB: Int32Array;
  doneF: Int32Array; doneB: Int32Array;
  distF: Float64Array; distB: Float64Array;
  parentF: Int32Array; parentB: Int32Array;
  heapF: MinHeap; heapB: MinHeap;
}

export function createScratch(g: WalkGraph): RouterScratch {
  const n = g.nodeCount;
  return {
    nodeCount: n, gen: 0,
    stampF: new Int32Array(n), stampB: new Int32Array(n),
    doneF: new Int32Array(n), doneB: new Int32Array(n),
    distF: new Float64Array(n), distB: new Float64Array(n),
    parentF: new Int32Array(n), parentB: new Int32Array(n),
    heapF: new MinHeap(), heapB: new MinHeap(),
  };
}

/** The cheapest arc a→b under the active cost model, or -1. */
function bestArc(g: WalkGraph, a: number, b: number, opts: CostOptions): number {
  let best = -1, bestCost = Infinity;
  for (let e = g.offsets[a]!; e < g.offsets[a + 1]!; e++) {
    if (g.targets[e] !== b) continue;
    const c = edgeCostM(edgeMetres(g, e), g.elevation[b]! - g.elevation[a]!, g.flags[e]!, opts);
    if (c < bestCost) { bestCost = c; best = e; }
  }
  return best;
}

function finish(g: WalkGraph, nodes: number[], costOpts: CostOptions): WalkRoute {
  const arcs: number[] = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const e = bestArc(g, nodes[i]!, nodes[i + 1]!, costOpts);
    if (e >= 0) arcs.push(e);
  }
  let distanceM = 0, costM = 0, ascentM = 0, descentM = 0, maxGrade = 0, stairs = 0;
  for (let i = 0; i < arcs.length; i++) {
    const e = arcs[i]!, a = nodes[i]!, b = nodes[i + 1]!;
    const len = edgeMetres(g, e);
    const rise = g.elevation[b]! - g.elevation[a]!;
    distanceM += len;
    costM += edgeCostM(len, rise, g.flags[e]!, costOpts);
    if (rise > 0) ascentM += rise; else descentM -= rise;
    maxGrade = Math.max(maxGrade, slope(len, rise));
    if (g.flags[e]! & FLAG_STEPS) stairs++;
  }
  const warnings: string[] = [];
  if (stairs > 0) warnings.push(`${stairs} flight${stairs === 1 ? "" : "s"} of stairs on this route`);
  if (maxGrade >= STEEP_GRADE) warnings.push(`Steep climb — up to ${Math.round(maxGrade * 100)}% grade`);
  return {
    nodes, arcs,
    distanceM: Math.round(distanceM * 10) / 10,
    costM,
    seconds: Math.round(etaSeconds(distanceM, ascentM, stairs)),
    ascentM, descentM, maxGrade, stairs, warnings,
    polyline: nodes.map((i) => [nodeLng(g, i), nodeLat(g, i)] as [number, number]),
    steps: buildSteps(g, nodes, arcs),
  };
}

/** Shortest walking route between two graph nodes, or null if unreachable / capped. */
export function route(g: WalkGraph, from: number, to: number, opts: RouteOptions = {}): WalkRoute | null {
  const n = g.nodeCount;
  if (!(from >= 0 && from < n && to >= 0 && to < n)) return null;
  const costOpts: CostOptions = {
    hillK: opts.hillK ?? (opts.avoidHills ? DEFAULT_HILL_K : 0),
    avoidStairs: opts.avoidStairs,
    stairsPenaltyM: opts.stairsPenaltyM,
  };
  if (from === to) return finish(g, [from], costOpts);

  const s = opts.scratch && opts.scratch.nodeCount === n ? opts.scratch : createScratch(g);
  const gen = ++s.gen;
  s.heapF.clear(); s.heapB.clear();
  const { stampF, stampB, doneF, doneB, distF, distB, parentF, parentB, heapF, heapB } = s;

  // Balanced potential — consistent for the forward and backward halves at once.
  const pot = (v: number) => (nodeMetres(g, v, to) - nodeMetres(g, from, v)) / 2;

  let mu = Infinity, meet = -1;
  const relax = (u: number, nd: number, via: number, forward: boolean) => {
    const stamp = forward ? stampF : stampB, dist = forward ? distF : distB, parent = forward ? parentF : parentB;
    if (stamp[u] === gen && dist[u]! <= nd) return;
    stamp[u] = gen; dist[u] = nd; parent[u] = via;
    (forward ? heapF : heapB).push(nd, u);
    const otherStamp = forward ? stampB : stampF, otherDist = forward ? distB : distF;
    if (otherStamp[u] === gen) {
      const total = nd + otherDist[u]!;
      if (total < mu) { mu = total; meet = u; }
    }
  };

  stampF[from] = gen; distF[from] = 0; parentF[from] = -1; heapF.push(0, from);
  stampB[to] = gen; distB[to] = 0; parentB[to] = -1; heapB.push(0, to);

  const cap = opts.maxSettled ?? Infinity;
  let settled = 0;

  while (heapF.size || heapB.size) {
    const topF = heapF.peek(), topB = heapB.peek();
    if (topF + topB >= mu) break;
    const forward = topF <= topB;
    const heap = forward ? heapF : heapB;
    const v = heap.pop();
    const done = forward ? doneF : doneB;
    if (done[v] === gen) continue;
    done[v] = gen;
    if (++settled > cap) return null;

    const dv = (forward ? distF : distB)[v]!;
    const pv = pot(v);
    const elevV = g.elevation[v]!;
    for (let e = g.offsets[v]!; e < g.offsets[v + 1]!; e++) {
      const u = g.targets[e]!;
      if ((forward ? doneF : doneB)[u] === gen) continue;
      const len = edgeMetres(g, e);
      const rise = forward ? g.elevation[u]! - elevV : elevV - g.elevation[u]!;
      const w = edgeCostM(len, rise, g.flags[e]!, costOpts);
      const pu = pot(u);
      // forward: w − p(v) + p(u).   backward: w + p(v) − p(u).
      const reduced = Math.max(0, forward ? w - pv + pu : w + pv - pu);
      relax(u, dv + reduced, v, forward);
    }
  }

  if (meet < 0 || !Number.isFinite(mu)) return null;

  const head: number[] = [];
  for (let v = meet; v !== -1; v = parentF[v]!) { head.push(v); if (head.length > n) return null; }
  head.reverse();
  const nodes = head;
  for (let v = parentB[meet]!; v !== -1; v = parentB[v]!) { nodes.push(v); if (nodes.length > n + 1) return null; }
  return finish(g, nodes, costOpts);
}
