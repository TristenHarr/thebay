/**
 * The sentences. This module is the product feature — everything else is plumbing that
 * exists so these strings can be true.
 *
 * Modelled on `describeAttribution` in `src/core/attribution/ledger.ts`: pure, total, and the
 * single place a tier becomes human-readable, so an `inferred` edge cannot accidentally be
 * described with the confidence of an `attested` one.
 *
 * The rule for `inferred`, restated from the ledger's "states WHEN, never WHY": no verb about
 * the relation. *"both appear near this venue"*, never *"met here"*.
 */
import { assertsFact, strongestTier, type GraphEvidenceTier } from "./evidence";
import { EDGE_SPEC, type GraphEdge, type GraphNode, type GraphNodeId, type GraphPath } from "./types";

export interface EdgeRendering {
  label: string;
  tier: GraphEvidenceTier;
  /** False for `inferred` — the renderer must dash the line and hedge the words. */
  factual: boolean;
}

const nameOf = (nodes: Map<GraphNodeId, GraphNode>, id: GraphNodeId): string => nodes.get(id)?.label ?? "someone";

/** "3 Mar 2026", or "" when the source row carried no time. */
function on(at: string | null | undefined): string {
  if (!at) return "";
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "";
  return ` on ${new Date(t).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;
}

/**
 * One edge, as a sentence a person can check.
 *
 * `co_attended` reads through its `via` node, because that is the entire citation: without
 * naming the event, "you were both at the same thing" is exactly the vague similarity claim
 * this feature replaces.
 */
export function describeEdge(e: GraphEdge, nodes: Map<GraphNodeId, GraphNode>): EdgeRendering {
  const tier = strongestTier(e.evidence.map((x) => x.tier)) ?? "inferred";
  const best = e.evidence.find((x) => x.tier === tier) ?? e.evidence[0];
  const spec = EDGE_SPEC[e.kind];
  const a = nameOf(nodes, e.a);
  const b = nameOf(nodes, e.b);

  if (!assertsFact(tier)) {
    return { label: `${a} and ${b} both appear near the same place`, tier, factual: false };
  }

  if (e.kind === "co_attended") {
    const via = best?.via?.label;
    return {
      label: via ? `${a} and ${b} were both at ${via}${on(best?.at)}` : `${a} and ${b} attended the same event`,
      tier,
      factual: true,
    };
  }

  if (e.kind === "friendship") return { label: `${a} and ${b} are connected${on(best?.at)}`, tier, factual: true };
  if (e.kind === "vouched") return { label: `${a} and ${b} met in person${on(best?.at)}`, tier, factual: true };

  // The directed user→event kinds read naturally in source order.
  return { label: `${a} ${spec.verb} ${b}${on(best?.at)}`, tier, factual: true };
}

/**
 * A whole path as one sentence per hop — the answer to "why am I connected to this?".
 *
 * The canonical two-hop case renders as:
 *   "You checked in at Founders Night on 3 Mar 2026"
 *   "Sam checked in at Founders Night on 3 Mar 2026"
 *
 * which is a citation the reader can go and verify, rather than a score they have to trust.
 */
export function explainPath(path: GraphPath, nodes: Map<GraphNodeId, GraphNode>): string[] {
  return path.edges.map((e) => describeEdge(e, nodes).label);
}

/** A one-line summary for a path, used in list contexts where a full trace is too much. */
export function summarizePath(path: GraphPath, nodes: Map<GraphNodeId, GraphNode>): string {
  if (path.edges.length === 0) return "Not connected";
  if (path.edges.length === 1) return describeEdge(path.edges[0]!, nodes).label;
  const via = path.nodes.slice(1, -1).map((id) => nameOf(nodes, id));
  return `via ${via.join(", ")}`;
}
