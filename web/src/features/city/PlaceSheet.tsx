import { useState } from "react";
import { useGetPlaceQuery, useReportPlaceMutation, useFlagPlaceMutation } from "../../api";
import { Card, Button, Badge, Avatar, Chip, input, cx } from "../../ui/kit";
import { describeAttrs, type FieldSpec } from "./KindFields";

/**
 * A pin's detail sheet: what it is, how much the crowd still vouches for it, and
 * — for parking — the one sentence that made anyone open this feature ("Legal
 * for 2h 15m, then street sweeping").
 *
 * Confirm / dispute are the mechanism that keeps the map true, so they are the
 * loudest control here, and they are only enabled when you are actually standing
 * at the pin (the server enforces it; this just doesn't lie about it).
 */

const FRESH: Record<string, { label: string; cls: string }> = {
  fresh: { label: "fresh", cls: "text-ok" },
  aging: { label: "aging", cls: "text-warn" },
  stale: { label: "stale", cls: "text-muted" },
  disputed: { label: "unverified", cls: "text-crit" },
};

const ago = (iso: string) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

export function PlaceSheet({ id, me, geo, onClose }: { id: string; me: any; geo: { lat: number; lng: number } | null; onClose: () => void }) {
  const { data, isLoading } = useGetPlaceQuery(id);
  const [report, { isLoading: reporting }] = useReportPlaceMutation();
  const [flag] = useFlagPlaceMutation();
  const [err, setErr] = useState("");
  const [tipOpen, setTipOpen] = useState(false);
  const [difficulty, setDifficulty] = useState(3);
  const [minutes, setMinutes] = useState("");

  if (isLoading || !data?.place) {
    return (
      <Card className="p-4 text-sm text-muted" data-testid="place-sheet">
        Loading place…
      </Card>
    );
  }
  const p = data.place;
  const fresh = FRESH[p.freshness] ?? FRESH.stale!;
  const canVouch = !!me && !!geo;

  async function send(verdict: "confirm" | "dispute" | "tip", attrs?: Record<string, unknown>) {
    if (!geo) return;
    setErr("");
    const r: any = await report({ id, verdict, attrs, lat: geo.lat, lng: geo.lng });
    if (r.error) setErr(r.error?.data?.error || "Could not send that");
    else if (verdict === "tip") setTipOpen(false);
  }

  return (
    <Card className="max-h-[70vh] overflow-y-auto p-3" data-testid="place-sheet">
      <button className="float-right text-muted hover:text-text" onClick={onClose} aria-label="Close">✕</button>
      <div className="flex items-start gap-2">
        <span className="text-2xl leading-none">{p.kind.emoji}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold leading-snug">{p.name || p.kind.label}</div>
          <div className="truncate text-xs text-muted">{p.address || p.kind.label}</div>
        </div>
      </div>

      {/* the headline: is this still true, and (parking) can I park right now */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <Badge>{p.kind.label}</Badge>
        <span className={cx("font-mono", fresh.cls)}>● {fresh.label}</span>
        <span className="font-mono text-muted">✓{p.confirms} ✕{p.disputes}</span>
        {p.origin === "import" && <span className="text-muted">from DataSF</span>}
      </div>
      {data.parking && (
        <div className={cx("mt-2 rounded-lg border px-3 py-2 text-sm font-semibold", data.parking.legal ? "border-ok/40 text-ok" : "border-crit/40 text-crit")}>
          {data.parking.legal ? "🅿️ " : "🚫 "}{data.parking.reason}
        </div>
      )}
      {data.difficulty?.difficulty != null && (
        <p className="mt-1.5 text-xs text-muted">
          Crowd says parking here is <strong className="text-text">{data.difficulty.difficulty.toFixed(1)}/5</strong> hard
          {data.difficulty.minutesToFind != null ? ` · ~${Math.round(data.difficulty.minutesToFind)} min to find a spot` : ""}
          {` · ${data.difficulty.samples} tip${data.difficulty.samples === 1 ? "" : "s"}`}
        </p>
      )}

      {/* whatever this kind declared, rendered from its own schema */}
      {describeAttrs(p.kind.fields as FieldSpec[], p.attrs).length > 0 && (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {describeAttrs(p.kind.fields as FieldSpec[], p.attrs).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-b border-border/50 py-0.5">
              <dt className="text-muted">{k}</dt>
              <dd className="truncate font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* keep it true */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button disabled={!canVouch || reporting} onClick={() => send("confirm")}>Still here ✓</Button>
        <Button variant="ghost" disabled={!canVouch || reporting} onClick={() => send("dispute")}>Gone / wrong ✕</Button>
        {p.kind.id === "parking" && (
          <Button variant="ghost" disabled={!canVouch} onClick={() => setTipOpen((v) => !v)}>How was parking?</Button>
        )}
        <button className="ml-auto text-xs text-muted hover:text-crit" onClick={() => flag({ id, reason: "spam" })} disabled={!me}>report</button>
      </div>
      {!me && <p className="mt-1 text-xs text-muted">Sign in to confirm or dispute a place.</p>}
      {me && !geo && <p className="mt-1 text-xs text-warn">Enable location — you have to be at a place to vouch for it.</p>}
      {err && <p className="mt-1 text-xs text-crit">{err}</p>}

      {tipOpen && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">Hard to park?</span>
            {[1, 2, 3, 4, 5].map((n) => (
              <Chip key={n} on={difficulty === n} onClick={() => setDifficulty(n)}>{n}</Chip>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input className={input} type="number" placeholder="minutes to find a spot" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            <Button disabled={reporting} onClick={() => send("tip", { difficulty, ...(minutes ? { minutesToFind: Number(minutes) } : {}) })}>Send</Button>
          </div>
        </div>
      )}

      {/* the report stream */}
      {data.reports.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          <h4 className="font-mono text-[11px] uppercase tracking-wide text-muted">Recent reports</h4>
          {data.reports.slice(0, 8).map((r: any) => (
            <div key={r.id} className="flex items-start gap-2 text-xs">
              <Avatar user={{ displayName: r.author.displayName, handle: r.author.handle, avatarKey: r.author.avatarKey }} size={18} />
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{r.author.displayName}</span>{" "}
                <span className="text-muted">{r.verdict}</span>
                {r.body ? <span> — {r.body}</span> : null}
                {r.attrs?.difficulty ? <span className="text-muted"> ({r.attrs.difficulty}/5)</span> : null}
              </span>
              <span className="shrink-0 font-mono text-muted">{ago(r.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
