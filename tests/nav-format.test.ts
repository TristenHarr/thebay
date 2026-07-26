import { describe, it, expect } from "vitest";
import { buildWalkGraph, FLAG_STEPS, FLAG_LIT, edgeMetres, nodeLat, nodeLng, type BuildNode } from "../src/core/nav/graph";
import { encodeWalkGraph, decodeWalkGraph, walkGraphLayout, WALK_GRAPH_MAGIC } from "../src/core/nav/format";
import { route } from "../src/core/nav/router";

const nodes: BuildNode[] = [
  { lat: 37.7749, lng: -122.4194, elev: 12 },
  { lat: 37.7758, lng: -122.4194, elev: 30 },
  { lat: 37.7758, lng: -122.4180, elev: 31 },
  { lat: 37.7749, lng: -122.4180, elev: 10 },
];
const edges = [
  { a: 0, b: 1, name: "Taylor Street", flags: FLAG_STEPS },
  { a: 1, b: 2, name: "Bush Street", flags: FLAG_LIT },
  { a: 2, b: 3, name: "Powell Street" },
  { a: 3, b: 0, name: "Bush Street" },
];

describe("walk-graph binary container", () => {
  it("lays sections out 4-byte aligned and in a deterministic order", () => {
    const l = walkGraphLayout(4, 8, 40);
    for (const off of [l.coords, l.elevation, l.offsets, l.targets, l.cost, l.flags, l.names, l.dict]) {
      expect(off % 4).toBe(0);
    }
    expect(l.coords).toBeLessThan(l.offsets);
    expect(l.targets).toBeLessThan(l.dict);
    expect(l.total).toBeGreaterThanOrEqual(l.dict + 40);
  });

  it("round-trips a graph byte-for-byte identically", () => {
    const g = buildWalkGraph(nodes, edges);
    const buf = encodeWalkGraph(g);
    expect(new TextDecoder().decode(new Uint8Array(buf, 0, 8))).toBe(WALK_GRAPH_MAGIC);

    const back = decodeWalkGraph(buf);
    expect(back.nodeCount).toBe(g.nodeCount);
    expect(back.edgeCount).toBe(g.edgeCount);
    expect(Array.from(back.offsets)).toEqual(Array.from(g.offsets));
    expect(Array.from(back.targets)).toEqual(Array.from(g.targets));
    expect(Array.from(back.cost)).toEqual(Array.from(g.cost));
    expect(Array.from(back.flags)).toEqual(Array.from(g.flags));
    expect(Array.from(back.coords)).toEqual(Array.from(g.coords));
    expect(Array.from(back.elevation)).toEqual(Array.from(g.elevation));
    expect(back.nameDict).toEqual(g.nameDict);
    expect(nodeLat(back, 2)).toBeCloseTo(nodeLat(g, 2), 7);
    expect(nodeLng(back, 2)).toBeCloseTo(nodeLng(g, 2), 7);
    expect(edgeMetres(back, 0)).toBeCloseTo(edgeMetres(g, 0), 6);
  });

  it("a decoded graph routes identically to the in-memory one", () => {
    const g = buildWalkGraph(nodes, edges);
    const back = decodeWalkGraph(encodeWalkGraph(g));
    const a = route(g, 0, 2, { avoidHills: true })!;
    const b = route(back, 0, 2, { avoidHills: true })!;
    expect(b.nodes).toEqual(a.nodes);
    expect(b.distanceM).toBeCloseTo(a.distanceM, 6);
    expect(b.steps.map((s) => s.street)).toEqual(a.steps.map((s) => s.street));
  });

  it("rejects a buffer that is not a walk graph", () => {
    expect(() => decodeWalkGraph(new ArrayBuffer(64))).toThrow(/walk graph/i);
  });
});
