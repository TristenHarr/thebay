/**
 * Paths — the machinery behind "why am I connected to this?".
 *
 * Two properties matter beyond correctness. The path must be MINIMAL in hops, because the hop
 * count is the strength of the explanation: two hops is a reason, five is trivia. And the
 * search must be BOUNDED, because a hub node — the event four hundred people attended — turns
 * an unbounded BFS into a full traversal of the Bay.
 */
import { describe, it, expect } from "vitest";
import { findPath, directReasons, MAX_HOPS, MAX_VISITED } from "../src/core/graph/path";
import { evidenceOf } from "../src/core/graph/evidence";
import type { GraphEdge } from "../src/core/graph/types";

const AT = "2026-07-01T18:00:00Z";

const e = (a: string, b: string, over: Partial<GraphEdge> = {}): GraphEdge => ({
  a,
  b,
  kind: "checkin",
  directed: true,
  strength: 1,
  evidence: [evidenceOf("attested", "checkins", { user_id: a.slice(5), event_id: b.slice(6) }, AT)],
  ...over,
});

const friends = (a: string, b: string, strength = 0.9): GraphEdge => ({
  a,
  b,
  kind: "friendship",
  directed: false,
  strength,
  evidence: [evidenceOf("stated", "friendships", { user_low: a.slice(5) }, AT)],
});

describe("findPath", () => {
  it("returns the trivial path to yourself", () => {
    const r = findPath("user:me", "user:me", []);
    expect(r.path).toEqual({ nodes: ["user:me"], edges: [] });
  });

  it("finds the canonical two-hop answer THROUGH the event", () => {
    // me --checkin--> event <--checkin-- sam. The event is the citation.
    const edges = [e("user:me", "event:e1"), e("user:sam", "event:e1")];
    const r = findPath("user:me", "user:sam", edges);
    expect(r.path).toBeTruthy();
    expect(r.path!.nodes).toEqual(["user:me", "event:e1", "user:sam"]);
    expect(r.path!.edges).toHaveLength(2);
  });

  it("walks back OUT of an event — a directed edge must still be traversable both ways", () => {
    // Both check-in edges point user→event, so a naive directed walk would dead-end at the
    // event and report "not connected".
    const edges = [e("user:me", "event:e1"), e("user:sam", "event:e1")];
    expect(findPath("user:me", "user:sam", edges).path).toBeTruthy();
  });

  it("returns null when there is genuinely no connection", () => {
    const r = findPath("user:me", "user:nobody", [e("user:me", "event:e1")]);
    expect(r.path).toBeNull();
    expect(r.exhausted).toBe(false); // searched everything, found nothing — a real answer
  });

  it("prefers the SHORTEST path — the hop count is the strength of the explanation", () => {
    const edges = [
      friends("user:me", "user:sam"), // one hop
      e("user:me", "event:e1"), // …and a two-hop route as well
      e("user:sam", "event:e1"),
    ];
    const r = findPath("user:me", "user:sam", edges);
    expect(r.path!.edges).toHaveLength(1);
    expect(r.path!.edges[0]!.kind).toBe("friendship");
  });

  it("prefers the strongest neighbour among equal-length routes", () => {
    const edges = [
      e("user:me", "event:weak", { strength: 0.2 }),
      e("user:sam", "event:weak", { strength: 0.2 }),
      e("user:me", "event:strong", { strength: 1 }),
      e("user:sam", "event:strong", { strength: 1 }),
    ];
    const r = findPath("user:me", "user:sam", edges);
    expect(r.path!.nodes[1]).toBe("event:strong");
  });

  it("REFUSES to go deeper than the hop limit", () => {
    // A chain of 6 users. Reachable in principle; too far to be a reason.
    const edges = Array.from({ length: 6 }, (_, i) => friends(`user:u${i}`, `user:u${i + 1}`));
    expect(findPath("user:u0", "user:u6", edges).path).toBeNull();
    expect(findPath("user:u0", "user:u3", edges, { maxHops: 3 }).path).toBeTruthy();
    expect(findPath("user:u0", "user:u4", edges, { maxHops: 3 }).path).toBeNull();
  });

  it("clamps a caller trying to raise the limits past the hard ceilings", () => {
    const edges = Array.from({ length: 10 }, (_, i) => friends(`user:u${i}`, `user:u${i + 1}`));
    // Asking for 99 hops must not grant 99 hops.
    expect(findPath("user:u0", "user:u9", edges, { maxHops: 99 }).path).toBeNull();
    expect(MAX_HOPS).toBeLessThanOrEqual(3);
  });

  it("BOUNDS the search on a hub, and says it gave up", () => {
    // One event, 3000 attendees — bigger than MAX_VISITED on purpose.
    const edges: GraphEdge[] = [e("user:me", "event:hub")];
    for (let i = 0; i < 3000; i++) edges.push(e(`user:u${i}`, "event:hub"));
    const r = findPath("user:me", "user:absent", edges);
    expect(r.visited).toBeLessThanOrEqual(MAX_VISITED);
    // `exhausted` is the difference between "not connected" and "too big to answer", and the
    // UI must be able to say something different for each.
    expect(r.exhausted).toBe(true);
    expect(r.path).toBeNull();
  });

  it("still answers instantly for a target sitting on that same hub", () => {
    const edges: GraphEdge[] = [e("user:me", "event:hub"), e("user:sam", "event:hub")];
    for (let i = 0; i < 500; i++) edges.push(e(`user:u${i}`, "event:hub"));
    const r = findPath("user:me", "user:sam", edges);
    expect(r.path!.nodes).toEqual(["user:me", "event:hub", "user:sam"]);
  });

  it("never revisits a node, so a cycle cannot loop it", () => {
    const edges = [friends("user:a", "user:b"), friends("user:b", "user:c"), friends("user:c", "user:a")];
    const r = findPath("user:a", "user:c", edges);
    expect(r.path!.nodes).toEqual(["user:a", "user:c"]);
    expect(new Set(r.path!.nodes).size).toBe(r.path!.nodes.length);
  });

  it("is total on an empty edge set", () => {
    expect(findPath("user:a", "user:b", []).path).toBeNull();
  });
});

describe("directReasons", () => {
  it("returns EVERY reason two people are adjacent, not just the best one", () => {
    // "We're friends AND we met in person AND we were both at three events" is a richer
    // answer than any single shortest path.
    const edges = [
      friends("user:a", "user:b"),
      { ...friends("user:b", "user:a"), kind: "vouched" as const },
      e("user:a", "event:e1"),
    ];
    const reasons = directReasons("user:a", "user:b", edges);
    expect(reasons).toHaveLength(2);
    expect(reasons.map((r) => r.kind).sort()).toEqual(["friendship", "vouched"]);
  });

  it("is order-insensitive about which node you name first", () => {
    const edges = [friends("user:a", "user:b")];
    expect(directReasons("user:b", "user:a", edges)).toHaveLength(1);
  });

  it("returns nothing for a pair with no direct edge", () => {
    const edges = [e("user:a", "event:e1"), e("user:b", "event:e1")];
    expect(directReasons("user:a", "user:b", edges)).toEqual([]);
  });
});
