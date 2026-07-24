import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import "maplibre-gl/dist/maplibre-gl.css";
import { useGetNotesQuery, usePostNoteMutation } from "../../api";
import { Card, Button, PageHeader, Avatar, input } from "../../ui/kit";
import { useOsmMap } from "../map/useOsmMap";
import { inBay } from "../../../../src/core/geo";

type GeoStatus = "locating" | "ok" | "outside" | "denied";
const MAX = 280;
const ago = (iso: string) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

/** The Board — a live map bulletin board (Yik-Yak-style). Read anywhere; posting
 *  is gated to your GPS being physically in the Bay Area. */
export function Board({ me }: { me: any }) {
  const { data } = useGetNotesQuery(undefined, { pollingInterval: 20000 });
  const [postNote] = usePostNoteMutation();
  const notes = useMemo(() => data?.notes || [], [data]);

  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("locating");
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<any>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<any[]>([]);
  const { mapRef, libRef, ready } = useOsmMap(containerRef, { zoom: 11 });

  // ask for the user's location once
  useEffect(() => {
    if (!navigator.geolocation) { setGeoStatus("denied"); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { const { latitude: lat, longitude: lng } = p.coords; setGeo({ lat, lng }); setGeoStatus(inBay(lat, lng) ? "ok" : "outside"); },
      () => setGeoStatus("denied"),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, []);

  // center on the user when we have their location
  useEffect(() => { if (ready && geo && mapRef.current) mapRef.current.flyTo({ center: [geo.lng, geo.lat], zoom: 13, duration: 800 }); }, [ready, geo, mapRef]);

  // draw note pins
  useEffect(() => {
    const map = mapRef.current, maplibre = libRef.current;
    if (!map || !maplibre || !ready) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    for (const n of notes) {
      const el = document.createElement("div");
      el.className = "note-pin";
      el.addEventListener("click", () => { setSelected(n); map.flyTo({ center: [n.lng, n.lat], zoom: Math.max(map.getZoom(), 14), duration: 500 }); });
      markersRef.current.push(new maplibre.Marker({ element: el }).setLngLat([n.lng, n.lat]).addTo(map));
    }
  }, [notes, ready, mapRef, libRef]);

  const canPost = geoStatus === "ok" && !!me;
  async function submit() {
    if (!geo || !canPost || !text.trim()) return;
    setPosting(true); setErr("");
    const r: any = await postNote({ lat: geo.lat, lng: geo.lng, body: text.trim() });
    setPosting(false);
    if (r.error) { setErr(r.error?.data?.error || "Could not post"); return; }
    setText("");
  }

  return (
    <div data-testid="board">
      <PageHeader title="The Board" sub="A live bulletin board on the map — drop a note from wherever you are in the Bay." />

      {/* GPS gate + composer */}
      {geoStatus === "locating" && <Card className="mb-3 p-3 text-sm text-muted">📍 Finding your location…</Card>}
      {geoStatus === "denied" && <Card className="mb-3 p-3 text-sm text-warn">Enable location access to post. You can still read the board below.</Card>}
      {geoStatus === "outside" && <Card className="mb-3 p-3 text-sm text-warn">You're outside the Bay Area — reading is open, but posting is Bay-only. 🌉</Card>}
      {!me && geoStatus === "ok" && <Card className="mb-3 p-3 text-sm">📍 You're in the Bay! <Link to="/signin" className="text-accent">Sign in</Link> to post a note.</Card>}
      {canPost && (
        <Card className="mb-3 flex flex-col gap-2 p-3">
          <textarea className={input} rows={2} maxLength={MAX} placeholder="What's happening near you? (280 chars)" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-muted">📍 at your location · {MAX - text.length} left</span>
            <Button disabled={posting || !text.trim()} onClick={submit}>Post to the board</Button>
          </div>
          {err && <span className="text-xs text-crit">{err}</span>}
        </Card>
      )}

      {/* map */}
      <div className="relative overflow-hidden rounded-xl border border-border" style={{ height: "min(58vh, 480px)" }}>
        <div ref={containerRef} className="h-full w-full" />
        {selected && (
          <Card className="absolute inset-x-3 bottom-3 z-10 animate-fade-up p-3 sm:left-3 sm:right-auto sm:w-80">
            <button className="absolute right-2 top-2 text-muted hover:text-text" onClick={() => setSelected(null)} aria-label="Close">✕</button>
            <p className="pr-5 text-sm">{selected.body}</p>
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted"><Avatar user={{ displayName: selected.author }} size={18} /><Link to={`/u/${selected.handle}`} className="hover:text-accent">{selected.author}</Link> · {ago(selected.createdAt)} ago</div>
          </Card>
        )}
      </div>

      {/* recent feed */}
      <div className="mt-4 flex flex-col gap-2">
        <h3 className="font-mono text-xs uppercase tracking-wide text-muted">Latest on the board</h3>
        {notes.slice(0, 30).map((n: any) => (
          <Card key={n.id} className="flex items-start gap-2 p-3">
            <Avatar user={{ displayName: n.author }} size={28} />
            <div className="min-w-0 flex-1">
              <p className="text-sm">{n.body}</p>
              <div className="mt-0.5 text-xs text-muted"><Link to={`/u/${n.handle}`} className="hover:text-accent">{n.author}</Link> · {ago(n.createdAt)} ago</div>
            </div>
          </Card>
        ))}
        {!notes.length && <Card className="p-6 text-center text-sm text-muted">No notes yet — be the first to post from the Bay.</Card>}
      </div>
    </div>
  );
}
