import { useEffect, useRef } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import { useVectorMap } from "../map/useOsmMap";
import { PMTILES_SOURCE, ROUTE_LAYERS } from "../map/style-gta";
import { attachOfflinePack } from "../../offline/opfs";
import type { LatLng } from "./router.worker";
import type { WalkRoute } from "../../../../src/core/nav/router";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The vector map + route overlay.
 *
 * Split out of <Nav> for one specific reason: the PMTiles source is registered
 * once, when MapLibre is constructed. If the map mounted before /api/maps/packs
 * resolved it would bind to a guessed pack URL and 404 forever. So the parent
 * renders this ONLY once it knows the real pack id, and `packId` is the remount key.
 */
export function NavMap({
  packUrl, packId, from, to, route, onPick, heightStyle,
}: {
  packUrl: string;
  packId: string;
  from: LatLng;
  to: LatLng | null;
  route: WalkRoute | null;
  onPick: (p: LatLng) => void;
  heightStyle?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<any[]>([]);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  // Pack ids are date-stamped and carry their zoom ceiling (`bay-z15-20260726`),
  // so the style can tell MapLibre the truth and get overzoom instead of 404s.
  const packMaxZoom = Number(/-z(\d+)-/.exec(packId)?.[1]) || undefined;

  const { mapRef, libRef, ready } = useVectorMap(containerRef, {
    zoom: 13,
    center: [from.lng, from.lat],
    packUrl,
    packMaxZoom,
  });

  // Prefer the local copy the instant it's fully installed. Same source name, so
  // the map switches from streaming R2 to reading OPFS without a reload.
  useEffect(() => {
    if (!ready) return;
    void attachOfflinePack(PMTILES_SOURCE, packId);
  }, [ready, packId]);

  // Tap anywhere to set a destination.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const onClick = (e: any) => pickRef.current({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    map.on("click", onClick);
    return () => map.off("click", onClick);
  }, [mapRef, ready]);

  // Route line + endpoint pins.
  useEffect(() => {
    const map = mapRef.current, maplibre = libRef.current;
    if (!map || !maplibre || !ready) return;
    const data = {
      type: "FeatureCollection",
      features: route ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route.polyline } }] : [],
    };
    const existing = map.getSource(ROUTE_LAYERS.sourceId);
    if (existing) existing.setData(data as any);
    else {
      map.addSource(ROUTE_LAYERS.sourceId, { type: "geojson", data } as any);
      map.addLayer(ROUTE_LAYERS.glow as any);
      map.addLayer(ROUTE_LAYERS.line as any);
    }

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    const pin = (p: LatLng, cls: string) => {
      const el = document.createElement("div");
      el.className = cls;
      markersRef.current.push(new maplibre.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map));
    };
    pin(from, "nav-pin nav-pin-start");
    if (to) pin(to, "nav-pin nav-pin-end");

    if (route && route.polyline.length > 1) {
      const bounds = new maplibre.LngLatBounds(route.polyline[0], route.polyline[0]);
      for (const c of route.polyline) bounds.extend(c);
      map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 500 });
    } else if (to) {
      map.easeTo({ center: [to.lng, to.lat], duration: 400 });
    }
  }, [route, from, to, ready, mapRef, libRef]);

  return (
    <div className="relative overflow-hidden rounded-xl border border-border" style={{ height: heightStyle ?? "min(52vh, 480px)" }}>
      <div ref={containerRef} className="h-full w-full" data-testid="nav-map" />
      <div className="pointer-events-none absolute bottom-1 right-1 rounded bg-bg/70 px-1.5 py-0.5 font-mono text-[9px] text-muted">
        © OpenStreetMap · Protomaps
      </div>
    </div>
  );
}
