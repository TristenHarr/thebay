import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Link } from "react-router-dom";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  useGetHeatQuery,
  useGetShadowsQuery,
  useGetMyShadowQuery,
  usePostShadowMutation,
  useReactShadowMutation,
  useReportShadowMutation,
  useDeleteShadowMutation,
  useGetFriendsQuery,
  useGetPlacesQuery,
  usePingMovementMutation,
  useGetMovementLiveQuery,
  useGetMyTrailQuery,
  useGetOrbsQuery,
  usePickupOrbMutation,
  api,
} from "../../api";
import type { RootState } from "../../store";
import { setMode, togglePinned, moveTo, resizeTo, toggleLayer, type ShadowsMode, type LayerId } from "./shadowsSlice";
import { useOsmMap } from "../map/useOsmMap";
import { Avatar } from "../../ui/kit";
import { PlaceSheet } from "../city/PlaceSheet";
import { inBay } from "../../../../src/core/geo";
import { haversineKm } from "../../../../src/core/geofence";
import { cellsInBbox, decodeBbox } from "../../../../src/core/geohash";
import { LANDMARKS } from "../../../../src/core/lore/landmarks";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Below this zoom the viewport spans too many cells to show pins — render the
// heat/treasure layer from the cheap aggregate instead. At/above it, open the
// live per-cell streams and drop individual shadow pins.
const LIVE_ZOOM = 12.5;
const CELL_ZOOM = 11; // start fetching fine-cell content (places) as you explore in
const MAX_LIVE_CELLS = 48; // bounds the zoomed-in fan-out (one query/socket per cell)

// The discovery layers of the one unified map. Later stages append trails / orbs /
// live / lore — each just plugs into this list + the map's per-layer draw effect.
const LAYERS: { id: LayerId; emoji: string; label: string }[] = [
  { id: "shadows", emoji: "🌫", label: "Shadows" },
  { id: "places", emoji: "📍", label: "Spots" },
  { id: "orbs", emoji: "⚡", label: "Orbs" },
  { id: "live", emoji: "👣", label: "Live" },
  { id: "lore", emoji: "🏛", label: "Lore" },
];
const PING_EVERY_MS = 10_000; // throttle mobbing pings
const ORB_GRAB_M = 60; // must be within ~60m to collect an orb (server re-checks)
const REACTIONS = ["🔥", "👀", "💡", "🤝", "❤️", "😯"] as const;
const KINDS: { kind: string; glyph: string; label: string }[] = [
  { kind: "thought", glyph: "💭", label: "Thought" },
  { kind: "photo", glyph: "📷", label: "Photo" },
  { kind: "voice", glyph: "🎙", label: "Voice" },
  { kind: "video", glyph: "🎥", label: "Video" },
  { kind: "connection", glyph: "🤝", label: "Met someone" },
];
const KIND_GLYPH: Record<string, string> = Object.fromEntries(KINDS.map((k) => [k.kind, k.glyph]));

type Geo = { lat: number; lng: number } | null;
type GeoStatus = "locating" | "ok" | "outside" | "denied";

function timeLeft(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "fading";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}
const ago = (iso: string) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};

/** Upload ephemeral shadow media (photo/voice → R2, video → Stream). */
async function uploadShadowMedia(kind: "photo" | "voice" | "video", blob: Blob): Promise<{ mediaKey?: string; streamId?: string; error?: string }> {
  const res = await fetch(`/api/shadows/media?kind=${kind}`, { method: "POST", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob, credentials: "same-origin" });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { error: j?.error || "upload failed" };
  return j;
}

// ───────────────────────────────────────────────────────────────────────────────

export function FloatingBoard({ me }: { me: any }) {
  const dispatch = useDispatch();
  const ui = useSelector((s: RootState) => s.shadowsUi);
  const { data: heat } = useGetHeatQuery(5, { pollingInterval: 30_000 });
  const liveCount = useMemo(() => (heat?.cells || []).reduce((n, c) => n + c.count, 0), [heat]);

  if (ui.mode === "bubble") {
    return (
      <button
        onClick={() => dispatch(setMode("open"))}
        className="shadows-bubble"
        data-testid="shadows-bubble"
        aria-label="Open the live board"
        title="Shadows — the live board"
      >
        <span className="text-lg">🌉</span>
        {liveCount > 0 && <span className="shadows-bubble-count">{liveCount}</span>}
      </button>
    );
  }
  return <Panel me={me} ui={ui} dispatch={dispatch} liveCount={liveCount} heat={heat?.cells || []} />;
}

// ───────────────────────────────────────────────────────────────────────────────

function Panel({ me, ui, dispatch, liveCount, heat }: { me: any; ui: RootState["shadowsUi"]; dispatch: any; liveCount: number; heat: { cell: string; count: number }[] }) {
  const expanded = ui.mode === "expanded";
  const [pos, setPos] = useState({ x: ui.x, y: ui.y });
  const [size, setSize] = useState({ w: ui.w, h: ui.h });
  const [mobbing, setMobbing] = useState(false); // live movement on/off (this session)
  useEffect(() => setPos({ x: ui.x, y: ui.y }), [ui.x, ui.y]);
  useEffect(() => setSize({ w: ui.w, h: ui.h }), [ui.w, ui.h]);

  // ── drag (header) ──
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const onDragDown = (e: React.PointerEvent) => {
    if (expanded) return;
    const startLeft = pos.x >= 0 ? pos.x : window.innerWidth - size.w - 20;
    const startTop = pos.y >= 0 ? pos.y : window.innerHeight - size.h - 20;
    drag.current = { dx: e.clientX - startLeft, dy: e.clientY - startTop };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const x = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - drag.current.dx));
    const y = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - drag.current.dy));
    setPos({ x, y });
  };
  const onDragUp = () => {
    if (drag.current) dispatch(moveTo(pos));
    drag.current = null;
  };

  // ── resize (corner) ──
  const rez = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const onRezDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    rez.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onRezMove = (e: React.PointerEvent) => {
    if (!rez.current) return;
    setSize({ w: Math.max(300, rez.current.w + (e.clientX - rez.current.x)), h: Math.max(320, rez.current.h + (e.clientY - rez.current.y)) });
  };
  const onRezUp = () => {
    if (rez.current) dispatch(resizeTo(size));
    rez.current = null;
  };

  const style: React.CSSProperties = expanded
    ? { inset: "3vh 3vw auto auto", width: "min(94vw, 900px)", height: "94vh" }
    : {
        width: size.w,
        height: size.h,
        left: pos.x >= 0 ? pos.x : undefined,
        top: pos.y >= 0 ? pos.y : undefined,
        right: pos.x >= 0 ? undefined : 20,
        bottom: pos.y >= 0 ? undefined : 20,
      };

  const setPanelMode = (m: ShadowsMode) => dispatch(setMode(m));

  return (
    <div className="shadows-panel animate-fade-up" data-testid="shadows-panel" style={style} onPointerMove={(e) => { onDragMove(e); onRezMove(e); }} onPointerUp={() => { onDragUp(); onRezUp(); }}>
      <header className="shadows-head" onPointerDown={onDragDown}>
        <span className="shadows-title">🏴‍☠️ The Bay{liveCount > 0 && <span className="shadows-live-dot" title={`${liveCount} live in the Bay`} />}</span>
        <div className="flex-1" />
        <Link to="/pokedex" className="shadows-icon" title="Founder Pokédex — catch people" onPointerDown={(e) => e.stopPropagation()}>🎯</Link>
        <button className="shadows-icon" title={ui.pinned ? "Unpin" : "Pin (stay put on navigation)"} onClick={() => dispatch(togglePinned())}>{ui.pinned ? "📌" : "📍"}</button>
        <button className="shadows-icon" title={expanded ? "Restore" : "Expand"} onClick={() => setPanelMode(expanded ? "open" : "expanded")}>{expanded ? "🗗" : "⛶"}</button>
        <button className="shadows-icon" title="Minimize" onClick={() => setPanelMode("bubble")}>—</button>
      </header>
      <div className="shadows-layers" data-testid="map-layers">
        {LAYERS.map((l) => (
          <button
            key={l.id}
            className={`shadows-layer ${ui.layers[l.id] ? "is-on" : ""}`}
            onClick={() => dispatch(toggleLayer(l.id))}
            title={`${ui.layers[l.id] ? "Hide" : "Show"} ${l.label}`}
          >
            {l.emoji} {l.label}
          </button>
        ))}
        <div className="flex-1" />
        {me && (
          <button
            className={`shadows-mob ${mobbing ? "is-on" : ""}`}
            data-testid="mob-toggle"
            onClick={() => setMobbing((v) => !v)}
            title={mobbing ? "Stop mobbing (live movement off)" : "Start mobbing — move to earn XP"}
          >
            {mobbing ? "● Mobbing" : "🏃 Mob"}
          </button>
        )}
      </div>
      <ShadowMap me={me} heat={heat} layers={ui.layers} mobbing={mobbing} />
      {!expanded && <div className="shadows-resize" onPointerDown={onRezDown} title="Resize" />}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────

function ShadowMap({ me, heat, layers, mobbing }: { me: any; heat: { cell: string; count: number }[]; layers: Record<string, boolean>; mobbing: boolean }) {
  const dispatch = useDispatch();
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowMarkers = useRef<any[]>([]);
  const placeMarkers = useRef<any[]>([]);
  const liveMarkers = useRef<any[]>([]);
  const trailMarkers = useRef<any[]>([]);
  const orbMarkers = useRef<any[]>([]);
  const loreMarkers = useRef<any[]>([]);
  const { mapRef, libRef, ready } = useOsmMap(containerRef, { zoom: 9 });
  const [zoom, setZoom] = useState(9);
  const [cells, setCells] = useState<string[]>([]);
  const [selected, setSelected] = useState<{ type: "shadow"; data: any } | { type: "place"; id: string } | { type: "lore"; data: any } | null>(null);
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [mobStat, setMobStat] = useState<{ xp: number; at: number } | null>(null);
  const live = zoom >= LIVE_ZOOM;
  const shadowsOn = layers.shadows !== false;
  const placesOn = !!layers.places;
  const liveOn = !!layers.live;
  const loreOn = !!layers.lore;

  const { data: shadowsData } = useGetShadowsQuery(cells.join(","), { skip: !shadowsOn || !live || !cells.length, pollingInterval: 12_000 });
  const shadows = useMemo(() => (shadowsOn ? shadowsData?.shadows || [] : []), [shadowsData, shadowsOn]);
  const { data: placesData } = useGetPlacesQuery({ cells: cells.join(","), kinds: "" }, { skip: !placesOn || zoom < CELL_ZOOM || !cells.length, pollingInterval: 60_000 });
  const places = useMemo(() => (placesOn ? placesData?.places || [] : []), [placesData, placesOn]);
  const { data: liveData } = useGetMovementLiveQuery(cells.join(","), { skip: !liveOn || zoom < CELL_ZOOM || !cells.length, pollingInterval: 5_000 });
  const dots = useMemo(() => (liveOn ? liveData?.dots || [] : []), [liveData, liveOn]);
  const { data: trailData } = useGetMyTrailQuery(undefined, { skip: !mobbing || !me, pollingInterval: 15_000 });
  const trail = useMemo(() => (mobbing ? trailData?.trail || [] : []), [trailData, mobbing]);
  const orbsOn = !!layers.orbs;
  const { data: orbData } = useGetOrbsQuery(cells.join(","), { skip: !orbsOn || zoom < CELL_ZOOM || !cells.length, pollingInterval: 30_000 });
  const orbs = useMemo(() => (orbsOn ? orbData?.orbs || [] : []), [orbData, orbsOn]);
  const orbsRef = useRef<{ id: string; lat: number; lng: number; xp: number }[]>([]);
  orbsRef.current = orbs; // keep fresh for the mobbing auto-collect (no re-subscribe)
  const [ping] = usePingMovementMutation();
  const [pickup] = usePickupOrbMutation();
  const placeGeo = geo && inBay(geo.lat, geo.lng) ? geo : null;

  // MOBBING — while on, watch position and send a throttled ping. The server measures
  // the real distance and awards capped XP; a level-up bubbles up via the Xp tag.
  useEffect(() => {
    if (!mobbing || !me || !navigator.geolocation) return;
    let last = 0;
    const id = navigator.geolocation.watchPosition(
      async (p) => {
        const now = Date.now();
        if (now - last < PING_EVERY_MS) return;
        last = now;
        const { latitude: lat, longitude: lng } = p.coords;
        if (!inBay(lat, lng)) return;
        const r: any = await ping({ lat, lng, scope: "public" });
        if (r?.data?.xp > 0) setMobStat({ xp: r.data.xp, at: now });
        // auto-collect any orb you've just walked within range of
        for (const orb of orbsRef.current) {
          if (haversineKm(lat, lng, orb.lat, orb.lng) * 1000 <= ORB_GRAB_M) {
            const g: any = await pickup({ orbId: orb.id, lat, lng });
            if (g?.data?.ok) setMobStat({ xp: g.data.xp, at: Date.now() });
          }
        }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [mobbing, me, ping, pickup]);

  // Where the user is — powers the places confirm/dispute gate (server-enforced too).
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((p) => setGeo({ lat: p.coords.latitude, lng: p.coords.longitude }), () => {}, { enableHighAccuracy: true, timeout: 8000 });
  }, []);

  // Track viewport → the visible fine cells (from CELL_ZOOM in) that feed every layer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const sync = () => {
      const z = map.getZoom();
      setZoom(z);
      if (z >= CELL_ZOOM) {
        const b = map.getBounds();
        const bbox = { minLat: b.getSouth(), minLng: b.getWest(), maxLat: b.getNorth(), maxLng: b.getEast() };
        setCells(cellsInBbox(bbox, 6).slice(0, MAX_LIVE_CELLS));
      } else {
        setCells([]);
      }
    };
    sync();
    // Belt-and-suspenders: the widget mounts into a flex/resizable container, so
    // force a resize once the style has settled in case the container measured 0
    // at init (MapLibre auto-resizes via ResizeObserver too, but this is instant).
    requestAnimationFrame(() => map.resize());
    map.on("moveend", sync);
    return () => { map.off("moveend", sync); };
  }, [ready, mapRef]);

  // Live sockets for shadows: one per visible cell (bounded). A {new}/{expire} just
  // nudges the cache to refetch — instant enough, self-heals if a socket drops.
  useEffect(() => {
    if (!shadowsOn || !live || !cells.length || !me) return;
    const sockets: WebSocket[] = [];
    let timer: any = null;
    const nudge = () => { clearTimeout(timer); timer = setTimeout(() => dispatch(api.util.invalidateTags(["Shadows"])), 300); };
    for (const cell of cells.slice(0, 12)) {
      try {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${location.host}/api/shadows/ws?cell=${cell}`);
        ws.onmessage = nudge;
        sockets.push(ws);
      } catch {
        /* realtime unavailable — polling covers it */
      }
    }
    return () => { clearTimeout(timer); sockets.forEach((s) => { try { s.close(); } catch { /* noop */ } }); };
  }, [shadowsOn, live, cells.join(","), me, dispatch]);

  // SHADOWS layer — individual pins when live, heat blobs when zoomed out. The map
  // div fills its flex parent by FLEX, never absolute+inset (MapLibre stamps
  // position:relative on its container, which would collapse inset:0 to height 0).
  useEffect(() => {
    const map = mapRef.current, maplibre = libRef.current;
    if (!map || !maplibre || !ready) return;
    shadowMarkers.current.forEach((m) => m.remove());
    shadowMarkers.current = [];
    if (!shadowsOn) return;
    if (live) {
      for (const s of shadows) {
        const el = document.createElement("div");
        el.className = "shadow-pin animate-pop";
        el.textContent = KIND_GLYPH[s.kind] || "💭";
        el.addEventListener("click", () => { setSelected({ type: "shadow", data: s }); map.flyTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 15), duration: 400 }); });
        shadowMarkers.current.push(new maplibre.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map));
      }
    } else {
      for (const h of heat) {
        if (!h.count) continue;
        const b = decodeBbox(h.cell);
        const lat = (b.minLat + b.maxLat) / 2, lng = (b.minLng + b.maxLng) / 2;
        const el = document.createElement("div");
        el.className = "shadow-heat";
        const scale = Math.min(3, 1 + Math.log2(h.count + 1) / 2);
        el.style.setProperty("--s", String(scale));
        el.textContent = h.count > 1 ? String(h.count) : "";
        el.addEventListener("click", () => map.flyTo({ center: [lng, lat], zoom: LIVE_ZOOM + 0.5, duration: 600 }));
        shadowMarkers.current.push(new maplibre.Marker({ element: el }).setLngLat([lng, lat]).addTo(map));
      }
    }
  }, [shadows, heat, live, shadowsOn, ready, mapRef, libRef]);

  // PLACES layer — the crowd-sourced spots (the kind's emoji IS the icon). This is
  // what makes the floating map "become the city map" — one surface, many layers.
  useEffect(() => {
    const map = mapRef.current, maplibre = libRef.current;
    if (!map || !maplibre || !ready) return;
    placeMarkers.current.forEach((m) => m.remove());
    placeMarkers.current = [];
    if (!placesOn) return;
    for (const p of places.slice(0, 400)) {
      const el = document.createElement("div");
      el.className = "place-pin";
      el.textContent = p.kind?.emoji ?? "📍";
      el.title = p.name || p.kind?.label || "";
      el.setAttribute("style", `font-size:20px;line-height:1;cursor:pointer;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));opacity:${p.parking && !p.parking.legal ? 0.45 : 1}`);
      el.addEventListener("click", () => { setSelected({ type: "place", id: p.id }); map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 15), duration: 400 }); });
      placeMarkers.current.push(new maplibre.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map));
    }
  }, [places, placesOn, ready, mapRef, libRef]);

  // LIVE layer — the living map: anonymous pulsing dots of people moving right now.
  useEffect(() => {
    const map = mapRef.current, maplibre = libRef.current;
    if (!map || !maplibre || !ready) return;
    liveMarkers.current.forEach((m) => m.remove());
    liveMarkers.current = [];
    if (!liveOn) return;
    for (const d of dots.slice(0, 300)) {
      const el = document.createElement("div");
      el.className = "live-dot";
      liveMarkers.current.push(new maplibre.Marker({ element: el }).setLngLat([d.lng, d.lat]).addTo(map));
    }
  }, [dots, liveOn, ready, mapRef, libRef]);

  // TRAIL — your own fading breadcrumb, drawn while you're mobbing.
  useEffect(() => {
    const map = mapRef.current, maplibre = libRef.current;
    if (!map || !maplibre || !ready) return;
    trailMarkers.current.forEach((m) => m.remove());
    trailMarkers.current = [];
    if (!mobbing || trail.length < 2) return;
    const n = trail.length;
    trail.forEach((pt, i) => {
      const el = document.createElement("div");
      el.className = "trail-dot";
      el.style.opacity = String(0.15 + 0.85 * (i / (n - 1))); // older = fainter
      trailMarkers.current.push(new maplibre.Marker({ element: el }).setLngLat([pt.lng, pt.lat]).addTo(map));
    });
  }, [trail, mobbing, ready, mapRef, libRef]);

  // ORBS layer — floating XP collectibles. Tap one you're standing near to bank its
  // XP (the server re-derives the orb + re-checks proximity). While mobbing you also
  // auto-collect any you walk within range of (see the ping loop above).
  useEffect(() => {
    const map = mapRef.current, maplibre = libRef.current;
    if (!map || !maplibre || !ready) return;
    orbMarkers.current.forEach((m) => m.remove());
    orbMarkers.current = [];
    if (!orbsOn) return;
    for (const orb of orbs) {
      const el = document.createElement("div");
      el.className = "orb-marker";
      el.textContent = "⚡";
      el.title = `+${orb.xp} XP — get within ${ORB_GRAB_M}m and tap`;
      el.addEventListener("click", async () => {
        if (!geo) return;
        const r: any = await pickup({ orbId: orb.id, lat: geo.lat, lng: geo.lng });
        if (r?.data?.ok) setMobStat({ xp: r.data.xp, at: Date.now() });
      });
      orbMarkers.current.push(new maplibre.Marker({ element: el }).setLngLat([orb.lng, orb.lat]).addTo(map));
    }
  }, [orbs, orbsOn, ready, mapRef, libRef, geo, pickup]);

  // LORE layer — the SF-VC landmarks as billboard monuments (the museum of the map).
  useEffect(() => {
    const map = mapRef.current, maplibre = libRef.current;
    if (!map || !maplibre || !ready) return;
    loreMarkers.current.forEach((m) => m.remove());
    loreMarkers.current = [];
    if (!loreOn) return;
    for (const l of LANDMARKS) {
      const el = document.createElement("div");
      el.className = "lore-marker";
      el.innerHTML = `<span class="lore-emoji">${l.emoji}</span>`;
      el.title = l.name;
      el.addEventListener("click", () => { setSelected({ type: "lore", data: l }); map.flyTo({ center: [l.lng, l.lat], zoom: Math.max(map.getZoom(), 13), duration: 500 }); });
      loreMarkers.current.push(new maplibre.Marker({ element: el }).setLngLat([l.lng, l.lat]).addTo(map));
    }
  }, [loreOn, ready, mapRef, libRef]);

  return (
    <>
      <div className="shadows-body">
        <div ref={containerRef} data-testid="shadows-map" className="shadows-map" />
        {shadowsOn && !live && <div className="shadows-hint">🔍 Zoom into a spot for live shadows{placesOn ? " + crowd spots" : ""} · {heat.reduce((n, h) => n + h.count, 0)} live in the Bay</div>}
        {mobbing && (
          <div className="mob-indicator" data-testid="mob-indicator">
            🏃 Mobbing — move to earn XP
            {mobStat && Date.now() - mobStat.at < 4000 && <span className="mob-xp animate-pop">+{mobStat.xp} XP</span>}
          </div>
        )}
        {selected?.type === "shadow" && <SelectedShadow shadow={selected.data} me={me} onClose={() => setSelected(null)} />}
        {selected?.type === "place" && (
          <div className="shadows-place-sheet animate-fade-up">
            <PlaceSheet id={selected.id} me={me} geo={placeGeo} onClose={() => setSelected(null)} />
          </div>
        )}
        {selected?.type === "lore" && (
          <div className="shadows-detail animate-fade-up" data-testid="lore-sheet">
            <button className="shadows-detail-x" onClick={() => setSelected(null)} aria-label="Close">✕</button>
            <div className="text-lg">{selected.data.emoji} <span className="font-semibold">{selected.data.name}</span></div>
            <p className="mt-1 pr-4 text-sm text-muted">{selected.data.blurb}</p>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-gold">SF founder landmark</div>
          </div>
        )}
        <ComingSoonBanner />
      </div>
      <Composer me={me} onPosted={(lat, lng) => { const map = mapRef.current; if (map) map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), LIVE_ZOOM + 0.5), duration: 500 }); }} />
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────────

/** The vision banner. We are NOT building P2P/blockchain/mesh now — this states the
 *  direction on the map itself. Dismissible, remembered in localStorage. */
function ComingSoonBanner() {
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem("bay.mesh.dismissed") === "1"; } catch { return false; } });
  if (dismissed) return null;
  return (
    <div className="mesh-banner" data-testid="mesh-banner">
      <span>🛰️ P2P blockchain-managed mesh network hosting — <b>coming soon</b></span>
      <button onClick={() => { try { localStorage.setItem("bay.mesh.dismissed", "1"); } catch { /* ignore */ } setDismissed(true); }} aria-label="Dismiss" className="mesh-x">✕</button>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────

function SelectedShadow({ shadow: s, me, onClose }: { shadow: any; me: any; onClose: () => void }) {
  const [react] = useReactShadowMutation();
  const [report] = useReportShadowMutation();
  const [del] = useDeleteShadowMutation();
  const mine = me && s.authorId === me.id;
  return (
    <div className="shadows-detail animate-fade-up">
      <button className="shadows-detail-x" onClick={onClose} aria-label="Close">✕</button>
      {s.kind === "photo" && s.mediaKey && <img src={`/api/img/${s.mediaKey}`} alt={s.body || "shadow"} className="shadows-media" />}
      {s.kind === "voice" && s.mediaKey && <audio src={`/api/img/${s.mediaKey}`} controls className="w-full" />}
      {s.kind === "video" && s.streamId && <iframe title="shadow video" src={`https://iframe.videodelivery.net/${s.streamId}`} className="shadows-media" allow="autoplay; fullscreen" />}
      {s.kind === "connection" && <p className="text-sm">🤝 met {s.connectionUserId ? "someone" : "a founder"}{s.body ? ` — ${s.body}` : ""}</p>}
      {s.body && s.kind !== "connection" && <p className="pr-4 text-sm">{s.body}</p>}
      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
        <Avatar user={{ displayName: s.author?.displayName }} size={16} />
        {s.author?.handle ? <Link to={`/u/${s.author.handle}`} className="hover:text-accent">{s.author?.displayName}</Link> : <span>{s.author?.displayName}</span>}
        · {ago(s.createdAt)} ago · <span className="text-gold">{timeLeft(s.expiresAt)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {REACTIONS.map((e) => {
          const n = s.reactions?.[e] || 0;
          return (
            <button key={e} className="shadows-react" onClick={() => react({ id: s.id, emoji: e, on: true })} disabled={!me} title={me ? "React" : "Sign in to react"}>
              {e}{n > 0 && <span className="ml-0.5 font-mono text-[10px]">{n}</span>}
            </button>
          );
        })}
        <div className="flex-1" />
        {mine ? (
          <button className="shadows-mini-btn" onClick={async () => { await del(s.id); onClose(); }}>Delete</button>
        ) : (
          me && <button className="shadows-mini-btn" onClick={async () => { await report(s.id); onClose(); }} title="Report">⚑</button>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────

function Composer({ me, onPosted }: { me: any; onPosted: (lat: number, lng: number) => void }) {
  const [geo, setGeo] = useState<Geo>(null);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("locating");
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("thought");
  const [text, setText] = useState("");
  const [media, setMedia] = useState<{ mediaKey?: string; streamId?: string; previewUrl?: string; label?: string } | null>(null);
  const [connectionUserId, setConnectionUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [post] = usePostShadowMutation();
  const { data: mine } = useGetMyShadowQuery(undefined, { skip: !me });
  const { data: friendsData } = useGetFriendsQuery(undefined, { skip: !me || kind !== "connection" });

  useEffect(() => {
    if (!navigator.geolocation) { setGeoStatus("denied"); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { const { latitude: lat, longitude: lng } = p.coords; setGeo({ lat, lng }); setGeoStatus(inBay(lat, lng) ? "ok" : "outside"); },
      () => setGeoStatus("denied"),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, []);

  const reset = () => { setText(""); setMedia(null); setConnectionUserId(""); setErr(""); setKind("thought"); setOpen(false); };

  const onFile = useCallback(async (file: File, k: "photo" | "voice" | "video") => {
    setBusy(true); setErr("");
    const r = await uploadShadowMedia(k, file);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setMedia({ mediaKey: r.mediaKey, streamId: r.streamId, previewUrl: r.mediaKey ? URL.createObjectURL(file) : undefined, label: file.name });
  }, []);

  // voice recording
  const rec = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
        setBusy(true);
        const r = await uploadShadowMedia("voice", blob);
        setBusy(false);
        if (r.error) setErr(r.error); else setMedia({ mediaKey: r.mediaKey, label: "voice note" });
      };
      rec.current = mr; mr.start(); setRecording(true);
    } catch { setErr("mic unavailable"); }
  };
  const stopRec = () => { rec.current?.stop(); setRecording(false); };

  async function submit() {
    if (!geo) return;
    setBusy(true); setErr("");
    const body: any = { lat: geo.lat, lng: geo.lng, kind };
    if (text.trim()) body.body = text.trim();
    if (media?.mediaKey) body.mediaKey = media.mediaKey;
    if (media?.streamId) body.streamId = media.streamId;
    if (kind === "connection") body.connectionUserId = connectionUserId;
    const r: any = await post(body);
    setBusy(false);
    if (r.error) { setErr(r.error?.data?.reason || r.error?.data?.error || "Could not cast your shadow"); return; }
    reset();
    onPosted(geo.lat, geo.lng);
  }

  const ready =
    kind === "thought" ? !!text.trim() :
    kind === "connection" ? !!connectionUserId :
    !!(media?.mediaKey || media?.streamId);

  if (!me) return <div className="shadows-compose-cta">📍 <Link to="/signin" className="text-accent">Sign in</Link> to cast your shadow over the Bay.</div>;
  if (geoStatus === "locating") return <div className="shadows-compose-cta">📍 Finding your location…</div>;
  if (geoStatus === "denied") return <div className="shadows-compose-cta text-warn">Enable location to cast a shadow. Reading stays open.</div>;
  if (geoStatus === "outside") return <div className="shadows-compose-cta text-warn">You're outside the Bay — shadows are cast from here on the ground. 🌉</div>;

  if (!open) {
    return (
      <button className="shadows-cast" onClick={() => setOpen(true)}>
        {mine?.active ? "↻ Replace your shadow" : "✦ Cast a shadow"}
      </button>
    );
  }

  return (
    <div className="shadows-composer animate-fade-up">
      <div className="flex items-center gap-1">
        {KINDS.map((k) => (
          <button key={k.kind} className={`shadows-kind ${kind === k.kind ? "is-active" : ""}`} title={k.label} onClick={() => { setKind(k.kind); setMedia(null); setErr(""); }}>{k.glyph}</button>
        ))}
        <div className="flex-1" />
        <button className="shadows-icon" onClick={reset} title="Cancel">✕</button>
      </div>

      {(kind === "thought" || kind === "photo" || kind === "connection" || kind === "voice" || kind === "video") && (
        <textarea className="shadows-text" rows={2} maxLength={280} placeholder={kind === "connection" ? "Add a note about who you met (optional)" : kind === "thought" ? "What's happening near you? (280)" : "Add a caption (optional)"} value={text} onChange={(e) => setText(e.target.value)} />
      )}

      {kind === "photo" && (
        <label className="shadows-file">
          {media?.previewUrl ? <img src={media.previewUrl} alt="preview" className="h-16 w-16 rounded object-cover" /> : "📷 Choose photo"}
          <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0], "photo")} />
        </label>
      )}
      {kind === "video" && (
        <label className="shadows-file">
          {media?.streamId ? "🎥 Video ready" : "🎥 Choose video"}
          <input type="file" accept="video/*" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0], "video")} />
        </label>
      )}
      {kind === "voice" && (
        <div className="flex items-center gap-2">
          {recording ? <button className="shadows-mini-btn" onClick={stopRec}>⏹ Stop</button> : <button className="shadows-mini-btn" onClick={startRec}>🎙 Record</button>}
          {media?.mediaKey && <span className="text-xs text-muted">✓ {media.label}</span>}
          <label className="shadows-file text-xs">or upload<input type="file" accept="audio/*" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0], "voice")} /></label>
        </div>
      )}
      {kind === "connection" && (
        <select className="shadows-text" value={connectionUserId} onChange={(e) => setConnectionUserId(e.target.value)}>
          <option value="">Who did you meet?</option>
          {(friendsData?.friends || []).map((f: any) => <option key={f.id} value={f.id}>{f.displayName}</option>)}
        </select>
      )}

      {mine?.active && <div className="text-[11px] text-muted">You already have a live shadow — posting replaces it.</div>}
      {err && <div className="text-xs text-crit">{err}</div>}
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-muted">📍 at your spot · vanishes in 24h</span>
        <button className="shadows-post" disabled={busy || !ready} onClick={submit}>{busy ? "…" : "Cast"}</button>
      </div>
    </div>
  );
}
