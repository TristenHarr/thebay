import { useState } from "react";
import { Link } from "react-router-dom";
import { useGetImpactBoardQuery, useGetMyOutcomesQuery, useSetAttributionOptOutMutation, useConfirmAttributionMutation } from "../../api";
import { Card, Chip, PageHeader, Spinner, EmptyState, Button, Avatar } from "../../ui/kit";
import { formatUsd } from "../../../../src/core/attribution/ledger";
import { EvidenceBadge, EvidenceLegend } from "./EvidenceBadge";

type Board = "connectors" | "events" | "communities" | "venues" | "hosts";
const BOARDS: [Board, string][] = [
  ["connectors", "Super-connectors"],
  ["events", "Events"],
  ["communities", "Communities"],
  ["venues", "Venues"],
  ["hosts", "Hosts"],
];

/**
 * Impact — what the graph actually produced, and on whose word.
 *
 * Every figure here is attributed credit, split across an outcome's causes so the
 * same round can never be counted twice, and every row carries the evidence tier
 * it rests on. The legend is not decoration: a `platform` correlation says two
 * people met here before the outcome and nothing more, and this screen is where
 * that distinction has to survive contact with a leaderboard.
 */
export function Impact({ me }: { me?: any }) {
  const [board, setBoard] = useState<Board>("connectors");
  const { data, isLoading } = useGetImpactBoardQuery(board);

  return (
    <div data-testid="impact">
      <PageHeader title="Impact" sub="Outcomes attributed to intros, events, communities, venues and hosts." />
      <EvidenceLegend />

      <div className="mb-4 flex flex-wrap gap-2" data-testid="impact-tabs">
        {BOARDS.map(([b, label]) => (
          <Chip key={b} on={board === b} onClick={() => setBoard(b)}>{label}</Chip>
        ))}
      </div>

      {isLoading ? <Spinner /> : (
        <ol className="flex flex-col gap-2" data-testid="impact-board">
          {(data?.rows ?? []).map((r: any, i: number) => (
            <Card key={r.id || r.eventId || r.communityId || r.venue || i} className="flex items-center gap-3 p-3">
              <span className="w-6 font-mono font-bold text-muted">{i + 1}</span>
              {r.handle && <Avatar user={r} />}
              <div className="min-w-0 flex-1">
                <BoardName row={r} board={board} />
                <p className="text-xs text-muted">
                  {[
                    r.outcomes != null ? `${r.outcomes} outcome${r.outcomes === 1 ? "" : "s"}` : null,
                    r.intros != null ? `${r.intros} intro${r.intros === 1 ? "" : "s"}` : null,
                    r.events != null ? `${r.events} event${r.events === 1 ? "" : "s"}` : null,
                  ].filter(Boolean).join(" · ")}
                </p>
              </div>
              <span className="font-mono text-sm text-gold">{formatUsd(r.attributedUsd ?? 0)}</span>
            </Card>
          ))}
          {!data?.rows.length && (
            <EmptyState title="Nothing attributed yet" hint="When someone credits an intro or an event for a round, it shows up here." />
          )}
        </ol>
      )}

      {board === "events" && (
        <p className="mt-3 text-xs text-muted">Counts only outcomes that occurred within 12 months of the event.</p>
      )}

      {me && <MyOutcomes />}
    </div>
  );
}

function BoardName({ row, board }: { row: any; board: Board }) {
  if (board === "events" && row.eventId) return <Link to={`/event/${row.eventId}`} className="font-semibold hover:text-accent">{row.title}</Link>;
  if (board === "communities" && row.communityId) return <Link to={`/community/${row.communityId}`} className="font-semibold hover:text-accent">{row.name}</Link>;
  if (row.handle) return <Link to={`/u/${row.handle}`} className="font-semibold hover:text-accent">{row.displayName}</Link>;
  return <span className="font-semibold">{row.venue ?? row.name ?? row.title ?? "—"}</span>;
}

/** Your own outcomes, with the evidence behind each attribution, plus the opt-out. */
function MyOutcomes() {
  const { data } = useGetMyOutcomesQuery();
  const [setOptOut, { isLoading: saving }] = useSetAttributionOptOutMutation();
  const [confirm] = useConfirmAttributionMutation();

  return (
    <section className="mt-8" data-testid="my-outcomes">
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Your outcomes</h2>
      <div className="flex flex-col gap-2">
        {(data?.outcomes ?? []).map((o: any) => (
          <Card key={o.id} className="p-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-gold">{o.headline}</span>
              {o.companySlug && <Link to={`/company/${o.companySlug}`} className="text-sm font-semibold hover:text-accent">{o.companyName}</Link>}
              <div className="flex-1" />
              <span className="text-xs text-muted">{o.visibility}</span>
            </div>
            <ul className="mt-2 flex flex-col gap-1">
              {o.attributions.map((a: any) => (
                <li key={a.id} className="flex items-center gap-2 text-xs">
                  <span className="text-muted">{a.causeType}</span>
                  <EvidenceBadge evidence={a.evidence} label={a.label} />
                  {!a.causal && <span className="text-muted">co-occurrence, not cause</span>}
                  {a.evidence === "self" && <Button variant="quiet" className="text-[11px]" onClick={() => confirm(a.id)}>Ask to corroborate</Button>}
                </li>
              ))}
              {!o.attributions.length && <li className="text-xs text-muted">No cause credited yet.</li>}
            </ul>
          </Card>
        ))}
        {!data?.outcomes.length && <EmptyState title="No outcomes recorded" hint="A confirmed Form D role gives you one automatically." />}
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-elev p-3">
        <div className="flex-1 text-sm">
          <p className="font-semibold">Public by default</p>
          <p className="text-xs text-muted">Your outcomes and the credit they carry appear on public boards. Opt out and you appear on none of them.</p>
        </div>
        <Button variant="quiet" disabled={saving} onClick={() => setOptOut(true)} data-testid="attribution-opt-out">Opt out</Button>
        <Button variant="quiet" disabled={saving} onClick={() => setOptOut(false)}>Opt back in</Button>
      </div>
    </section>
  );
}
