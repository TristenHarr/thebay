import { describe, it, expect } from "vitest";
import {
  buildWalkGraph, FLAG_STEPS, FLAG_CROSSING, nodeLat, nodeLng, edgeMetres,
  type WalkGraph, type BuildNode, type BuildEdge,
} from "../src/core/nav/graph";
import { DEFAULT_HILL_K, hillMultiplier, edgeCostM, etaSeconds } from "../src/core/nav/cost";
import { route, createScratch } from "../src/core/nav/router";
import { bearingDeg, classifyTurn, compassPoint } from "../src/core/nav/turns";
import { buildNodeIndex, nearestNode } from "../src/core/nav/spatial";
import { haversineKm } from "../src/core/geofence";

/* ── synthetic fixtures ──────────────────────────────────────────────────────
 * Everything below is hand-built so the tests never need the real OSM extract.
 * Spacing is in metres around downtown SF, converted to degrees so haversine
 * distances come out (very close to) the numbers we asked for.
 */
const LAT0 = 37.7749, LNG0 = -122.4194;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const at = (northM: number, eastM: number, elev = 0): BuildNode => ({
  lat: LAT0 + northM / M_PER_DEG_LAT,
  lng: LNG0 + eastM / M_PER_DEG_LNG,
  elev,
});

/** rows×cols lattice, `spacing` metres apart, 4-connected. Node id = r * cols + c. */
function gridGraph(rows: number, cols: number, spacing: number, elevAt: (r: number, c: number) => number = () => 0) {
  const nodes: BuildNode[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) nodes.push(at(r * spacing, c * spacing, elevAt(r, c)));
  const edges: BuildEdge[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = r * cols + c;
      if (c + 1 < cols) edges.push({ a: id, b: id + 1, name: `Street ${r}` });
      if (r + 1 < rows) edges.push({ a: id, b: id + cols, name: `Avenue ${c}` });
    }
  }
  return buildWalkGraph(nodes, edges);
}

/** Reference implementation: plain Dijkstra over the SAME cost model. The A* under
 *  test must agree with it on every graph — that's the real correctness proof. */
function referenceCost(g: WalkGraph, from: number, to: number, hillK: number): number {
  const dist = new Float64Array(g.nodeCount).fill(Infinity);
  const done = new Uint8Array(g.nodeCount);
  dist[from] = 0;
  for (;;) {
    let v = -1, best = Infinity;
    for (let i = 0; i < g.nodeCount; i++) if (!done[i] && dist[i]! < best) { best = dist[i]!; v = i; }
    if (v < 0) break;
    done[v] = 1;
    if (v === to) return best;
    for (let e = g.offsets[v]!; e < g.offsets[v + 1]!; e++) {
      const u = g.targets[e]!;
      const w = edgeCostM(edgeMetres(g, e), g.elevation[u]! - g.elevation[v]!, g.flags[e]!, { hillK });
      if (best + w < dist[u]!) dist[u] = best + w;
    }
  }
  return dist[to]!;
}

describe("walk graph (CSR)", () => {
  it("builds a symmetric CSR with haversine edge lengths and a name dictionary", () => {
    const g = buildWalkGraph([at(0, 0), at(100, 0), at(100, 100)], [
      { a: 0, b: 1, name: "Market Street" },
      { a: 1, b: 2, name: "Main Street", flags: FLAG_CROSSING },
    ]);
    expect(g.nodeCount).toBe(3);
    expect(g.edgeCount).toBe(4); // undirected ⇒ two directed arcs per way
    expect(g.offsets.length).toBe(4);
    expect(g.offsets[3]).toBe(4);
    // node 1 has two neighbours, node 0 and node 2 have one each
    expect(g.offsets[2]! - g.offsets[1]!).toBe(2);
    // length ≈ 100 m in decimetres
    expect(edgeMetres(g, g.offsets[0]!)).toBeGreaterThan(99);
    expect(edgeMetres(g, g.offsets[0]!)).toBeLessThan(101);
    expect(g.nameDict[0]).toBe("");
    expect(g.nameDict).toContain("Market Street");
    // coordinates survive the ×1e7 int round-trip to ~1cm
    expect(nodeLat(g, 0)).toBeCloseTo(LAT0, 6);
    expect(nodeLng(g, 0)).toBeCloseTo(LNG0, 6);
  });

  it("never stores an edge shorter than the great-circle distance (A* admissibility)", () => {
    const g = buildWalkGraph([at(0, 0), at(500, 0)], [{ a: 0, b: 1, lengthM: 10 }]);
    expect(edgeMetres(g, 0)).toBeGreaterThan(495);
  });
});

describe("cost model — avoid hills", () => {
  it("is 1× on the flat and on descents, and quadratic in positive grade", () => {
    expect(hillMultiplier(0, DEFAULT_HILL_K)).toBe(1);
    expect(hillMultiplier(-0.3, DEFAULT_HILL_K)).toBe(1); // downhill is never penalised
    expect(hillMultiplier(0.2, 25)).toBeCloseTo(2, 6); // a 20% SF block ≈ twice as "long"
    expect(hillMultiplier(0.1, 25)).toBeCloseTo(1.25, 6);
    expect(hillMultiplier(0.2, 0)).toBe(1); // k = 0 ⇒ hills off
  });

  it("edgeCostM(k=0) is exactly the ground length", () => {
    expect(edgeCostM(120, 30, 0, { hillK: 0 })).toBeCloseTo(120, 9);
  });

  it("charges a fixed extra for stairs only when avoiding them", () => {
    const plain = edgeCostM(20, 6, FLAG_STEPS, { hillK: 0 });
    const avoid = edgeCostM(20, 6, FLAG_STEPS, { hillK: 0, avoidStairs: true });
    expect(plain).toBeCloseTo(20, 9);
    expect(avoid).toBeGreaterThan(plain);
  });

  it("ETA grows with climb (Naismith) and with stairs", () => {
    const flat = etaSeconds(1000, 0, 0);
    const climb = etaSeconds(1000, 100, 0);
    expect(flat).toBeGreaterThan(600);
    expect(climb).toBeGreaterThan(flat);
    expect(etaSeconds(1000, 0, 3)).toBeGreaterThan(flat);
  });
});

describe("bidirectional A* router", () => {
  it("returns a zero-length route for from === to", () => {
    const g = gridGraph(2, 2, 100);
    const r = route(g, 0, 0)!;
    expect(r).not.toBeNull();
    expect(r.distanceM).toBe(0);
    expect(r.nodes).toEqual([0]);
    expect(r.polyline.length).toBe(1);
  });

  it("returns null when the destination is unreachable", () => {
    const g = buildWalkGraph([at(0, 0), at(100, 0), at(5000, 5000)], [{ a: 0, b: 1 }]);
    expect(route(g, 0, 2)).toBeNull();
  });

  it("prefers the direct edge over a longer detour", () => {
    const g = buildWalkGraph([at(0, 0), at(300, 0), at(0, 400)], [
      { a: 0, b: 1, name: "Direct" },
      { a: 0, b: 2, name: "Detour A" },
      { a: 2, b: 1, name: "Detour B" },
    ]);
    const r = route(g, 0, 1)!;
    expect(r.nodes).toEqual([0, 1]);
    expect(r.distanceM).toBeGreaterThan(295);
    expect(r.distanceM).toBeLessThan(305);
  });

  it("finds a Manhattan-optimal path across a 5×5 lattice", () => {
    const g = gridGraph(5, 5, 100);
    const r = route(g, 0, 24)!;
    expect(r.nodes[0]).toBe(0);
    expect(r.nodes[r.nodes.length - 1]).toBe(24);
    expect(r.distanceM).toBeGreaterThan(795); // 8 × 100 m
    expect(r.distanceM).toBeLessThan(805);
    expect(r.nodes.length).toBe(9);
  });

  it("agrees with a reference Dijkstra on 40 random graphs (flat and hilly)", () => {
    let seed = 20260726;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 40; trial++) {
      const n = 8 + Math.floor(rnd() * 20);
      const nodes: BuildNode[] = [];
      for (let i = 0; i < n; i++) nodes.push(at(rnd() * 900, rnd() * 900, Math.floor(rnd() * 90)));
      const edges: BuildEdge[] = [];
      for (let i = 1; i < n; i++) edges.push({ a: i, b: Math.floor(rnd() * i) }); // spanning tree ⇒ connected
      for (let k = 0; k < n; k++) {
        const a = Math.floor(rnd() * n), b = Math.floor(rnd() * n);
        if (a !== b) edges.push({ a, b });
      }
      const g = buildWalkGraph(nodes, edges);
      const hillK = trial % 2 === 0 ? 0 : DEFAULT_HILL_K;
      const from = Math.floor(rnd() * n), to = Math.floor(rnd() * n);
      const r = route(g, from, to, { hillK });
      const want = referenceCost(g, from, to, hillK);
      expect(r).not.toBeNull();
      expect(r!.costM).toBeCloseTo(want, 4);
      // the returned node chain must actually be a path with that cost
      expect(r!.nodes[0]).toBe(from);
      expect(r!.nodes[r!.nodes.length - 1]).toBe(to);
    }
  });

  it("takes the short steep street by default and the long flat one when avoiding hills", () => {
    //   0 ─(200 m, +40 m ⇒ 20% grade)─ 1 ─(200 m, −40 m)─ 3     400 m, steep
    //   0 ─(250 m, flat)─ 2 ─(250 m, flat)─ 3                   500 m, flat
    // At k=25 the steep pair costs 200×2 + 200×1 = 600 > 500, so "avoid hills"
    // flips the answer — while plain shortest-distance still takes the hill.
    const nodes = [at(0, 0, 0), at(200, 0, 40), at(200, 150, 0), at(400, 0, 0)];
    const g = buildWalkGraph(nodes, [
      { a: 0, b: 1, name: "Steep Hill" },
      { a: 1, b: 3, name: "Steep Hill" },
      { a: 0, b: 2, name: "Flat Way" },
      { a: 2, b: 3, name: "Flat Way" },
    ]);
    expect(edgeMetres(g, 0)).toBeCloseTo(200, 0);
    const fast = route(g, 0, 3, { hillK: 0 })!;
    expect(fast.nodes).toEqual([0, 1, 3]);
    expect(fast.ascentM).toBeGreaterThan(35);

    const gentle = route(g, 0, 3, { avoidHills: true })!;
    expect(gentle.nodes).toEqual([0, 2, 3]);
    expect(gentle.ascentM).toBe(0);
    expect(gentle.distanceM).toBeGreaterThan(fast.distanceM); // longer, but flat
    expect(gentle.maxGrade).toBeLessThan(0.01);
  });

  it("reports stairs and steepness as warnings, and routes around stairs on request", () => {
    const nodes = [at(0, 0, 0), at(60, 0, 18), at(0, 200, 0), at(60, 200, 18)];
    const g = buildWalkGraph(nodes, [
      { a: 0, b: 1, flags: FLAG_STEPS, name: "Filbert Steps" },
      { a: 1, b: 3, name: "Upper Path" },
      { a: 0, b: 2, name: "Ramp Way" },
      { a: 2, b: 3, name: "Ramp Way" },
    ]);
    const viaStairs = route(g, 0, 1)!;
    expect(viaStairs.stairs).toBe(1);
    expect(viaStairs.warnings.join(" ")).toMatch(/stairs/i);
    expect(viaStairs.warnings.join(" ")).toMatch(/steep/i);

    const noStairs = route(g, 0, 3, { avoidStairs: true })!;
    expect(noStairs.stairs).toBe(0);
    expect(noStairs.nodes).toEqual([0, 2, 3]);
  });

  it("produces named turn-by-turn steps ending in an arrival", () => {
    // straight east along Market, then a left turn north onto Van Ness
    const g = buildWalkGraph([at(0, 0), at(0, 200), at(0, 400), at(300, 400)], [
      { a: 0, b: 1, name: "Market Street" },
      { a: 1, b: 2, name: "Market Street" },
      { a: 2, b: 3, name: "Van Ness Avenue" },
    ]);
    const r = route(g, 0, 3)!;
    expect(r.steps.length).toBeGreaterThanOrEqual(3);
    expect(r.steps[0]!.instruction).toMatch(/^Head /);
    expect(r.steps[0]!.street).toBe("Market Street");
    expect(r.steps[0]!.distanceM).toBeGreaterThan(395); // both Market segments merged
    const turn = r.steps.find((s) => /Van Ness/.test(s.instruction));
    expect(turn).toBeTruthy();
    expect(turn!.instruction).toMatch(/left/i);
    expect(r.steps[r.steps.length - 1]!.instruction).toMatch(/Arrive/i);
  });

  it("emits a GeoJSON-ready [lng, lat] polyline that matches the node chain", () => {
    const g = gridGraph(3, 3, 100);
    const r = route(g, 0, 8)!;
    expect(r.polyline.length).toBe(r.nodes.length);
    expect(r.polyline[0]).toEqual([nodeLng(g, 0), nodeLat(g, 0)]);
    const last = r.polyline[r.polyline.length - 1]!;
    expect(last[0]).toBeCloseTo(nodeLng(g, 8), 6);
  });

  it("reuses a scratch buffer across queries without corrupting results", () => {
    const g = gridGraph(4, 4, 120);
    const scratch = createScratch(g);
    const a = route(g, 0, 15, { scratch })!;
    const b = route(g, 3, 12, { scratch })!;
    const c = route(g, 0, 15, { scratch })!;
    expect(c.distanceM).toBeCloseTo(a.distanceM, 6);
    expect(b.nodes[0]).toBe(3);
    expect(c.nodes).toEqual(a.nodes);
  });

  it("solves corner-to-corner on a 200×200 lattice (40k nodes, 160k arcs)", () => {
    // A scale guard, not a benchmark: the real Bay graph is millions of nodes, so
    // a router that is accidentally quadratic must fail here rather than in a
    // phone's UI thread.
    const g = gridGraph(200, 200, 60);
    expect(g.nodeCount).toBe(40_000);
    expect(g.edgeCount).toBe(2 * 2 * 200 * 199);
    const t0 = Date.now();
    const r = route(g, 0, 39_999, { scratch: createScratch(g) })!;
    expect(r).not.toBeNull();
    // Manhattan optimum, ±1%: the lattice is laid out with a fixed degrees-per-metre
    // for lng, so the 12 km-tall grid converges slightly toward the pole.
    const manhattan = 2 * 199 * 60;
    expect(r.distanceM).toBeGreaterThan(manhattan * 0.99);
    expect(r.distanceM).toBeLessThan(manhattan * 1.01);
    expect(r.nodes.length).toBe(399);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it("honours maxSettled by giving up instead of scanning the world", () => {
    const g = gridGraph(20, 20, 50);
    expect(route(g, 0, 399, { maxSettled: 5 })).toBeNull();
    expect(route(g, 0, 399)).not.toBeNull();
  });
});

describe("turn geometry", () => {
  it("bearing is 0° north, 90° east", () => {
    expect(bearingDeg(LAT0, LNG0, LAT0 + 0.01, LNG0)).toBeCloseTo(0, 1);
    expect(bearingDeg(LAT0, LNG0, LAT0, LNG0 + 0.01)).toBeCloseTo(90, 1);
    expect(bearingDeg(LAT0, LNG0, LAT0 - 0.01, LNG0)).toBeCloseTo(180, 1);
  });

  it("classifies turns by signed delta", () => {
    expect(classifyTurn(0)).toBe("straight");
    expect(classifyTurn(30)).toBe("slight right");
    expect(classifyTurn(-30)).toBe("slight left");
    expect(classifyTurn(90)).toBe("right");
    expect(classifyTurn(-90)).toBe("left");
    expect(classifyTurn(150)).toBe("sharp right");
    expect(classifyTurn(179)).toBe("u-turn");
  });

  it("names compass points", () => {
    expect(compassPoint(0)).toBe("north");
    expect(compassPoint(91)).toBe("east");
    expect(compassPoint(226)).toBe("southwest");
  });
});

describe("nearest-node snapping", () => {
  it("snaps a click to the closest graph node, with and without the grid index", () => {
    const g = gridGraph(6, 6, 100);
    const idx = buildNodeIndex(g);
    const target = 14; // r=2, c=2
    const lat = nodeLat(g, target) + 0.00008, lng = nodeLng(g, target) - 0.00008;
    expect(nearestNode(g, lat, lng, { index: idx })).toBe(target);
    expect(nearestNode(g, lat, lng)).toBe(target);
  });

  it("returns -1 when nothing is within the radius", () => {
    const g = gridGraph(3, 3, 100);
    expect(nearestNode(g, 40.7, -74.0, { index: buildNodeIndex(g), maxMetres: 500 })).toBe(-1);
  });

  it("the index agrees with a brute-force scan on scattered probes", () => {
    const g = gridGraph(8, 8, 90);
    const idx = buildNodeIndex(g);
    for (let i = 0; i < 25; i++) {
      const lat = LAT0 + (i * 0.00031) % 0.006, lng = LNG0 + (i * 0.00047) % 0.006;
      let brute = -1, bestKm = Infinity;
      for (let n = 0; n < g.nodeCount; n++) {
        const km = haversineKm(lat, lng, nodeLat(g, n), nodeLng(g, n));
        if (km < bestKm) { bestKm = km; brute = n; }
      }
      expect(nearestNode(g, lat, lng, { index: idx })).toBe(brute);
    }
  });
});
