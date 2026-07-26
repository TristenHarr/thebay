/**
 * "GTA" — the dark, high-contrast MapLibre style for The Bay's vector basemap.
 *
 * The design brief in one line: a top-down crime-game minimap. Near-black land,
 * ink-black water, buildings a shade above the ground, and roads that read as a
 * glowing circuit board — every road drawn twice (a heavy dark casing under a
 * bright fill) so the network pops at any zoom, with the accent reserved for
 * motorways. Restyling like this is the whole reason we moved off raster OSM
 * tiles: a PNG from tile.openstreetmap.org can never look like this.
 *
 * Schema: Protomaps `basemaps` (the daily planet build). Source-layers and
 * attribute values below were read off the LIVE archive rather than from docs —
 * layers `earth · landcover · landuse · water · roads · buildings · boundaries ·
 * places · pois`, and `roads.kind` ∈ {highway, major_road, medium_road,
 * minor_road, path, other, rail, ferry} with the OSM class in `kind_detail`.
 *
 * Glyphs and the sprite are served from OUR origin under `/app/map/…` on purpose
 * — that path is inside the service worker's `/app/` scope predicate
 * (web/public/sw.js), so labels get cached for offline use for free. A
 * cross-origin font CDN would be uncacheable and would break the offline map.
 */
import type { StyleSpecification } from "maplibre-gl";

export const GLYPHS = "/app/map/fonts/{fontstack}/{range}.pbf";
export const SPRITE = "/app/map/sprite";
export const PMTILES_SOURCE = "bay";

const C = {
  land: "#0a0d12",
  landAlt: "#0d1118",
  park: "#10241b",
  water: "#05080f",
  building: "#19212c",
  buildingEdge: "#263041",
  casing: "#05070b",
  minor: "#4a5568",
  medium: "#8b97a8",
  major: "#c9d3e2",
  highway: "#f5c451",
  highwayCasing: "#3a2d0c",
  path: "#3d4a5c",
  rail: "#2a3341",
  label: "#c8d2e0",
  labelHalo: "#05070b",
  boundary: "#33415a",
  route: "#5b7cff",
} as const;

/** Interpolate a line width across zooms — the one bit of MapLibre boilerplate
 *  that would otherwise be copy-pasted a dozen times. */
const zoomWidth = (stops: [number, number][]): unknown[] => [
  "interpolate", ["exponential", 1.4], ["zoom"], ...stops.flat(),
];

const roadKind = (...kinds: string[]) => ["match", ["get", "kind"], kinds, true, false];

/**
 * The style. `tileUrl` comes from `pmtilesTileUrl(name)` so the SAME style object
 * works against the streamed R2 pack and the downloaded OPFS one.
 */
export function gtaStyle(tileUrl: string, opts: { labels?: boolean; maxzoom?: number } = {}): StyleSpecification {
  const labels = opts.labels !== false;
  const style = {
    version: 8,
    glyphs: GLYPHS,
    sprite: SPRITE,
    sources: {
      [PMTILES_SOURCE]: {
        type: "vector",
        tiles: [tileUrl],
        minzoom: 0,
        // The pack's own max zoom (the planet build tops out at 15, measured).
        // Telling MapLibre the truth here makes it OVERZOOM past it instead of
        // requesting tiles that don't exist.
        maxzoom: opts.maxzoom ?? 15,
        attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
      },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": C.land } },
      { id: "earth", type: "fill", source: PMTILES_SOURCE, "source-layer": "earth", paint: { "fill-color": C.landAlt } },
      {
        id: "landuse", type: "fill", source: PMTILES_SOURCE, "source-layer": "landuse", minzoom: 8,
        filter: ["match", ["get", "kind"], ["park", "forest", "nature_reserve", "wood", "grass", "pedestrian", "farmland"], true, false],
        paint: { "fill-color": C.park, "fill-opacity": 0.75 },
      },
      { id: "water", type: "fill", source: PMTILES_SOURCE, "source-layer": "water", paint: { "fill-color": C.water } },
      {
        id: "buildings", type: "fill", source: PMTILES_SOURCE, "source-layer": "buildings", minzoom: 13,
        paint: {
          "fill-color": C.building,
          "fill-outline-color": C.buildingEdge,
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 15, 0.9],
        },
      },
      {
        id: "boundaries", type: "line", source: PMTILES_SOURCE, "source-layer": "boundaries",
        paint: { "line-color": C.boundary, "line-width": 0.7, "line-dasharray": [3, 2], "line-opacity": 0.6 },
      },

      // ── roads: casing under fill, drawn minor → major so majors win overlaps ──
      {
        id: "roads-casing", type: "line", source: PMTILES_SOURCE, "source-layer": "roads", minzoom: 9,
        filter: roadKind("highway", "major_road", "medium_road", "minor_road"),
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.casing, "line-width": zoomWidth([[9, 1.6], [12, 4], [15, 12], [18, 34]]) },
      },
      {
        id: "roads-path", type: "line", source: PMTILES_SOURCE, "source-layer": "roads", minzoom: 14,
        filter: roadKind("path"),
        paint: { "line-color": C.path, "line-width": zoomWidth([[14, 0.6], [18, 3]]), "line-dasharray": [2, 2] },
      },
      {
        id: "roads-minor", type: "line", source: PMTILES_SOURCE, "source-layer": "roads", minzoom: 12,
        filter: roadKind("minor_road", "other"),
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.minor, "line-width": zoomWidth([[12, 0.8], [15, 3], [18, 12]]) },
      },
      {
        id: "roads-medium", type: "line", source: PMTILES_SOURCE, "source-layer": "roads", minzoom: 10,
        filter: roadKind("medium_road"),
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.medium, "line-width": zoomWidth([[10, 0.9], [14, 3.4], [18, 16]]) },
      },
      {
        id: "roads-major", type: "line", source: PMTILES_SOURCE, "source-layer": "roads", minzoom: 7,
        filter: roadKind("major_road"),
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.major, "line-width": zoomWidth([[7, 0.8], [12, 2.6], [16, 9], [18, 20]]) },
      },
      {
        id: "roads-highway-casing", type: "line", source: PMTILES_SOURCE, "source-layer": "roads", minzoom: 5,
        filter: roadKind("highway"),
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.highwayCasing, "line-width": zoomWidth([[5, 2], [10, 6], [16, 18], [18, 40]]) },
      },
      {
        id: "roads-highway", type: "line", source: PMTILES_SOURCE, "source-layer": "roads", minzoom: 5,
        filter: roadKind("highway"),
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": C.highway, "line-width": zoomWidth([[5, 0.9], [10, 2.6], [16, 10], [18, 24]]) },
      },
      {
        id: "rail", type: "line", source: PMTILES_SOURCE, "source-layer": "roads", minzoom: 11,
        filter: roadKind("rail"),
        paint: { "line-color": C.rail, "line-width": zoomWidth([[11, 0.6], [18, 3]]), "line-dasharray": [4, 3] },
      },
    ],
  } as unknown as StyleSpecification;

  if (labels) {
    (style.layers as unknown[]).push(
      {
        id: "road-labels", type: "symbol", source: PMTILES_SOURCE, "source-layer": "roads", minzoom: 14,
        filter: roadKind("highway", "major_road", "medium_road", "minor_road"),
        layout: {
          "symbol-placement": "line", "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"],
          "text-size": 11, "text-letter-spacing": 0.06, "symbol-spacing": 320,
        },
        paint: { "text-color": C.label, "text-halo-color": C.labelHalo, "text-halo-width": 1.4 },
      },
      {
        id: "place-labels", type: "symbol", source: PMTILES_SOURCE, "source-layer": "places", minzoom: 6,
        layout: {
          "text-field": ["get", "name"], "text-font": ["Noto Sans Medium"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 6, 11, 12, 16],
          "text-letter-spacing": 0.1, "text-transform": "uppercase", "text-max-width": 8,
        },
        paint: { "text-color": "#eef2f7", "text-halo-color": C.labelHalo, "text-halo-width": 1.8 },
      },
    );
  }
  return style;
}

/** The two layers the nav screen adds on top: a glow under a bright route line. */
export const ROUTE_LAYERS = {
  sourceId: "walk-route",
  glow: {
    id: "walk-route-glow", type: "line", source: "walk-route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": C.route, "line-width": zoomWidth([[10, 6], [16, 18]]), "line-opacity": 0.25, "line-blur": 6 },
  },
  line: {
    id: "walk-route-line", type: "line", source: "walk-route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#8fa6ff", "line-width": zoomWidth([[10, 2.5], [16, 7]]) },
  },
} as const;
