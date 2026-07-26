import { useCallback, useEffect, useRef, useState } from "react";
import { useGetMapPacksQuery } from "../../api";
import { Button, Card, cx } from "../../ui/kit";
import { PMTILES_SOURCE } from "../map/style-gta";
import {
  attachOfflinePack, fmtBytes, installPack, installed, opfsSupported, preflight, removePack,
  storageStatus, type InstallProgress, type InstalledPack, type PackRef, type StorageStatus,
} from "../../offline/opfs";

/**
 * "Download the Bay (NNN MB)".
 *
 * Every number here is measured, never estimated: the size comes from an R2 HEAD
 * via /api/maps/packs, the progress comes from bytes actually written to OPFS, and
 * the remaining figure accounts for a resumed install rather than restarting the
 * bar at zero. When the browser's quota can't fit the pack we say so, with both
 * real numbers, instead of failing halfway through a 400 MB download.
 */
const mins = (s: number | null) => (s == null ? "—" : s < 90 ? `${s}s` : `${Math.round(s / 60)} min`);

export function PackPanel({ onOfflineAttached }: { onOfflineAttached?: (id: string) => void }) {
  const { data, isLoading } = useGetMapPacksQuery();
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [local, setLocal] = useState<Record<string, InstalledPack | null>>({});
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);

  const packs = data?.packs ?? [];

  const refresh = useCallback(async () => {
    setStorage(await storageStatus());
    const next: Record<string, InstalledPack | null> = {};
    for (const p of packs) next[p.id] = await installed(p.id);
    setLocal(next);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void refresh(); }, [refresh]);

  // Pre-flight each pack against the REAL quota so the button can be honest
  // before the user commits their data plan to it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const reasons: Record<string, string> = {};
      for (const p of packs) {
        const pre = await preflight({ id: p.id, bytes: p.bytes, url: p.url, etag: p.etag });
        if (!pre.ok && pre.reason) reasons[p.id] = pre.reason;
      }
      if (!cancelled) setBlocked(reasons);
    })();
    return () => { cancelled = true; };
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const install = async (ref: PackRef) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await installPack(ref, { signal: ctrl.signal, onProgress: setProgress });
      if (ref.id.endsWith(".pmtiles") && (await attachOfflinePack(PMTILES_SOURCE, ref.id))) onOfflineAttached?.(ref.id);
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") {
        setProgress({ id: ref.id, phase: "error", receivedBytes: 0, totalBytes: ref.bytes, remainingBytes: ref.bytes, bytesPerSecond: 0, etaSeconds: null, error: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      await refresh();
    }
  };

  if (!opfsSupported()) {
    return (
      <Card className="p-3" data-testid="nav-packs">
        <div className="text-sm font-semibold">Offline maps</div>
        <p className="mt-1 text-xs text-muted">This browser has no Origin Private File System, so the Bay can't be stored for offline use here. The map still streams online.</p>
      </Card>
    );
  }

  return (
    <Card className="p-3" data-testid="nav-packs">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-semibold">Offline maps</div>
        {storage && storage.quotaBytes > 0 && (
          <span className="font-mono text-[11px] text-muted">
            {fmtBytes(storage.usageBytes)} / {fmtBytes(storage.quotaBytes)} used{storage.persisted ? " · persisted" : ""}
          </span>
        )}
      </div>

      {isLoading && <p className="mt-2 text-xs text-muted">Checking what's available…</p>}
      {!isLoading && !data?.available && (
        <p className="mt-2 text-xs text-muted">
          No packs published yet. Build one with <code className="font-mono">npm run build:pmtiles</code> and{" "}
          <code className="font-mono">npm run build:walk-graph</code>, then upload to R2.
        </p>
      )}

      <div className="mt-2 flex flex-col gap-2">
        {packs.map((p) => {
          const on = local[p.id];
          const partial = on && !on.complete ? on.installedBytes : 0;
          const busy = progress?.id === p.id && progress.phase === "downloading";
          return (
            <div key={p.id} className="rounded-lg border border-border p-2" data-testid={`nav-pack-${p.kind}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs">{p.id}</div>
                  <div className="text-[11px] text-muted">
                    {p.kind === "basemap" ? "Vector basemap" : p.kind === "walk-graph" ? "Walking graph" : "Pack"} · {fmtBytes(p.bytes)}
                    {p.builtAt ? ` · built ${p.builtAt.slice(0, 10)}` : ""}
                  </div>
                </div>
                {on?.complete ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[11px] text-ok">✓ offline</span>
                    <Button variant="quiet" className="text-xs" onClick={async () => { await removePack(p.id); await refresh(); }}>Remove</Button>
                  </div>
                ) : busy ? (
                  <Button variant="quiet" className="shrink-0 text-xs" onClick={() => abortRef.current?.abort()}>Pause</Button>
                ) : (
                  <Button
                    className="shrink-0 text-xs"
                    disabled={!!blocked[p.id]}
                    title={blocked[p.id] || undefined}
                    onClick={() => install({ id: p.id, bytes: p.bytes, url: p.url, etag: p.etag })}
                  >
                    {partial ? `Resume (${fmtBytes(p.bytes - partial)} left)` : `Download (${fmtBytes(p.bytes)})`}
                  </Button>
                )}
              </div>

              {blocked[p.id] && !on?.complete && <p className="mt-1.5 text-[11px] text-warn">{blocked[p.id]}</p>}

              {progress?.id === p.id && progress.phase !== "done" && (
                <div className="mt-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface">
                    <div
                      className={cx("h-full rounded-full", progress.phase === "error" ? "bg-crit" : "bg-accent")}
                      style={{ width: `${p.bytes ? Math.min(100, (progress.receivedBytes / p.bytes) * 100) : 0}%` }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between font-mono text-[10px] text-muted">
                    <span>{fmtBytes(progress.receivedBytes)} of {fmtBytes(progress.totalBytes)}</span>
                    <span>
                      {progress.phase === "error" ? progress.error
                        : `${fmtBytes(progress.remainingBytes)} left · ${fmtBytes(progress.bytesPerSecond)}/s · ${mins(progress.etaSeconds)}`}
                    </span>
                  </div>
                </div>
              )}
              {partial > 0 && progress?.id !== p.id && (
                <p className="mt-1 font-mono text-[10px] text-muted">{fmtBytes(partial)} already on disk — downloads resume, they don't restart.</p>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-2 text-[11px] text-muted">
        Packs live in the browser's private filesystem. iOS Safari caps that near 1 GB and can evict it under storage
        pressure — installs are chunked and resumable so a partial pack still works for the area it covers.
      </p>
    </Card>
  );
}
