import { useState } from "react";
import { useGetFounderTypesQuery, useGetMyIdentityQuery, useSetMyIdentityMutation, useGetMyCardQuery } from "../../api";
import { Button, Card, Spinner, PageHeader, cx } from "../../ui/kit";
import { FounderCardView } from "./Card";

/**
 * "What are you?" — the type picker, and your own card.
 *
 * SELF-DECLARED, never derived. The tempting alternative is inferring a type from
 * `founderStats` or from interests, and it is always wrong: `capital` is a word-boundary regex
 * over a free-text field, so deriving "is a VC" from it produces confident errors the person it
 * describes cannot correct.
 *
 * Declaring pays nothing — no XP, no ranking, no gym budget. The screen says so out loud,
 * because a type that paid would make "I'm an investor" the most profitable lie on the
 * platform, and it is the one claim a profile can never check.
 */
export function Identity() {
  const { data: chart, isLoading: loadingTypes } = useGetFounderTypesQuery();
  const { data: mine } = useGetMyIdentityQuery();
  const { data: cardData } = useGetMyCardQuery();
  const [save, { isLoading: saving }] = useSetMyIdentityMutation();
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<{ typeId?: string; type2Id?: string | null }>({});

  if (loadingTypes) return <Spinner />;

  const types = chart?.types ?? [];
  const primary = pending.typeId ?? mine?.typeId ?? null;
  const secondary = pending.type2Id !== undefined ? pending.type2Id : (mine?.type2Id ?? null);

  function pick(id: string) {
    // First tap sets your primary; tapping a second sets the secondary; tapping the
    // secondary again clears it. Two is the cap — Pokémon's rule, and the point at which a
    // card stops being readable.
    if (id === primary) return;
    if (id === secondary) return setPending({ typeId: primary ?? undefined, type2Id: null });
    if (!primary) return setPending({ typeId: id, type2Id: secondary });
    setPending({ typeId: primary, type2Id: id });
  }

  async function commit() {
    if (!primary) return setMsg("Pick what you are first.");
    const r: any = await save({ typeId: primary, type2Id: secondary });
    setMsg(r.error ? (r.error.data?.error ?? "Couldn't save that.") : "Saved.");
    setPending({});
  }

  return (
    <div data-testid="identity">
      <PageHeader title="What are you?" sub="Pick a type — and a second if you wear two hats. It's how people read you at a glance." />

      {msg && (
        <Card className="mb-4 p-3 text-sm" data-testid="identity-message">
          {msg}
        </Card>
      )}

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {types.map((t: any) => {
          const isPrimary = t.id === primary;
          const isSecondary = t.id === secondary;
          const vouches = mine?.vouches?.[t.id] ?? 0;
          return (
            <button
              key={t.id}
              onClick={() => pick(t.id)}
              data-testid={`type-${t.id}`}
              className={cx(
                "rounded-lg border p-3 text-left transition",
                isPrimary ? "border-accent bg-elev" : isSecondary ? "border-accent/50 bg-elev/60" : "border-border hover:border-accent/40",
              )}
              style={isPrimary || isSecondary ? { borderColor: t.color } : undefined}
            >
              <div className="flex items-center gap-2">
                <span className="text-xl">{t.emoji}</span>
                <span className="text-sm font-semibold">{t.label}</span>
                {isPrimary && <span className="ml-auto font-mono text-[9px] uppercase text-muted">main</span>}
                {isSecondary && <span className="ml-auto font-mono text-[9px] uppercase text-muted">2nd</span>}
              </div>
              <div className="mt-1 text-[11px] text-muted">{t.blurb}</div>
              {vouches > 0 && <div className="mt-1 font-mono text-[10px] text-ok">✓ {vouches} vouched</div>}
            </button>
          );
        })}
      </div>

      <div className="mb-6 flex items-center gap-3">
        <Button onClick={commit} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <p className="text-xs text-muted">
          Types are how people find their kind of room. They earn no XP and change no ranking — a type that paid would just teach everyone
          to lie about it.
        </p>
      </div>

      <h3 className="mb-2 text-sm font-semibold">Your card</h3>
      <FounderCardView card={cardData?.card} />
      <p className="mt-2 text-xs text-muted">
        Your stats come from what you've actually done — rooms you showed up in, intros that landed, reviews people left. Rarity follows
        activity, not job title.
      </p>
    </div>
  );
}
