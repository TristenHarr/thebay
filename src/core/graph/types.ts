/**
 * The graph's shape — five node types, a closed set of edge kinds, and nothing else.
 *
 * Until now "the network graph" meant friends-of-me: `GraphRepo.networkGraph` returned an
 * ego-net of accepted `friendships` whose nodes carried no type and no coordinates. Yet the
 * database has been a multi-entity graph all along — `checkins`, `rsvps`, `story_companies`,
 * `company_people`, `outcomes`/`attributions`, and (since 0023) `network_invites`, which is
 * literally a vouch edge created by two people standing next to each other.
 *
 * ## Ids are type-prefixed, and that is load-bearing
 *
 * `user:01H…` / `event:01H…`. All the id spaces are ULIDs, so an untyped id could collide
 * across tables and silently merge a person with an event. Prefixing makes the node
 * namespace disjoint by construction rather than by luck.
 *
 * ## Tags are deliberately NOT nodes
 *
 * `topic:ai` touches thousands of events. As a node it turns every ego-net into a hairball
 * whose every shortest path reads "you both like AI" — which is precisely the similarity
 * score this feature exists to replace with a citation. Tags are a filter facet, not an
 * entity.
 *
 * ## `funding_round` is not a node either
 *
 * A round has no identity anyone navigates to. It is EVIDENCE on a `raised` edge, which is
 * how funding enters the graph: through `outcomes` + `attributions`, carrying the tier of
 * the causal claim that `migrations/0019` already models.
 */
import type { GraphEvidence, GraphEvidenceTier } from "./evidence";

export const GRAPH_NODE_TYPES = ["user", "event", "story", "company", "place"] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

/** `user:01H…` — type-prefixed so two ULID spaces can never merge. */
export type GraphNodeId = string;

export function nodeId(type: GraphNodeType, id: string): GraphNodeId {
  return `${type}:${id}`;
}

/** Split a node id. Null for anything not of the form `<knownType>:<id>`. */
export function parseNodeId(value: string): { type: GraphNodeType; id: string } | null {
  const i = value.indexOf(":");
  if (i <= 0) return null;
  const type = value.slice(0, i) as GraphNodeType;
  const id = value.slice(i + 1);
  if (!id || !(GRAPH_NODE_TYPES as readonly string[]).includes(type)) return null;
  return { type, id };
}

export interface GraphNode {
  id: GraphNodeId;
  type: GraphNodeType;
  /** `display_name` | `title` | `name`. */
  label: string;
  /** Users only — the `/u/:handle` link target. */
  handle?: string | null;
  /** Present only for coordinate-bearing types. Users NEVER have these — see arcs.ts. */
  lat?: number | null;
  lng?: number | null;
  /** `start_utc` | `created_at` | `filed_at` — the time axis. */
  at?: string | null;
  me?: boolean;
  degree?: number;
}

/**
 * Every relation the projection can produce.
 *
 * `co_attended` is the odd one out: it is NOT projected from a table. It is a rendered
 * two-path (me → event ← them) that the collapsed view synthesises, and every instance
 * carries `evidence.via` naming the event that produced it. An edge of this kind without a
 * `via` is a bug.
 */
export const GRAPH_EDGE_KINDS = ["friendship", "vouched", "checkin", "rsvp", "hosted", "co_attended"] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

export interface EdgeSpec {
  from: GraphNodeType;
  to: GraphNodeType;
  tier: GraphEvidenceTier;
  /** Base strength before recency decay. Fixed per kind — a LEARNED weight would be a
   *  similarity score with extra steps, which is the thing we are avoiding. */
  strength: number;
  directed: boolean;
  /** Verb for the citation sentence. */
  verb: string;
}

export const EDGE_SPEC: Record<GraphEdgeKind, EdgeSpec> = {
  // Both sides said yes.
  friendship: { from: "user", to: "user", tier: "stated", strength: 0.9, directed: false, verb: "are connected with" },
  // Two phones, one place, one moment — the strongest edge in the system, because
  // redeeming an invite required standing next to each other.
  vouched: { from: "user", to: "user", tier: "attested", strength: 1, directed: false, verb: "vouched for" },
  // Physical presence, evidenced by a row nobody can write for themselves.
  checkin: { from: "user", to: "event", tier: "attested", strength: 1, directed: true, verb: "checked in at" },
  // An intention, not an attendance. Weakest of the event edges on purpose.
  rsvp: { from: "user", to: "event", tier: "stated", strength: 0.45, directed: true, verb: "RSVP'd to" },
  hosted: { from: "user", to: "event", tier: "attested", strength: 1, directed: true, verb: "hosted" },
  co_attended: { from: "user", to: "user", tier: "attested", strength: 0.8, directed: false, verb: "were both at" },
};

export interface GraphEdge {
  /** Canonical order for an undirected edge: `a < b` lexicographically, so a↔b and b↔a are
   *  one edge rather than two. Same trick `friendships.user_low` uses. */
  a: GraphNodeId;
  b: GraphNodeId;
  kind: GraphEdgeKind;
  directed: boolean;
  /** [0,1] — base strength, recency-decayed. */
  strength: number;
  /** ALWAYS at least one. An edge with no evidence is unrepresentable by construction. */
  evidence: GraphEvidence[];
}

export interface GraphPath {
  nodes: GraphNodeId[];
  edges: GraphEdge[];
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** What was left out, and why — the repo's honesty convention (cf. `scrape-status`'s
   *  `stale`, `query.source`). A silently truncated graph reads as a complete one. */
  /**
   * `capped` is the strongest of these signals: it means a FETCH hit its ceiling, so this graph
   * is a SAMPLE of the room rather than a shrunken picture of all of it. The counts say how
   * much was trimmed; `capped` says the trimming began before we had everything.
   */
  omitted: { nodes: number; edges: number; noCoords: number; outOfBay: number; capped: boolean };
}

/** Canonicalise an undirected pair so the same relation is one edge whichever way it
 *  arrives from SQL. */
export function orderPair(a: GraphNodeId, b: GraphNodeId): [GraphNodeId, GraphNodeId] {
  return a <= b ? [a, b] : [b, a];
}
