/**
 * "Why am I connected to this?" — a bounded, evidenced path.
 *
 * Runs over an ALREADY-PROJECTED set of edges, in memory. That is the design decision worth
 * recording: a recursive CTE would let SQLite walk the graph server-side, but the walk would
 * then happen *below* the visibility filter, and the fix for that is to re-implement
 * `canSeeUser` in SQL — which is precisely the duplication that makes privacy bugs. Searching
 * the filtered projection means an invisible node cannot appear as a waypoint, because it was
 * never in the set. It also makes the query count for a path exactly the query count for the
 * projection, with nothing added.
 *
 * Both bounds are hard rather than advisory. An unbounded BFS over a hub node — the event
 * everybody attended — will happily enumerate the whole Bay.
 */
import { orderPair, type GraphEdge, type GraphNodeId, type GraphPath } from "./types";
import { strongestTier, TIER_RANK } from "./evidence";

/**
 * Three hops is the useful limit. Two is the canonical answer (me → event ← them); three
 * covers "a friend of mine was there". At four the sentence stops being a reason and becomes
 * a coincidence with extra steps.
 */
export const MAX_HOPS = 3;

/** Most nodes a single search may touch. A hub event with 500 attendees must not turn one
 *  path lookup into a full traversal. */
export const MAX_VISITED = 2000;

export interface PathOpts {
  maxHops?: number;
  maxVisited?: number;
}

export interface PathResult {
  path: GraphPath | null;
  /** How many nodes the search touched — surfaced so a caller can tell "not connected" from
   *  "gave up", which are different answers to the user. */
  visited: number;
  exhausted: boolean;
}

/** Adjacency, built once per search. Undirected for traversal purposes: a check-in points
 *  user→event, but "who else was at this event" has to walk back out of it. */
function adjacency(edges: readonly GraphEdge[]): Map<GraphNodeId, Array<{ to: GraphNodeId; edge: GraphEdge }>> {
  const adj = new Map<GraphNodeId, Array<{ to: GraphNodeId; edge: GraphEdge }>>();
  const push = (from: GraphNodeId, to: GraphNodeId, edge: GraphEdge) => {
    const list = adj.get(from);
    if (list) list.push({ to, edge });
    else adj.set(from, [{ to, edge }]);
  };
  for (const e of edges) {
    push(e.a, e.b, e);
    push(e.b, e.a, e);
  }
  // Strongest, best-evidenced neighbours first, so the first path found at the minimal depth
  // is also the most defensible one at that depth.
  for (const list of adj.values()) {
    list.sort(
      (x, y) =>
        y.edge.strength - x.edge.strength ||
        TIER_RANK[strongestTier(y.edge.evidence.map((v) => v.tier)) ?? "inferred"] -
          TIER_RANK[strongestTier(x.edge.evidence.map((v) => v.tier)) ?? "inferred"],
    );
  }
  return adj;
}

/**
 * The shortest evidenced path between two nodes, or null.
 *
 * Breadth-first, so the result is minimal in hops — which matters because the number of hops
 * IS the strength of the explanation. A two-hop answer ("you were both at Founders Night") is
 * a reason; a five-hop one is trivia.
 */
export function findPath(
  from: GraphNodeId,
  to: GraphNodeId,
  edges: readonly GraphEdge[],
  opts: PathOpts = {},
): PathResult {
  const maxHops = Math.max(1, Math.min(opts.maxHops ?? MAX_HOPS, MAX_HOPS));
  const maxVisited = Math.max(1, Math.min(opts.maxVisited ?? MAX_VISITED, MAX_VISITED));

  if (from === to) return { path: { nodes: [from], edges: [] }, visited: 1, exhausted: false };

  const adj = adjacency(edges);
  const prev = new Map<GraphNodeId, { node: GraphNodeId; edge: GraphEdge }>();
  const seen = new Set<GraphNodeId>([from]);
  let frontier: GraphNodeId[] = [from];
  let visited = 1;

  for (let depth = 0; depth < maxHops && frontier.length; depth++) {
    const next: GraphNodeId[] = [];
    for (const node of frontier) {
      for (const { to: neighbour, edge } of adj.get(node) ?? []) {
        if (seen.has(neighbour)) continue;
        if (visited >= maxVisited) return { path: null, visited, exhausted: true };
        seen.add(neighbour);
        visited++;
        prev.set(neighbour, { node, edge });
        if (neighbour === to) return { path: rebuild(from, to, prev), visited, exhausted: false };
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return { path: null, visited, exhausted: frontier.length > 0 };
}

function rebuild(from: GraphNodeId, to: GraphNodeId, prev: Map<GraphNodeId, { node: GraphNodeId; edge: GraphEdge }>): GraphPath {
  const nodes: GraphNodeId[] = [to];
  const edges: GraphEdge[] = [];
  let cur = to;
  while (cur !== from) {
    const step = prev.get(cur);
    if (!step) break; // unreachable in practice; refuse to loop rather than trust the map
    edges.push(step.edge);
    nodes.push(step.node);
    cur = step.node;
  }
  return { nodes: nodes.reverse(), edges: edges.reverse() };
}

/**
 * Every distinct reason two nodes are adjacent — the direct edges between them.
 *
 * Separate from `findPath` because "we are friends AND we met in person AND we were both at
 * three events" is a richer answer than any single shortest path, and it is the one a profile
 * page wants.
 */
export function directReasons(a: GraphNodeId, b: GraphNodeId, edges: readonly GraphEdge[]): GraphEdge[] {
  const [lo, hi] = orderPair(a, b);
  return edges.filter((e) => {
    const [x, y] = orderPair(e.a, e.b);
    return x === lo && y === hi;
  });
}
