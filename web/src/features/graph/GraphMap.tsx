import { useEffect, useMemo, useRef, useState } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import { useGetGraphGeoQuery } from "../../api";
import { Card, Spinner, PageHeader, Badge } from "../../ui/kit";
import { useOsmMap } from "../map/useOsmMap";
import { GRAPH_LAYERS } from "../map/style-gta";
import { arcFeatures, nodeFeatures } from "../../../../src/core/graph/geojson";
import { describeEdge } from "../../../../src/core/graph/explain";
import type { GraphEdge, GraphNode } from "../../../../src/core/graph/types";

/**
 * Your network, drawn over the actual Bay.
 *
 * The nodes are VENUES, not people. Users have no coordinates in this database and must not be
 * given any — every candidate source (`shadows.lat/lng`, `place_reports.lat/lng`,
 * `network_invites.lat/lng`, `media.lat/lng`) is a GPS attestation of where somebody's body
 * physically was, and putting that on a map is a location disclosure rather than a
 * visualisation.
 *
 * So an arc between two venues means *"people you know were at both"*, and the picture that
 * falls out is more interesting than dots-for-people: it shows how the Bay's scenes actually
 * interlock — who bridges SoMa and Palo Alto, which rooms share a crowd.
 *
 * Geometry is built HERE rather than server-side: a sampled 24-point polyline is ~20× the
 * payload of two endpoints, and the bend is viewport-dependent.
 */
export function GraphMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { mapRef, ready } = useOsmMap(containerRef, { zoom: 9.2 });
  const { data, isLoading } = useGetGraphGeoQuery();
  const [selected, setSelected] = useState<{ label: string; sub: string } | null>(null);

  const nodes = useMemo(() => (data?.nodes ?? []) as GraphNode[], [data]);
  const edges = useMemo(() => (data?.edges ?? []) as GraphEdge[], [data]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const { arcs, points, skipped } = useMemo(() => {
    const built = arcFeatures(edges, byId);
    return { arcs: built.fc, points: nodeFeatures(nodes), skipped: built.skipped };
  }, [edges, nodes, byId]);

  // The one GeoJSON-overlay idiom in this codebase: getSource → setData, else addSource +
  // addLayer. Copied from NavMap.tsx deliberately rather than invented.
  useEffect(() => {
    const map: any = mapRef.current;
    if (!map || !ready) return;

    const arcSrc = map.getSource(GRAPH_LAYERS.arcSourceId);
    if (arcSrc) arcSrc.setData(arcs as any);
    else {
      map.addSource(GRAPH_LAYERS.arcSourceId, { type: "geojson", data: arcs } as any);
      map.addLayer(GRAPH_LAYERS.arcGlow as any);
      map.addLayer(GRAPH_LAYERS.arcLine as any);
      map.addLayer(GRAPH_LAYERS.arcActive as any);
    }

    const nodeSrc = map.getSource(GRAPH_LAYERS.nodeSourceId);
    if (nodeSrc) nodeSrc.setData(points as any);
    else {
      map.addSource(GRAPH_LAYERS.nodeSourceId, { type: "geojson", data: points } as any);
      map.addLayer(GRAPH_LAYERS.nodeHalo as any);
      map.addLayer(GRAPH_LAYERS.nodeDot as any);
    }
  }, [mapRef, ready, arcs, points]);

  // Hit-testing via queryRenderedFeatures, not per-element DOM listeners — there are no DOM
  // elements to attach to, which is the point of using layers here.
  useEffect(() => {
    const map: any = mapRef.current;
    if (!map || !ready) return;

    const onClick = (ev: any) => {
      const hits = map.queryRenderedFeatures(ev.point, { layers: [GRAPH_LAYERS.nodeDot.id, GRAPH_LAYERS.arcLine.id] });
      const hit = hits?.[0];
      if (!hit) {
        setSelected(null);
        map.setFilter(GRAPH_LAYERS.arcActive.id, ["==", ["get", "id"], ""]);
        return;
      }
      if (hit.layer.id === GRAPH_LAYERS.nodeDot.id) {
        setSelected({ label: hit.properties.label, sub: `${hit.properties.degree} connections here` });
        map.setFilter(GRAPH_LAYERS.arcActive.id, ["==", ["get", "id"], ""]);
        return;
      }
      // An arc: highlight it and explain it in words, using the same `describeEdge` the rest
      // of the app uses, so the map and the profile page cannot phrase it differently.
      const id = hit.properties.id as string;
      map.setFilter(GRAPH_LAYERS.arcActive.id, ["==", ["get", "id"], id]);
      const edge = edges.find((e) => `${e.a}|${e.b}|${e.kind}` === id || `${e.b}|${e.a}|${e.kind}` === id);
      setSelected(
        edge
          ? { label: describeEdge(edge, byId).label, sub: `${edge.evidence.length} shared ${edge.evidence.length === 1 ? "event" : "events"}` }
          : { label: "Connection", sub: "" },
      );
    };

    const onMove = (ev: any) => {
      const hits = map.queryRenderedFeatures(ev.point, { layers: [GRAPH_LAYERS.nodeDot.id, GRAPH_LAYERS.arcLine.id] });
      map.getCanvas().style.cursor = hits?.length ? "pointer" : "";
    };

    map.on("click", onClick);
    map.on("mousemove", onMove);
    return () => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
    };
  }, [mapRef, ready, edges, byId]);

  const omitted = data?.omitted;

  return (
    <div data-testid="graph-map">
      <PageHeader
        title="Your Bay"
        sub="Venues you've been to, joined by the people you know. Tap an arc to see why it's there."
        right={nodes.length ? <Badge>{nodes.length} venues · {edges.length} links</Badge> : undefined}
      />

      <Card className="overflow-hidden p-0">
        <div ref={containerRef} className="h-[62vh] w-full" />
      </Card>

      {isLoading && (
        <div className="py-6 text-center">
          <Spinner />
        </div>
      )}

      {selected && (
        <Card className="mt-3 p-3" data-testid="graph-map-selection">
          <div className="text-sm font-semibold">{selected.label}</div>
          {selected.sub && <div className="font-mono text-xs text-muted">{selected.sub}</div>}
        </Card>
      )}

      {!isLoading && nodes.length === 0 && (
        <Card className="mt-3 p-4 text-sm text-muted">
          Nothing to draw yet. Check in at a couple of events and this fills in with the venues you share with people you know.
        </Card>
      )}

      {/* Honesty about what isn't on the map. A quietly smaller picture reads as a complete
          one, which is the same class of lie as a silently truncated list. */}
      {(omitted?.noCoords || skipped.noCoords || skipped.degenerate) ? (
        <p className="mt-2 font-mono text-[11px] text-muted">
          {omitted?.noCoords ? `${omitted.noCoords} events aren't geocoded yet. ` : ""}
          {skipped.degenerate ? `${skipped.degenerate} links join venues at the same spot. ` : ""}
        </p>
      ) : null}
    </div>
  );
}
