import { useEffect, useRef, useState, type RefObject } from "react";
import { OSM_STYLE, BAY_CENTER } from "./osm";
import { gtaStyle, PMTILES_SOURCE } from "./style-gta";
import { FetchSource, pmtilesTileUrl, registerPmtilesProtocol, setPmtilesSource } from "./pmtiles";

export interface MapInit {
  zoom?: number;
  center?: [number, number];
  /** A MapLibre style object. Defaults to the raster OSM style. */
  style?: unknown;
  /** Run once with the maplibre module before the Map is constructed — this is
   *  where custom protocols (pmtiles://) get registered. */
  onLibrary?: (maplibre: unknown) => void;
}

/**
 * Lazy-loads MapLibre and initializes a map into `containerRef`. Returns the map +
 * library refs and a `ready` flag (true after the style loads).
 *
 * `useOsmMap` keeps its original signature and behaviour (raster OSM, zoom 8.6,
 * NavigationControl, no attribution control) — the event map and the bulletin
 * board depend on exactly that. The vector/PMTiles path is ADDITIVE: it's the
 * same initializer with a different style, reached via `useVectorMap`.
 */
function useMapLibre(containerRef: RefObject<HTMLDivElement | null>, opts: MapInit = {}) {
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
      opts.onLibrary?.(maplibre);
      const map = new maplibre.Map({
        container: containerRef.current,
        style: opts.style ?? OSM_STYLE,
        center: opts.center ?? BAY_CENTER,
        zoom: opts.zoom ?? 8.6,
        attributionControl: false,
      });
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => !cancelled && setReady(true));
      mapRef.current = map;
    })();
    return () => { cancelled = true; mapRef.current?.remove(); mapRef.current = null; setReady(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { mapRef, libRef, ready };
}

/** The original hook — raster OSM basemap. Unchanged behaviour. */
export function useOsmMap(containerRef: RefObject<HTMLDivElement | null>, opts: { zoom?: number } = {}) {
  return useMapLibre(containerRef, { zoom: opts.zoom });
}

/**
 * The vector basemap: our own PMTiles pack out of R2 (or, once installed, out of
 * OPFS — `attachOfflinePack` swaps the source under the same name and the map
 * carries on) rendered with the dark GTA style.
 */
export function useVectorMap(
  containerRef: RefObject<HTMLDivElement | null>,
  opts: { zoom?: number; center?: [number, number]; packUrl: string; labels?: boolean; packMaxZoom?: number },
) {
  return useMapLibre(containerRef, {
    zoom: opts.zoom,
    center: opts.center,
    style: gtaStyle(pmtilesTileUrl(PMTILES_SOURCE), { labels: opts.labels, maxzoom: opts.packMaxZoom }),
    onLibrary: (maplibre) => {
      registerPmtilesProtocol(maplibre as Parameters<typeof registerPmtilesProtocol>[0]);
      // Streaming from R2 by default. The offline installer replaces this with a
      // FileSource over the local pack; nothing else in the map changes.
      setPmtilesSource(PMTILES_SOURCE, new FetchSource(opts.packUrl));
    },
  });
}
