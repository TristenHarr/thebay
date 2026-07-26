/**
 * GeoJSON for the graph-over-the-Bay view.
 *
 * ## Built on the CLIENT, deliberately
 *
 * The API returns endpoints; the browser builds the geometry. A 24-point sampled polyline is
 * roughly 20× the payload of two coordinates, and `bend`/`steps` are viewport-dependent, so
 * sampling server-side would ship more bytes AND be wrong at other zooms. It also matches how
 * this repo already treats route geometry — the walking router runs in a browser Web Worker.
 *
 * ## No user nodes, and that is not an omission
 *
 * Users have no coordinates in this database, and they must not be given any. Every candidate
 * source — `shadows.lat/lng`, `place_reports.lat/lng`, `network_invites.lat/lng`,
 * `media.lat/lng` — is a GPS attestation of where a person's body physically was. Turning one
 * into a dot on a public map is a location disclosure, not a visualisation.
 *
 * So the geo view draws EVENTS and PLACES: public coordinates that are already on `/map`. An
 * arc between two events means "N people you know were at both", and that turns out to be a
 * better picture than dots-for-people — it shows how the Bay's scenes interlock.
 */
import { bendSign, bezierArc, type ArcOpts, type LngLat } from "./arcs";
import { strongestTier, type GraphEvidenceTier } from "./evidence";
import type { GraphEdge, GraphNode, GraphNodeId } from "./types";

export interface ArcProps {
  id: string;
  kind: string;
  tier: GraphEvidenceTier;
  /** How many people/evidences this arc represents → line width. */
  weight: number;
  /** [0,1] → line opacity. */
  strength: number;
  /** [0.5, 2.5] → line-width multiplier. */
  wScale: number;
  aId: string;
  bId: string;
  label: string;
}

export interface NodeProps {
  id: string;
  type: string;
  label: string;
  degree: number;
}

export type FeatureCollection<G, P> = { type: "FeatureCollection"; features: Array<{ type: "Feature"; geometry: G; properties: P }> };
type LineString = { type: "LineString"; coordinates: LngLat[] };
type Point = { type: "Point"; coordinates: LngLat };

const coordsOf = (n: GraphNode | undefined): LngLat | null =>
  n && n.lng != null && n.lat != null && Number.isFinite(n.lng) && Number.isFinite(n.lat) ? [n.lng, n.lat] : null;

/** Compress an unbounded weight into a sane stroke multiplier. Saturating, so one arc with 200
 *  people behind it doesn't render as a slab. */
function widthScale(weight: number): number {
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1;
  return Math.max(0.5, Math.min(2.5, 0.5 + Math.log2(1 + w)));
}

/**
 * Arcs for every edge whose BOTH endpoints have real coordinates.
 *
 * Also reports what it skipped: a map that quietly omits 31 ungeocoded events looks like a
 * complete picture of a smaller network, which is the same class of lie as a silently
 * truncated list.
 */
export function arcFeatures(
  edges: readonly GraphEdge[],
  nodes: Map<GraphNodeId, GraphNode>,
  o: ArcOpts = {},
): { fc: FeatureCollection<LineString, ArcProps>; skipped: { noCoords: number; degenerate: number } } {
  const features: FeatureCollection<LineString, ArcProps>["features"] = [];
  let noCoords = 0;
  let degenerate = 0;

  for (const e of edges) {
    // Canonical endpoint order, not just a symmetric bend sign. `bezierArc` builds its control
    // point from the chord DIRECTION, so drawing (b→a) mirrors the curve to the other side —
    // and a pair that arrived both ways round would render as a lens. Ordering the endpoints
    // makes the geometry byte-identical however the edge reached us.
    const [idA, idB] = e.a <= e.b ? [e.a, e.b] : [e.b, e.a];
    const a = coordsOf(nodes.get(idA));
    const b = coordsOf(nodes.get(idB));
    if (!a || !b) {
      noCoords++;
      continue;
    }
    const bend = (o.bend ?? 0.18) * bendSign(idA, idB);
    const coordinates = bezierArc(a, b, { ...o, bend });
    if (!coordinates) {
      // Out of region, or both endpoints at the same venue. Skipping is the entire reason
      // `bezierArc` returns null instead of a NaN geometry.
      degenerate++;
      continue;
    }
    const tier = strongestTier(e.evidence.map((x) => x.tier)) ?? "inferred";
    const weight = e.evidence.length;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties: {
        id: `${e.a}|${e.b}|${e.kind}`,
        kind: e.kind,
        tier,
        weight,
        strength: e.strength,
        wScale: widthScale(weight),
        aId: e.a,
        bId: e.b,
        label: nodes.get(e.a)?.label ?? "",
      },
    });
  }
  return { fc: { type: "FeatureCollection", features }, skipped: { noCoords, degenerate } };
}

/** Points for the coordinate-bearing nodes. Users are absent by design — see the header. */
export function nodeFeatures(nodes: readonly GraphNode[]): FeatureCollection<Point, NodeProps> {
  const features: FeatureCollection<Point, NodeProps>["features"] = [];
  for (const n of nodes) {
    const c = coordsOf(n);
    if (!c) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: c },
      properties: { id: n.id, type: n.type, label: n.label, degree: n.degree ?? 0 },
    });
  }
  return { type: "FeatureCollection", features };
}
