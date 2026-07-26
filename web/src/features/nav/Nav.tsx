import { useCallback, useEffect, useMemo, useState } from "react";
import { useGetEventsQuery, useGetMapPacksQuery } from "../../api";
import { Badge, Button, Card, Chip, EmptyState, input } from "../../ui/kit";
import { PackPanel } from "./PackPanel";
import { NavMap } from "./NavMap";
import { useWalkRouter } from "./useWalkRouter";
import type { LatLng } from "./router.worker";
import type { WalkRoute } from "../../../../src/core/nav/router";
import { inBay } from "../../../../src/core/geo";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Ferry Building — a sane Bay default when geolocation is unavailable. */
const FALLBACK: LatLng = { lat: 37.7955, lng: -122.3937 };

const fmtDist = (m: number) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km`);
const fmtMins = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

/**
 * `/nav` — offline walking navigation over the Bay.
 *
 * Everything on this screen runs on-device: the basemap is our own PMTiles pack
 * (streamed from R2, or read from the local OPFS copy once installed) and the
 * route is a bidirectional A* in a Web Worker over a downloaded CSR graph. There
 * is deliberately no routing endpoint — the whole point is that it works with the
 * network off. "Avoid hills" is not decoration in this city: it re-runs the search
 * with a quadratic grade penalty and will walk you 25% further to stay off a 20%
 * block.
 */
export function Nav() {
  const { data: packData, isLoading: packsLoading } = useGetMapPacksQuery();
  const { data: eventData } = useGetEventsQuery("?limit=1500");

  const basemap = useMemo(() => packData?.packs.find((p) => p.kind === "basemap") ?? null, [packData]);
  const walkPack = useMemo(() => {
    const p = packData?.packs.find((x) => x.kind === "walk-graph");
    return p ? { id: p.id, url: p.url, bytes: p.bytes } : null;
  }, [packData]);

  const { status, info, error: routerError, source, solve } = useWalkRouter(walkPack);

  const [from, setFrom] = useState<LatLng>(FALLBACK);
  const [geoState, setGeoState] = useState<"idle" | "locating" | "ok" | "denied" | "outside">("idle");
  const [to, setTo] = useState<LatLng | null>(null);
  const [toLabel, setToLabel] = useState("");
  const [q, setQ] = useState("");
  const [avoidHills, setAvoidHills] = useState(false);
  const [avoidStairs, setAvoidStairs] = useState(false);
  const [route, setRoute] = useState<WalkRoute | null>(null);
  const [routeErr, setRouteErr] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);

  // ── where am I ─────────────────────────────────────────────────────────────
  const locate = useCallback(() => {
    if (!navigator.geolocation) { setGeoState("denied"); return; }
    setGeoState("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        // Outside the Bay the pack has no data, so routing from there is a lie.
        if (!inBay(p.lat, p.lng)) { setGeoState("outside"); return; }
        setFrom(p);
        setGeoState("ok");
      },
      () => setGeoState("denied"),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, []);
  useEffect(() => { locate(); }, [locate]);

  // ── solve (re-runs on every toggle; stale replies are dropped) ──────────────
  useEffect(() => {
    if (!to) { setRoute(null); setRouteErr(null); return; }
    if (status !== "ready") return;
    let cancelled = false;
    setSolving(true);
    setRouteErr(null);
    solve(from, to, { avoidHills, avoidStairs })
      .then((r) => {
        if (cancelled) return;
        setRoute(r.route);
        if (!r.route) setRouteErr("No walking route found between those points.");
      })
      .catch((e: Error) => { if (!cancelled) { setRoute(null); setRouteErr(e.message); } })
      .finally(() => { if (!cancelled) setSolving(false); });
    return () => { cancelled = true; };
  }, [from, to, avoidHills, avoidStairs, status, solve]);

  // ── destination candidates from the live catalog ───────────────────────────
  const candidates = useMemo(() => {
    const all = (eventData?.events ?? []).filter((e: any) => e.latitude != null && e.longitude != null);
    const needle = q.trim().toLowerCase();
    const pool = needle ? all.filter((e: any) => `${e.title} ${e.venueName ?? ""} ${e.city ?? ""}`.toLowerCase().includes(needle)) : all;
    return pool.slice(0, 12);
  }, [eventData, q]);

  const statusLine =
    status === "unavailable" ? "No walking graph published yet — run npm run build:walk-graph and upload it."
      : status === "downloading" ? "Fetching the walking graph…"
      : status === "indexing" ? "Indexing the walking graph…"
      : status === "error" ? routerError ?? "Router failed"
      : info ? `${info.nodeCount.toLocaleString()} junctions · ${(info.edgeCount / 2).toLocaleString()} paths · ${info.streetNames.toLocaleString()} street names · ${source === "offline" ? "read from your device" : "downloaded to this tab"}`
      : "Starting the router…";

  const fromLabel =
    geoState === "ok" ? "your location"
      : geoState === "locating" ? "locating…"
      : geoState === "outside" ? "outside the Bay — using the Ferry Building"
      : "Ferry Building";

  return (
    <div data-testid="nav">
      <div className="mb-3 flex items-baseline justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Walk</h1>
        <span className="font-mono text-xs text-muted" data-testid="nav-status">{status}</span>
      </div>

      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <Card className="p-3">
          <div className="text-sm font-semibold">Route</div>
          <div className="mt-2 flex flex-col gap-1.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted">From</span>
              <span className="truncate font-mono">{fromLabel}</span>
              <Button variant="ghost" className="shrink-0 px-2 py-0.5 text-[11px]" onClick={locate}>Use my location</Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted">To</span>
              <span className="truncate font-mono">{toLabel || (to ? `${to.lat.toFixed(4)}, ${to.lng.toFixed(4)}` : "tap the map or pick an event")}</span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip on={avoidHills} onClick={() => setAvoidHills(!avoidHills)} data-testid="nav-avoid-hills">⛰ Avoid hills</Chip>
            <Chip on={avoidStairs} onClick={() => setAvoidStairs(!avoidStairs)} data-testid="nav-avoid-stairs">🪜 Step-free</Chip>
          </div>
          <p className="mt-2 font-mono text-[10px] leading-snug text-muted">{statusLine}</p>
        </Card>

        <PackPanel />
      </div>

      <input className={input} placeholder="Search events to walk to…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search destinations" />
      <div className="mt-2 flex flex-wrap gap-1.5" data-testid="nav-destinations">
        {candidates.map((e: any) => (
          <Chip
            key={e.id}
            on={toLabel === e.title}
            onClick={() => { setTo({ lat: e.latitude, lng: e.longitude }); setToLabel(e.title); }}
          >
            {e.title.length > 34 ? `${e.title.slice(0, 34)}…` : e.title}
          </Chip>
        ))}
      </div>

      <div className="mt-3">
        {basemap ? (
          <NavMap
            key={basemap.id}
            packId={basemap.id}
            packUrl={basemap.url}
            from={from}
            to={to}
            route={route}
            onPick={(p) => { setTo(p); setToLabel("Dropped pin"); }}
          />
        ) : (
          <EmptyState
            title={packsLoading ? "Looking for a basemap pack…" : "No basemap pack published yet"}
            hint={packsLoading ? undefined : "Build one with npm run build:pmtiles and upload it to the thebay-tiles R2 bucket. Routing works as soon as a walking-graph pack exists, even without the basemap."}
          />
        )}
      </div>

      {solving && <p className="mt-2 text-center text-xs text-muted">Routing…</p>}
      {routeErr && !solving && <p className="mt-2 text-center text-xs text-warn" data-testid="nav-route-error">{routeErr}</p>}

      {route && (
        <Card className="mt-3 p-3" data-testid="nav-route">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-xl font-bold">{fmtDist(route.distanceM)}</span>
            <span className="font-mono text-sm text-accent">{fmtMins(route.seconds)} walk</span>
            <span className="font-mono text-xs text-muted">↑ {Math.round(route.ascentM)} m · ↓ {Math.round(route.descentM)} m</span>
            {route.maxGrade > 0 && <span className="font-mono text-xs text-muted">max {Math.round(route.maxGrade * 100)}% grade</span>}
          </div>
          {route.warnings.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {route.warnings.map((w) => <Badge key={w}>⚠ {w}</Badge>)}
            </div>
          )}
          <ol className="mt-2 flex flex-col gap-1" data-testid="nav-steps">
            {route.steps.map((s, i) => (
              <li key={`${s.node}-${i}`} className="flex items-baseline justify-between gap-3 border-b border-border/50 pb-1 text-sm last:border-0">
                <span>{s.instruction}</span>
                {s.distanceM > 0 && <span className="shrink-0 font-mono text-xs text-muted">{fmtDist(s.distanceM)}</span>}
              </li>
            ))}
          </ol>
          <p className="mt-2 text-[10px] text-muted">
            Computed on your device{source === "offline" ? " from the installed pack" : ""} — no routing server, works offline. Voice guidance isn't part of v1.
          </p>
        </Card>
      )}

      {!route && !solving && !routeErr && (
        <div className="mt-3">
          {to && status !== "ready" ? (
            <EmptyState title="Destination set — the router isn't ready yet" hint={statusLine} />
          ) : (
            <EmptyState title="Pick somewhere to walk" hint="Tap the map or choose an event above. Routes are computed on your device — no network needed once the packs are installed." />
          )}
        </div>
      )}
    </div>
  );
}
