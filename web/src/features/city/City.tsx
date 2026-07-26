import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import "maplibre-gl/dist/maplibre-gl.css";
import { useGetPlaceKindsQuery, useGetPlacesQuery, useAddPlaceMutation } from "../../api";
import { Card, Button, Chip, PageHeader, input } from "../../ui/kit";
import { useOsmMap } from "../map/useOsmMap";
import { inBay } from "../../../../src/core/geo";
import { cellsInBbox } from "../../../../src/core/geohash";
import { KindFields, cleanAttrs, type FieldSpec, type AttrValues } from "./KindFields";
import { PlaceSheet } from "./PlaceSheet";
import { KindLab } from "./KindLab";

/**
 * The City — the crowd-sourced map of what this city actually offers: parking
 * you can legally leave a car in, wifi you can work on, water, restrooms, and
 * whatever else the crowd votes into existence.
 *
 * Reading is open to anyone. Adding or vouching requires being physically there
 * (GPS, enforced server-side) — that gate is the entire reason the data is worth
 * anything.
 *
 * Markers are the kind's emoji: there is no icon pipeline, no sprite sheet and
 * no code change when a new kind is ratified.
 */

type GeoStatus = "locating" | "ok" | "outside" | "denied";
/** ~1.2km cells — a handful covers a city-scale viewport. */
const CELL_PRECISION = 6;
const MAX_CELLS = 96;

export function City({ me }: { me: any }) {
  const { data: kindData } = useGetPlaceKindsQuery();
  const kinds = useMemo(() => kindData?.kinds ?? [], [kindData]);

  const [layers, setLayers] = useState<Set<string>>(new Set());
  const [cells, setCells] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("locating");
  const [adding, setAdding] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<any[]>([]);
  const { mapRef, libRef, ready } = useOsmMap(containerRef, { zoom: 12 });

  const kindsParam = layers.size ? [...layers].join(",") : "";
  const { data } = useGetPlacesQuery({ cells, kinds: kindsParam }, { skip: !cells, pollingInterval: 60_000 });
  const places = useMemo(() => data?.places ?? [], [data]);

  // where the user is (the write gate)
  useEffect(() => {
    if (!navigator.geolocation) { setGeoStatus("denied"); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { const { latitude: lat, longitude: lng } = p.coords; setGeo({ lat, lng }); setGeoStatus(inBay(lat, lng) ? "ok" : "outside"); },
      () => setGeoStatus("denied"),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, []);
  useEffect(() => { if (ready && geo && mapRef.current) mapRef.current.flyTo({ center: [geo.lng, geo.lat], zoom: 14, duration: 800 }); }, [ready, geo, mapRef]);

  // viewport → geohash cells (the same bounded fan-out shadows uses)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const sync = () => {
      const b = map.getBounds();
      const list = cellsInBbox(
        { minLat: b.getSouth(), maxLat: b.getNorth(), minLng: b.getWest(), maxLng: b.getEast() },
        CELL_PRECISION,
      ).slice(0, MAX_CELLS);
      setCells(list.join(","));
    };
    sync();
    map.on("moveend", sync);
    return () => map.off("moveend", sync);
  }, [ready, mapRef]);

  // emoji markers — the kind IS the icon
  useEffect(() => {
    const map = mapRef.current, maplibre = libRef.current;
    if (!map || !maplibre || !ready) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    for (const p of places.slice(0, 600)) {
      const el = document.createElement("div");
      el.className = "place-pin";
      el.textContent = p.kind?.emoji ?? "📍";
      el.title = p.name || p.kind?.label || "";
      el.setAttribute("style", `font-size:20px;line-height:1;cursor:pointer;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));opacity:${p.parking && !p.parking.legal ? 0.45 : 1}`);
      el.addEventListener("click", () => { setSelected(p.id); setAdding(false); });
      markersRef.current.push(new maplibre.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map));
    }
  }, [places, ready, mapRef, libRef]);

  const toggle = (id: string) => setLayers((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const canAdd = geoStatus === "ok" && !!me;

  return (
    <div data-testid="city">
      <PageHeader
        title="The City"
        sub="Parking, wifi, water, restrooms — pinned by the people standing there. Tap a pin to see if it's still true."
        right={<span className="font-mono text-xs text-muted">{places.length} nearby</span>}
      />

      {/* layer switcher — one chip per ratified kind */}
      <div className="mb-3 flex flex-wrap gap-1.5" data-testid="city-layers">
        <Chip on={layers.size === 0} onClick={() => setLayers(new Set())}>All</Chip>
        {kinds.map((k: any) => (
          <Chip key={k.id} on={layers.has(k.id)} onClick={() => toggle(k.id)}>{k.emoji} {k.label}</Chip>
        ))}
      </div>

      {geoStatus === "denied" && <Card className="mb-3 p-3 text-sm text-warn">Enable location to add or confirm places. Reading the map is open to everyone.</Card>}
      {geoStatus === "outside" && <Card className="mb-3 p-3 text-sm text-warn">You're outside the Bay — reading is open, but pinning is for people who are actually here. 🌉</Card>}
      {!me && geoStatus === "ok" && <Card className="mb-3 p-3 text-sm">📍 You're in the Bay! <Link to="/signin" className="text-accent">Sign in</Link> to pin what you find.</Card>}

      <div className="relative overflow-hidden rounded-xl border border-border" style={{ height: "min(62vh, 540px)" }}>
        <div ref={containerRef} className="h-full w-full" />
        {canAdd && !selected && (
          <div className="absolute right-3 top-3 z-10">
            <Button onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "＋ Pin what's here"}</Button>
          </div>
        )}
        {(selected || adding) && (
          <div className="absolute inset-x-3 bottom-3 z-10 animate-fade-up sm:left-3 sm:right-auto sm:w-96">
            {selected ? (
              <PlaceSheet id={selected} me={me} geo={geoStatus === "ok" ? geo : null} onClose={() => setSelected(null)} />
            ) : (
              <AddPlace kinds={kinds} geo={geo!} onDone={(id) => { setAdding(false); if (id) setSelected(id); }} />
            )}
          </div>
        )}
      </div>

      <KindLab me={me} />
    </div>
  );
}

/** The composer. Every field it renders comes from the chosen kind's own
 *  `fields_json` — adding a kind adds its form, with no code here. */
function AddPlace({ kinds, geo, onDone }: { kinds: any[]; geo: { lat: number; lng: number }; onDone: (id?: string) => void }) {
  const [addPlace, { isLoading }] = useAddPlaceMutation();
  const [kindId, setKindId] = useState<string>(kinds[0]?.id ?? "");
  const [name, setName] = useState("");
  const [attrs, setAttrs] = useState<AttrValues>({});
  const [err, setErr] = useState("");
  const kind = kinds.find((k) => k.id === kindId);

  async function submit() {
    setErr("");
    const r: any = await addPlace({ kindId, name: name.trim() || undefined, attrs: cleanAttrs(attrs), lat: geo.lat, lng: geo.lng });
    if (r.error) { setErr(r.error?.data?.error || "Could not add that"); return; }
    onDone(r.data?.place?.id);
  }

  return (
    <Card className="max-h-[70vh] overflow-y-auto p-3" data-testid="add-place">
      <button className="float-right text-muted hover:text-text" onClick={() => onDone()} aria-label="Close">✕</button>
      <h3 className="font-semibold">Pin what's here</h3>
      <p className="mt-0.5 text-xs text-muted">📍 Dropped at your location — that's the point: only people who are here can add it.</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {kinds.map((k: any) => (
          <Chip key={k.id} on={kindId === k.id} onClick={() => { setKindId(k.id); setAttrs({}); }}>{k.emoji} {k.label}</Chip>
        ))}
      </div>
      <input className={`${input} mt-2`} placeholder="Name (optional) — e.g. Otis St meters" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      <div className="mt-2">
        <KindFields fields={(kind?.fields ?? []) as FieldSpec[]} value={attrs} onChange={setAttrs} />
      </div>
      {err && <p className="mt-1 text-xs text-crit">{err}</p>}
      <Button className="mt-3" disabled={isLoading || !kindId} onClick={submit}>Add {kind?.emoji} {kind?.label}</Button>
    </Card>
  );
}
