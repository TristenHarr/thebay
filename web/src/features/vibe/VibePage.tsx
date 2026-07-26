import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useGetVibeQuery, useReportVibeMutation, useGetEventFullQuery, useGetVibePromptsQuery } from "../../api";
import { Button, Card, Spinner, PageHeader, EmptyState } from "../../ui/kit";
import { AXES, VibeCardView, type VibeAxisKey } from "./VibeCard";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MIDDLE: Record<VibeAxisKey, number> = { energy: 50, formality: 50, intimacy: 50, talkRatio: 50, signal: 50, approachability: 50 };

/** The 6-slider report card. Deliberately one screenful and zero typing required —
 *  it has to be fillable on a phone on the way out of the door. */
function ReportForm({ eventId, initial, verified }: { eventId: string; initial: any; verified: boolean }) {
  const [report, { isLoading }] = useReportVibeMutation();
  const [vals, setVals] = useState<Record<VibeAxisKey, number>>(() => {
    const start = { ...MIDDLE };
    for (const a of AXES) if (typeof initial?.[a.key] === "number") start[a.key] = initial[a.key];
    return start;
  });
  const [worthIt, setWorthIt] = useState<number>(initial?.worthIt ?? 0);
  const [done, setDone] = useState(false);

  return (
    <Card data-testid="vibe-report-form" className="mt-4 flex flex-col gap-4 p-4">
      <div>
        <h3 className="font-bold">{initial ? "Update your read" : "How was the room?"}</h3>
        <p className="text-xs text-muted">
          {verified
            ? "You're checked in, so your read counts toward the card above (+8 points, once)."
            : "You aren't checked in for this one, so your read is recorded but won't move the card."}
        </p>
      </div>

      {AXES.map((a) => (
        <label key={a.key} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-semibold">{a.label}</span>
            <span className="font-mono tabular-nums text-muted">{vals[a.key]}</span>
          </div>
          <input
            type="range" min={0} max={100} step={5}
            aria-label={a.label}
            data-testid={`vibe-slider-${a.key}`}
            value={vals[a.key]}
            onChange={(e) => setVals((v) => ({ ...v, [a.key]: Number(e.target.value) }))}
            className="w-full accent-[var(--accent)]"
          />
          <div className="flex justify-between text-[10px] text-muted"><span>{a.low}</span><span>{a.high}</span></div>
        </label>
      ))}

      <div>
        <div className="mb-1 text-sm font-semibold">Worth going again?</div>
        <div className="flex gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} of 5`}
              onClick={() => setWorthIt(n)}
              className={`h-9 w-9 rounded-full border text-sm font-bold ${worthIt >= n ? "border-transparent bg-gold/20 text-gold" : "border-border text-muted"}`}
            >
              ★
            </button>
          ))}
        </div>
      </div>

      <Button
        disabled={isLoading}
        data-testid="vibe-submit"
        onClick={async () => {
          await report({ eventId, ...vals, ...(worthIt ? { worthIt } : {}) });
          setDone(true);
        }}
      >
        {done ? "Saved ✓" : initial ? "Update my read" : "Submit my read"}
      </Button>
    </Card>
  );
}

/**
 * The other rooms you attended and haven't read yet. This is the collection loop:
 * the cards only get honest if the people who were actually there fill them in, so
 * every visit to one vibe page nudges you toward the next.
 */
function StillOwed({ exclude }: { exclude: string }) {
  const { data } = useGetVibePromptsQuery();
  const pending = (data?.pending || []).filter((p) => p.eventId !== exclude);
  if (!pending.length) return null;
  return (
    <Card data-testid="vibe-prompts" className="mt-4 p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">You were also at</div>
      <div className="flex flex-col gap-2">
        {pending.slice(0, 5).map((p) => (
          <Link key={p.eventId} to={`/event/${p.eventId}/vibe`} className="flex items-center justify-between text-sm hover:text-accent">
            <span className="truncate">{p.title}</span>
            <span className="ml-3 shrink-0 font-mono text-xs text-muted">rate the room →</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

/**
 * `/event/:id/vibe` — the strain card for a room, plus the report card that feeds it.
 *
 * The card renders for everyone (signed out included) because the server always
 * has at least a deterministic prediction for it; only the report form is gated.
 */
export function VibePage({ me }: { me: any }) {
  const { id = "" } = useParams();
  const { data, isLoading, isError } = useGetVibeQuery(id, { skip: !id });
  const { data: full } = useGetEventFullQuery(id, { skip: !id });

  if (isLoading) return <Spinner />;
  if (isError || !data?.vibe) {
    return (
      <div data-testid="vibe">
        <EmptyState title="No vibe for this event" hint="We couldn't find that event." />
      </div>
    );
  }

  return (
    <div data-testid="vibe">
      <PageHeader
        title="The room"
        sub={full?.event?.title ? `What ${full.event.title} actually feels like.` : "What this event actually feels like."}
        right={<Link to={`/event/${id}`}><Button variant="ghost">← Event</Button></Link>}
      />
      <VibeCardView vibe={data.vibe} />
      {me ? (
        <>
          <ReportForm eventId={id} initial={data.myReport} verified={!!data.canReport} />
          <StillOwed exclude={id} />
        </>
      ) : (
        <div className="mt-4"><Link to="/signin"><Button>Sign in to report the room</Button></Link></div>
      )}
    </div>
  );
}
