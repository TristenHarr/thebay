/**
 * Arc geometry.
 *
 * The most important tests here are the ones asserting `null`. **One NaN coordinate makes
 * MapLibre silently drop the ENTIRE source** — every arc disappears and nothing is logged — so
 * the two realistic ways to produce one (a `(0,0)` geocode, and two events at the same venue)
 * have to be refused at the geometry layer rather than discovered on a blank map.
 */
import { describe, it, expect } from "vitest";
import { bezierArc, bendSign, arcSteps, DEFAULT_BEND, type LngLat } from "../src/core/graph/arcs";
import { arcFeatures, nodeFeatures } from "../src/core/graph/geojson";
import { evidenceOf } from "../src/core/graph/evidence";
import type { GraphEdge, GraphNode } from "../src/core/graph/types";

const SOMA: LngLat = [-122.4058, 37.7825];
const PALO_ALTO: LngLat = [-122.143, 37.4419];
const OAKLAND: LngLat = [-122.2712, 37.8044];

describe("bezierArc", () => {
  it("draws an arc between two Bay venues, in GeoJSON [lng, lat] order", () => {
    const arc = bezierArc(SOMA, PALO_ALTO)!;
    expect(arc.length).toBeGreaterThan(8);
    expect(arc[0]).toEqual(SOMA);
    expect(arc[arc.length - 1]).toEqual(PALO_ALTO);
    // Longitude first, and every point finite.
    for (const [lng, lat] of arc) {
      expect(lng).toBeLessThan(0);
      expect(lat).toBeGreaterThan(0);
      expect(Number.isFinite(lng) && Number.isFinite(lat)).toBe(true);
    }
  });

  it("actually bends — a straight line would hide overlapping edges", () => {
    const arc = bezierArc(SOMA, PALO_ALTO)!;
    const mid = arc[Math.floor(arc.length / 2)]!;
    const chordMid: LngLat = [(SOMA[0] + PALO_ALTO[0]) / 2, (SOMA[1] + PALO_ALTO[1]) / 2];
    expect(Math.hypot(mid[0] - chordMid[0], mid[1] - chordMid[1])).toBeGreaterThan(0.001);
  });

  it("REFUSES a (0,0) geocode — a failed lookup must not draw a line to Null Island", () => {
    expect(bezierArc([0, 0], SOMA)).toBeNull();
    expect(bezierArc(SOMA, [0, 0])).toBeNull();
  });

  it("REFUSES a zero-length chord — the perpendicular is undefined and the control point NaN", () => {
    // Two events at the same venue. This is the case that would blank the whole layer.
    expect(bezierArc(SOMA, SOMA)).toBeNull();
    expect(bezierArc(SOMA, [SOMA[0], SOMA[1] + 1e-12])).toBeNull();
  });

  it("refuses anything outside the Bay, and any non-finite input", () => {
    expect(bezierArc(SOMA, [-74.006, 40.7128]), "New York").toBeNull();
    expect(bezierArc(SOMA, [NaN, 37.7])).toBeNull();
    expect(bezierArc(SOMA, [Infinity, 37.7])).toBeNull();
  });

  it("NEVER emits a non-finite coordinate, across many venue pairs and bends", () => {
    const pts = [SOMA, PALO_ALTO, OAKLAND, [-122.0, 37.5] as LngLat, [-123.0, 38.5] as LngLat];
    for (const a of pts) {
      for (const b of pts) {
        for (const bend of [0, 0.05, DEFAULT_BEND, -0.4, 0.9]) {
          const arc = bezierArc(a, b, { bend });
          if (!arc) continue;
          for (const [lng, lat] of arc) {
            expect(Number.isFinite(lng) && Number.isFinite(lat), `${a}→${b} bend=${bend}`).toBe(true);
          }
        }
      }
    }
  });

  it("corrects for latitude compression so the bend doesn't skew with orientation", () => {
    // At 37.75°N a degree of longitude covers only ~79% of the ground a degree of latitude
    // does. Without the cos(lat) correction, a north-south arc bows visibly more than an
    // east-west one covering the SAME DISTANCE.
    //
    // The two arcs below are deliberately equal in ground length, not in degrees: 0.3° of
    // latitude against 0.3/cos(lat)° of longitude. Comparing equal DEGREE spans would measure
    // the length difference (bow is proportional to chord, by design) rather than the skew.
    const LAT = 37.75;
    const k = Math.cos(LAT * (Math.PI / 180));
    const ns = bezierArc([-122.4, LAT - 0.15], [-122.4, LAT + 0.15], { steps: 20 })!;
    const ew = bezierArc([-122.4 - 0.15 / k, LAT], [-122.4 + 0.15 / k, LAT], { steps: 20 })!;
    const bowOf = (arc: LngLat[]) => {
      const mid = arc[10]!;
      const chordMid: LngLat = [(arc[0]![0] + arc[20]![0]) / 2, (arc[0]![1] + arc[20]![1]) / 2];
      // Ground units, so the two orientations are comparable at all.
      return Math.hypot((mid[0] - chordMid[0]) * k, mid[1] - chordMid[1]);
    };
    const ratio = bowOf(ns) / bowOf(ew);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });
});

describe("bendSign", () => {
  it("is SYMMETRIC — a↔b and b↔a must bend the same way or they render as a lens", () => {
    for (const [a, b] of [
      ["event:e1", "event:e2"],
      ["event:zzz", "event:aaa"],
      ["place:p1", "event:e9"],
    ] as const) {
      expect(bendSign(a, b)).toBe(bendSign(b, a));
    }
  });

  it("is deterministic and produces both directions across a population", () => {
    const signs = new Set<number>();
    for (let i = 0; i < 60; i++) signs.add(bendSign(`event:a${i}`, `event:b${i}`));
    expect(signs.size, "all arcs bending the same way is a fan, not a graph").toBe(2);
    expect(bendSign("event:x", "event:y")).toBe(bendSign("event:x", "event:y"));
  });
});

describe("arcSteps", () => {
  it("scales samples with length and clamps both ends", () => {
    expect(arcSteps(0.5)).toBe(8);
    expect(arcSteps(20)).toBe(20);
    expect(arcSteps(9999)).toBe(48);
    expect(arcSteps(NaN)).toBe(8);
  });
});

describe("arcFeatures", () => {
  const node = (id: string, lat: number | null, lng: number | null): GraphNode => ({
    id,
    type: "event",
    label: id,
    lat,
    lng,
    degree: 2,
  });
  const edge = (a: string, b: string, over: Partial<GraphEdge> = {}): GraphEdge => ({
    a,
    b,
    kind: "co_attended",
    directed: false,
    strength: 0.8,
    evidence: [evidenceOf("attested", "checkins", { event_id: "e1" }, "2026-07-01T18:00:00Z")],
    ...over,
  });

  it("emits a feature per drawable edge with the paint properties the layer needs", () => {
    const nodes = new Map([
      ["event:a", node("event:a", 37.7825, -122.4058)],
      ["event:b", node("event:b", 37.4419, -122.143)],
    ]);
    const { fc, skipped } = arcFeatures([edge("event:a", "event:b")], nodes);
    expect(fc.features).toHaveLength(1);
    const p = fc.features[0]!.properties;
    expect(p.tier).toBe("attested");
    expect(p.wScale).toBeGreaterThanOrEqual(0.5);
    expect(p.wScale).toBeLessThanOrEqual(2.5);
    expect(skipped).toEqual({ noCoords: 0, degenerate: 0 });
  });

  it("COUNTS what it skipped rather than quietly shrinking the map", () => {
    const nodes = new Map([
      ["event:a", node("event:a", 37.7825, -122.4058)],
      ["event:nogeo", node("event:nogeo", null, null)],
      ["event:same", node("event:same", 37.7825, -122.4058)],
    ]);
    const { fc, skipped } = arcFeatures(
      [edge("event:a", "event:nogeo"), edge("event:a", "event:same")],
      nodes,
    );
    expect(fc.features).toHaveLength(0);
    expect(skipped.noCoords).toBe(1);
    expect(skipped.degenerate).toBe(1);
  });

  it("draws a pair IDENTICALLY regardless of which node came first", () => {
    // Not merely "the same bend sign": `bezierArc` builds its control point from the chord
    // direction, so an unordered pair would mirror to the other side and the two renderings
    // would form a lens. `arcFeatures` canonicalises the endpoints, so the geometry matches
    // exactly.
    const nodes = new Map([
      ["event:a", node("event:a", 37.7825, -122.4058)],
      ["event:b", node("event:b", 37.4419, -122.143)],
    ]);
    const fwd = arcFeatures([edge("event:a", "event:b")], nodes).fc.features[0]!.geometry.coordinates;
    const rev = arcFeatures([edge("event:b", "event:a")], nodes).fc.features[0]!.geometry.coordinates;
    expect(fwd).toEqual(rev);
  });
});

describe("nodeFeatures", () => {
  it("emits only coordinate-bearing nodes — users have none and must not be invented", () => {
    const fc = nodeFeatures([
      { id: "event:a", type: "event", label: "A", lat: 37.78, lng: -122.4, degree: 3 },
      { id: "user:me", type: "user", label: "Me", degree: 5 },
      { id: "event:nogeo", type: "event", label: "N", lat: null, lng: null, degree: 1 },
    ]);
    expect(fc.features.map((f) => f.properties.id)).toEqual(["event:a"]);
  });
});
