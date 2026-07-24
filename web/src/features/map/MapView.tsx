import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import "maplibre-gl/dist/maplibre-gl.css";
import { useGetEventsQuery } from "../../api";
import { Chip, Card, Badge, input } from "../../ui/kit";
import { baseFilter, categoryCounts, type DateKey, type TimeKey } from "../discover/filter";
import { fmtDate } from "../feed/Feed";
import { useOsmMap } from "./useOsmMap";

/** The beautiful OSM map — clickable event pins, driven live by the same facets
 *  as Discover. Filtering a category makes pins pop in / out in real time. */
export function MapView() {
  const { data, isLoading } = useGetEventsQuery("?limit=3000");
  const [date, setDate] = useState<DateKey>("30d");
  const [time, setTime] = useState<TimeKey>("any");
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [free, setFree] = useState(false);
  const [selected, setSelected] = useState<any>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<any[]>([]);
  const { mapRef, libRef, ready } = useOsmMap(containerRef);

  const all = data?.events || [];
  const withCoords = useMemo(() => all.filter((e: any) => e.latitude != null && e.longitude != null), [all]);
  const base = useMemo(() => baseFilter(withCoords, { date, time, q, free, trip: null }), [withCoords, date, time, q, free]);
  const catCounts = useMemo(() => categoryCounts(base), [base]);
  const list = useMemo(() => (cats.size ? base.filter((e: any) => (e.categories || []).some((c: string) => cats.has(c))) : base), [base, cats]);

  // (re)draw pins whenever the filtered list changes
  useEffect(() => {
    const map = mapRef.current, maplibre = libRef.current;
    if (!map || !maplibre || !ready) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    for (const e of list.slice(0, 800)) {
      const el = document.createElement("div");
      el.className = "map-pin";
      el.addEventListener("click", () => { setSelected(e); map.flyTo({ center: [e.longitude, e.latitude], zoom: Math.max(map.getZoom(), 12), duration: 600 }); });
      markersRef.current.push(new maplibre.Marker({ element: el }).setLngLat([e.longitude, e.latitude]).addTo(map));
    }
  }, [list, ready]);

  const toggleCat = (c: string) => setCats((s) => { const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n; });

  // NB: don't early-return on isLoading — the map container must stay mounted so
  // useOsmMap can initialize into it; pins populate once events arrive.
  return (
    <div data-testid="map">
      <div className="mb-3 flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-bold tracking-tight">Map</h1>
          <span className="font-mono text-xs text-muted">{list.length.toLocaleString()} pinned · {withCoords.length.toLocaleString()} geocoded</span>
        </div>
        <input className={input} placeholder="Search the map…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex flex-wrap gap-1.5">
          {(["today", "weekend", "7d", "30d", "upcoming", "all"] as DateKey[]).map((k) => (
            <Chip key={k} on={date === k} onClick={() => setDate(k)}>{k === "7d" ? "7 days" : k === "30d" ? "30 days" : k}</Chip>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(["any", "morning", "afternoon", "evening"] as TimeKey[]).map((k) => <Chip key={k} on={time === k} onClick={() => setTime(k)}>{k === "any" ? "Any time" : k}</Chip>)}
          <Chip on={free} onClick={() => setFree(!free)}>Free</Chip>
        </div>
        {catCounts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {catCounts.slice(0, 10).map(([c, n]) => <Chip key={c} on={cats.has(c)} onClick={() => toggleCat(c)}>{c} <span className="font-mono opacity-60">{n}</span></Chip>)}
          </div>
        )}
      </div>

      <div className="relative overflow-hidden rounded-xl border border-border" style={{ height: "min(68vh, 620px)" }}>
        <div ref={containerRef} className="h-full w-full" />
        {selected && (
          <Card className="absolute inset-x-3 bottom-3 z-10 animate-fade-up p-3 shadow-lg sm:left-3 sm:right-auto sm:w-80">
            <button className="absolute right-2 top-2 text-muted hover:text-text" onClick={() => setSelected(null)} aria-label="Close">✕</button>
            <div className="font-mono text-xs text-accent">{fmtDate(selected.startUtc, selected.timezone)}</div>
            <Link to={`/event/${selected.id}`} className="mt-0.5 block pr-5 font-semibold leading-snug hover:text-accent">{selected.title}</Link>
            <div className="truncate text-xs text-muted">{[selected.venueName, selected.organizer].filter(Boolean).join(" · ")}</div>
            <div className="mt-1.5 flex flex-wrap gap-1">{(selected.categories || []).slice(0, 3).map((c: string) => <Badge key={c}>{c}</Badge>)}</div>
          </Card>
        )}
      </div>
      <p className="mt-2 text-center text-xs text-muted">Tap a pin to preview · adjust filters and watch events pop in and out.</p>
    </div>
  );
}
