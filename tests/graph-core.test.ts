/**
 * The graph's pure core: ids, tiers, decay, merge, and the sentences.
 *
 * The sentence tests are not cosmetic. The whole feature is "the graph cites its sources
 * instead of scoring you", and these lock the two ways that promise can quietly break: an
 * `inferred` coincidence rendered with the confidence of a fact, and a `co_attended` edge
 * that forgets to name the event it was derived from — at which point it has degenerated into
 * exactly the vague similarity claim we set out to avoid.
 */
import { describe, it, expect } from "vitest";
import { GRAPH_NODE_TYPES, EDGE_SPEC, GRAPH_EDGE_KINDS, nodeId, parseNodeId, orderPair, type GraphEdge, type GraphNode } from "../src/core/graph/types";
import { GRAPH_EVIDENCE_TIERS, TIER_RANK, assertsFact, strongestTier, evidenceOf } from "../src/core/graph/evidence";
import { HALF_LIFE_DAYS, MIN_STRENGTH, recencyFactor, edgeStrength, mergeEdges, degrees, rankEdges } from "../src/core/graph/strength";
import { describeEdge, explainPath } from "../src/core/graph/explain";

const NOW = Date.parse("2026-07-26T00:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const edge = (over: Partial<GraphEdge> = {}): GraphEdge => ({
  a: "user:ann",
  b: "event:e1",
  kind: "checkin",
  directed: true,
  strength: 1,
  evidence: [evidenceOf("attested", "checkins", { user_id: "ann", event_id: "e1" }, ago(1))],
  ...over,
});

const NODES = new Map<string, GraphNode>([
  ["user:ann", { id: "user:ann", type: "user", label: "Ann", handle: "ann" }],
  ["user:sam", { id: "user:sam", type: "user", label: "Sam", handle: "sam" }],
  ["event:e1", { id: "event:e1", type: "event", label: "Founders Night", at: ago(3) }],
]);

describe("node ids", () => {
  it("round-trips every node type", () => {
    for (const t of GRAPH_NODE_TYPES) {
      const id = nodeId(t, "01HABC");
      expect(parseNodeId(id)).toEqual({ type: t, id: "01HABC" });
    }
  });

  it("keeps the id spaces disjoint — a ULID collision must not merge a person and an event", () => {
    expect(nodeId("user", "01H")).not.toBe(nodeId("event", "01H"));
  });

  it("rejects anything that isn't a known type prefix", () => {
    for (const bad of ["", "01HABC", ":01H", "user:", "tag:ai", "USER:01H", "funding_round:x"]) {
      expect(parseNodeId(bad), bad).toBeNull();
    }
  });

  it("survives an id that itself contains a colon", () => {
    // Fingerprints look like "host:abc123", so this is a real shape.
    expect(parseNodeId("event:host:abc123")).toEqual({ type: "event", id: "host:abc123" });
  });

  it("orders an undirected pair the same way whichever side arrives first", () => {
    expect(orderPair("user:b", "user:a")).toEqual(orderPair("user:a", "user:b"));
  });
});

describe("edge specs", () => {
  it("describes every declared kind", () => {
    for (const k of GRAPH_EDGE_KINDS) {
      const s = EDGE_SPEC[k];
      expect(s, k).toBeTruthy();
      expect(s.strength).toBeGreaterThan(0);
      expect(s.strength).toBeLessThanOrEqual(1);
      expect(s.verb.trim(), k).not.toBe("");
      expect(GRAPH_EVIDENCE_TIERS).toContain(s.tier);
    }
  });

  it("rates physical presence above an intention", () => {
    // A check-in is evidenced by a host-issued code; an RSVP is a click.
    expect(EDGE_SPEC.checkin.strength).toBeGreaterThan(EDGE_SPEC.rsvp.strength);
    expect(EDGE_SPEC.checkin.tier).toBe("attested");
    expect(EDGE_SPEC.rsvp.tier).toBe("stated");
  });
});

describe("evidence tiers", () => {
  it("ranks attested over stated over inferred", () => {
    expect(TIER_RANK.attested).toBeGreaterThan(TIER_RANK.stated);
    expect(TIER_RANK.stated).toBeGreaterThan(TIER_RANK.inferred);
  });

  it("marks only inferred as non-factual", () => {
    expect(assertsFact("attested")).toBe(true);
    expect(assertsFact("stated")).toBe(true);
    expect(assertsFact("inferred")).toBe(false);
  });

  it("takes the strongest tier and NEVER averages", () => {
    // Two stated reasons must not add up to an attested one, or volume launders weak claims.
    expect(strongestTier(["stated", "stated", "stated"])).toBe("stated");
    expect(strongestTier(["inferred", "attested", "stated"])).toBe("attested");
    expect(strongestTier([])).toBeNull();
  });

  it("stringifies source keys and drops nullish ones", () => {
    const e = evidenceOf("stated", "rsvps", { user_id: "ann", event_id: 7, extra: null }, null);
    expect(e.source).toEqual({ table: "rsvps", keys: { user_id: "ann", event_id: "7" } });
    expect(e.at).toBeNull();
  });
});

describe("recency decay", () => {
  it("halves at the half-life", () => {
    expect(recencyFactor(ago(HALF_LIFE_DAYS), NOW)).toBeCloseTo(0.5, 5);
    expect(recencyFactor(ago(HALF_LIFE_DAYS * 2), NOW)).toBeCloseTo(0.25, 5);
  });

  it("does not decay a timeless edge — guessing a date would invent a fact", () => {
    expect(recencyFactor(null, NOW)).toBe(1);
    expect(recencyFactor("not a date", NOW)).toBe(1);
  });

  it("never strengthens an edge dated in the future", () => {
    expect(recencyFactor(new Date(NOW + 86_400_000).toISOString(), NOW)).toBeLessThanOrEqual(1);
  });

  it("floors rather than vanishing — an old fact is still a fact", () => {
    const ancient = edgeStrength(1, ago(3650), NOW);
    expect(ancient).toBeGreaterThanOrEqual(MIN_STRENGTH);
    expect(ancient).toBeLessThan(0.2);
  });

  it("is total and stays inside [0,1] for hostile inputs", () => {
    for (const base of [NaN, -5, 99, Infinity]) {
      const s = edgeStrength(base as number, ago(10), NOW);
      expect(Number.isFinite(s), `${base}`).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

describe("mergeEdges", () => {
  it("collapses the same relation arriving twice from a chunked query", () => {
    const merged = mergeEdges([edge(), edge()]);
    expect(merged).toHaveLength(1);
    // The same source row twice is a chunking artefact, not a second reason.
    expect(merged[0]!.evidence).toHaveLength(1);
  });

  it("keeps two DIFFERENT reasons on one edge", () => {
    const a = edge({ evidence: [evidenceOf("attested", "checkins", { user_id: "ann", event_id: "e1" }, ago(1))] });
    const b = edge({ evidence: [evidenceOf("stated", "rsvps", { user_id: "ann", event_id: "e1" }, ago(9))] });
    expect(mergeEdges([a, b])[0]!.evidence).toHaveLength(2);
  });

  it("keeps different KINDS as separate edges", () => {
    const f = edge({ a: "user:ann", b: "user:sam", kind: "friendship", directed: false });
    const v = edge({ a: "user:ann", b: "user:sam", kind: "vouched", directed: false });
    expect(mergeEdges([f, v])).toHaveLength(2);
  });

  it("canonicalises an undirected pair so a↔b and b↔a are ONE edge", () => {
    const x = edge({ a: "user:sam", b: "user:ann", kind: "friendship", directed: false });
    const y = edge({ a: "user:ann", b: "user:sam", kind: "friendship", directed: false });
    expect(mergeEdges([x, y])).toHaveLength(1);
  });

  it("takes the MAX strength, never the sum", () => {
    const merged = mergeEdges([edge({ strength: 0.4 }), edge({ strength: 0.7 })]);
    expect(merged[0]!.strength).toBe(0.7);
  });
});

describe("degrees and ranking", () => {
  it("counts merged edges per node", () => {
    const d = degrees([edge(), edge({ a: "user:sam", b: "event:e1" })]);
    expect(d.get("event:e1")).toBe(2);
    expect(d.get("user:ann")).toBe(1);
  });

  it("ranks deterministically, so `omitted` means something", () => {
    const edges = [
      edge({ a: "user:a", b: "event:1", strength: 0.5 }),
      edge({ a: "user:b", b: "event:2", strength: 0.9 }),
      edge({ a: "user:c", b: "event:3", strength: 0.5 }),
    ];
    const once = rankEdges(edges).map((e) => e.a);
    const twice = rankEdges([...edges].reverse()).map((e) => e.a);
    expect(once).toEqual(twice);
    expect(once[0]).toBe("user:b");
  });
});

describe("the sentences", () => {
  it("cites a check-in with its date", () => {
    const r = describeEdge(edge(), NODES);
    expect(r.factual).toBe(true);
    expect(r.label).toContain("Ann");
    expect(r.label).toContain("checked in at");
    expect(r.label).toContain("Founders Night");
    expect(r.label).toMatch(/\d{4}/);
  });

  it("NAMES THE EVENT on a co-attendance — without it the edge is just a similarity score", () => {
    const co = edge({
      a: "user:ann",
      b: "user:sam",
      kind: "co_attended",
      directed: false,
      evidence: [
        evidenceOf("attested", "checkins", { event_id: "e1" }, ago(3), {
          via: { id: "event:e1", type: "event", label: "Founders Night" },
        }),
      ],
    });
    const r = describeEdge(co, NODES);
    expect(r.label).toContain("Founders Night");
    expect(r.label).toContain("Ann");
    expect(r.label).toContain("Sam");
  });

  it("hedges an inferred edge and never gives it a relationship verb", () => {
    const guess = edge({
      a: "user:ann",
      b: "user:sam",
      kind: "co_attended",
      directed: false,
      evidence: [evidenceOf("inferred", "places", { geohash: "9q8yyz" }, null)],
    });
    const r = describeEdge(guess, NODES);
    expect(r.factual).toBe(false);
    expect(r.label).toContain("appear near");
    for (const verb of ["met", "attended", "checked in", "vouched"]) {
      expect(r.label.toLowerCase(), `an inferred edge must not claim "${verb}"`).not.toContain(verb);
    }
  });

  it("renders the canonical two-hop answer to 'why am I connected'", () => {
    const path = {
      nodes: ["user:ann", "event:e1", "user:sam"],
      edges: [
        edge({ a: "user:ann", b: "event:e1" }),
        edge({ a: "user:sam", b: "event:e1", evidence: [evidenceOf("attested", "checkins", { user_id: "sam", event_id: "e1" }, ago(3))] }),
      ],
    };
    const lines = explainPath(path, NODES);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Ann");
    expect(lines[1]).toContain("Sam");
    for (const l of lines) expect(l).toContain("Founders Night");
  });

  it("degrades gracefully when a node is missing from the map", () => {
    const r = describeEdge(edge({ a: "user:ghost" }), NODES);
    expect(r.label).toContain("someone");
  });
});
