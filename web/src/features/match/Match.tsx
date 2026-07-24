import { useMemo, useState } from "react";
import { useGetDeckQuery, useSetMatchPrefsMutation, useMatchActMutation } from "../../api";
import { Avatar, Button, Card, Chip, Spinner, PageHeader, EmptyState, input } from "../../ui/kit";
import { filterDeck } from "./filterDeck";

export function Match() {
  const { data, isLoading } = useGetDeckQuery();
  const [setPrefs] = useSetMatchPrefsMutation();
  const [act] = useMatchActMutation();
  const [looking, setLooking] = useState(true);
  const [hasIdea, setHasIdea] = useState(false);
  const [technical, setTechnical] = useState(false);
  const [commitment, setCommitment] = useState("");
  const [matched, setMatched] = useState<string | null>(null);

  const deck = data?.deck || [];
  // the filters actually narrow the deck (client-side over candidate attributes)
  const shown = useMemo(() => filterDeck(deck, { hasIdea, technical, commitment }), [deck, hasIdea, technical, commitment]);
  const top = shown[0];

  async function doAct(action: string) {
    if (!top) return;
    const r: any = await act({ targetId: top.id, action }); // invalidates Match → auto-refetch
    if (action === "invite" && r.data?.matched) setMatched(top.displayName);
  }
  const savePrefs = (patch: any) => setPrefs({ looking, hasIdea, technical, commitment: commitment || undefined, ...patch });

  return (
    <div data-testid="match">
      <PageHeader title="Match" sub="Find a co-founder or collaborator — mutual invites become a match." />

      {/* co-founder filters (Chris's "My Co-Founder Filters") */}
      <Card className="mb-4 flex flex-wrap items-center gap-2 p-3">
        <Chip on={looking} onClick={() => { const v = !looking; setLooking(v); savePrefs({ looking: v }); }}>{looking ? "In the pool ✓" : "Join the pool"}</Chip>
        <Chip on={hasIdea} onClick={() => { const v = !hasIdea; setHasIdea(v); savePrefs({ hasIdea: v }); }}>Has an idea</Chip>
        <Chip on={technical} onClick={() => { const v = !technical; setTechnical(v); savePrefs({ technical: v }); }}>Technical</Chip>
        <input className={`${input} max-w-[180px]`} placeholder="Commitment (e.g. 10h/wk)" value={commitment} onChange={(e) => setCommitment(e.target.value)} onBlur={() => savePrefs({})} />
      </Card>

      {matched && <Card className="mb-4 border-ok bg-ok/10 p-3 text-center text-ok">🎉 You matched with {matched}! Say hi in chat.</Card>}

      {isLoading ? <Spinner /> : top ? (
        <Card className="p-6 text-center">
          <div className="flex justify-center"><Avatar user={top} size={80} /></div>
          <h3 className="mt-3 text-xl font-bold">{top.displayName}</h3>
          <div className="font-mono text-sm text-muted">@{top.handle}</div>
          {top.bio && <p className="mx-auto mt-2 max-w-sm text-sm text-muted">{top.bio}</p>}
          <div className="mt-2 flex flex-wrap justify-center gap-1.5">
            {top.technical ? <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-muted">technical</span> : null}
            {top.hasIdea ? <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-muted">has an idea</span> : null}
            {top.commitment ? <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-muted">{top.commitment}</span> : null}
          </div>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button variant="quiet" onClick={() => doAct("skip")}>Skip for now</Button>
            <Button variant="ghost" onClick={() => doAct("save")}>★ Save</Button>
            <Button variant="danger" onClick={() => doAct("hide")}>Hide forever</Button>
            <Button onClick={() => doAct("invite")}>Invite to connect</Button>
          </div>
        </Card>
      ) : (
        <EmptyState title="No more people right now" hint="Check back as more founders join the pool." />
      )}
    </div>
  );
}
