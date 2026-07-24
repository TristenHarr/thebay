import { useEffect, useRef, useState, type RefObject } from "react";
import { OSM_STYLE, BAY_CENTER } from "./osm";

/**
 * Lazy-loads MapLibre and initializes an OSM map into `containerRef`. Returns the
 * map + library refs and a `ready` flag (true after the style loads). Shared by
 * the event map and the bulletin board so neither re-implements map setup.
 */
export function useOsmMap(containerRef: RefObject<HTMLDivElement | null>, opts: { zoom?: number } = {}) {
  const mapRef = useRef<any>(null);
  const libRef = useRef<any>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mod: any = await import("maplibre-gl");
      const maplibre = mod.default ?? mod;
      if (cancelled || !containerRef.current || mapRef.current) return;
      libRef.current = maplibre;
      const map = new maplibre.Map({ container: containerRef.current, style: OSM_STYLE, center: BAY_CENTER, zoom: opts.zoom ?? 8.6, attributionControl: false });
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => !cancelled && setReady(true));
      mapRef.current = map;
    })();
    return () => { cancelled = true; mapRef.current?.remove(); mapRef.current = null; setReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { mapRef, libRef, ready };
}
