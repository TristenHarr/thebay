import { Card, Badge } from "../../ui/kit";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Mirrors the server's `VibeCard` (src/storage/d1/vibe-repo.ts). */
export interface Vibe {
  eventId: string;
  axes: Record<VibeAxisKey, number>;
  headline: string;
  blurb: string;
  bestFor: string[];
  expect: string[];
  crowd: Record<string, number>;
  source: "predicted" | "blended" | "reported";
  confidence: number;
  nReports: number;
  model: string | null;
  updatedAt: string;
}

export type VibeAxisKey = "energy" | "formality" | "intimacy" | "talkRatio" | "signal" | "approachability";

/** The six axes with the poles spelled out, so a number is never ambiguous. */
export const AXES: Array<{ key: VibeAxisKey; label: string; low: string; high: string }> = [
  { key: "energy", label: "Energy", low: "calm", high: "electric" },
  { key: "formality", label: "Formality", low: "hoodies", high: "black tie" },
  { key: "intimacy", label: "Intimacy", low: "big room", high: "tight circle" },
  { key: "talkRatio", label: "Talks vs. mingling", low: "all mingling", high: "all talks" },
  { key: "signal", label: "Signal", low: "recruiters", high: "real builders" },
  { key: "approachability", label: "Approachability", low: "cliquey", high: "everyone says hi" },
];

/**
 * The provenance line. This is the honesty contract from B5, rendered: a
 * prediction is labelled as a prediction and NEVER dressed up as agreement.
 * If you change one thing on this card, change something else.
 */
export function VibeProvenance({ vibe }: { vibe: Vibe }) {
  const pct = Math.round(vibe.confidence * 100);
  if (vibe.source === "predicted") {
    return (
      <div data-testid="vibe-provenance" className="flex items-center gap-2 text-xs text-muted">
        <Badge>Predicted</Badge>
        <span>Predicted from the listing — nobody has reported this room yet.</span>
        <span className="font-mono">{pct}%</span>
      </div>
    );
  }
  const n = vibe.nReports;
  return (
    <div data-testid="vibe-provenance" className="flex items-center gap-2 text-xs text-muted">
      <Badge gold>{vibe.source === "reported" ? "Reported" : "Blended"}</Badge>
      <span>
        <strong className="text-text">{n} verified {n === 1 ? "attendee" : "attendees"}</strong>{" "}
        {vibe.source === "reported" ? "describe it this way." : "have weighed in; the rest is predicted."}
      </span>
      <span className="font-mono">{pct}%</span>
    </div>
  );
}

function Meter({ label, low, high, value }: { label: string; low: string; high: string; value: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-semibold">{label}</span>
        <span className="font-mono tabular-nums text-muted">{value}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-muted">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

/**
 * The strain card: numbers, prose, best-for, who's in the room — and always an
 * explicit statement of where the numbers came from.
 */
export function VibeCardView({ vibe, compact }: { vibe: Vibe; compact?: boolean }) {
  const crowd = Object.entries(vibe.crowd).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return (
    <Card data-testid="vibe-card" className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-lg font-bold tracking-tight" style={{ textWrap: "balance" } as any}>{vibe.headline}</h2>
        <p className="mt-1 text-sm text-muted">{vibe.blurb}</p>
      </div>

      <VibeProvenance vibe={vibe} />

      {!compact && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="vibe-axes">
          {AXES.map((a) => <Meter key={a.key} label={a.label} low={a.low} high={a.high} value={vibe.axes[a.key]} />)}
        </div>
      )}

      {!!vibe.bestFor.length && (
        <div data-testid="vibe-best-for">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Best for</div>
          <div className="flex flex-wrap gap-1.5">
            {vibe.bestFor.map((b) => (
              <span key={b} className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-semibold">{b}</span>
            ))}
          </div>
        </div>
      )}

      {!compact && !!vibe.expect.length && (
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">What to expect</div>
          <ul className="flex flex-col gap-1 text-sm text-muted">
            {vibe.expect.map((e) => <li key={e}>· {e}</li>)}
          </ul>
        </div>
      )}

      {!compact && !!crowd.length && (
        <div data-testid="vibe-crowd">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Who's in the room</div>
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface">
            {crowd.map(([k, v], i) => (
              <div key={k} title={`${k} ${v}%`} style={{ width: `${v}%`, opacity: 1 - i * 0.15 }} className="h-full bg-accent" />
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            {crowd.map(([k, v]) => <span key={k}>{k} <span className="font-mono">{v}%</span></span>)}
          </div>
        </div>
      )}
    </Card>
  );
}
