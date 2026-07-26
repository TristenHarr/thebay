import { useState } from "react";
import { useGetCrawlsQuery, useGetCrawlQuery, useCreateCrawlMutation, useJoinCrawlMutation, useCheckpointCrawlMutation, useGetMeQuery } from "../../api";
import { Card, Button, PageHeader, EmptyState, Spinner, Chip, input } from "../../ui/kit";
import { LANDMARKS } from "../../../../src/core/lore/landmarks";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function Crawls() {
  const { data, isLoading } = useGetCrawlsQuery();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  if (isLoading) return <Spinner />;
  if (selected) return <CrawlDetail id={selected} onBack={() => setSelected(null)} />;
  const crawls = data?.crawls || [];
  return (
    <div data-testid="crawls">
      <PageHeader
        title="Founder Crawls"
        sub="Plan a route through the city's founder landmarks, share it, and mob it together for XP."
        right={<Button onClick={() => setCreating((v) => !v)}>{creating ? "Cancel" : "＋ Plan a crawl"}</Button>}
      />
      {creating && <CreateCrawl onDone={(id) => { setCreating(false); if (id) setSelected(id); }} />}
      <div className="mt-4 flex flex-col gap-2">
        {crawls.map((c: any) => (
          <Card key={c.id} className="flex cursor-pointer items-center gap-3 p-3 hover:border-accent" onClick={() => setSelected(c.id)}>
            <span className="text-2xl">🗺️</span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{c.name}</div>
              <div className="text-xs text-muted">{c.stops} stops · {c.walkers} walking{c.description ? ` · ${c.description}` : ""}</div>
            </div>
            <span className="text-muted">→</span>
          </Card>
        ))}
        {!crawls.length && !creating && <EmptyState title="No crawls yet" hint="Plan the first one — pick a few founder landmarks in order." />}
      </div>
    </div>
  );
}

function CreateCrawl({ onDone }: { onDone: (id?: string) => void }) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [create, { isLoading }] = useCreateCrawlMutation();
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  async function submit() {
    const stops = picked.map((id) => { const l = LANDMARKS.find((x) => x.id === id)!; return { name: l.name, lat: l.lat, lng: l.lng }; });
    const r: any = await create({ name: name.trim(), stops });
    if (r.data?.id) onDone(r.data.id);
  }
  return (
    <Card className="mb-3 flex flex-col gap-2 p-3" data-testid="create-crawl">
      <input className={input} placeholder="Crawl name — e.g. Dawn Patrol" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      <div className="text-xs text-muted">Tap landmarks in the order you'll walk them:</div>
      <div className="flex flex-wrap gap-1.5">
        {LANDMARKS.map((l) => (
          <Chip key={l.id} on={picked.includes(l.id)} onClick={() => toggle(l.id)}>
            {l.emoji} {l.name}{picked.includes(l.id) ? ` ·${picked.indexOf(l.id) + 1}` : ""}
          </Chip>
        ))}
      </div>
      <Button disabled={isLoading || !name.trim() || picked.length < 2} onClick={submit}>Create crawl ({picked.length} stops)</Button>
    </Card>
  );
}

function CrawlDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { data } = useGetCrawlQuery(id);
  const { data: me } = useGetMeQuery();
  const [join] = useJoinCrawlMutation();
  const [checkpoint] = useCheckpointCrawlMutation();
  const [msg, setMsg] = useState("");
  if (!data) return <Spinner />;
  const { crawl, stops, participants } = data as any;
  const mine = participants.find((p: any) => p.userId === me?.user?.id);
  const progress = mine?.progress ?? 0;

  function checkIn() {
    setMsg("Finding you…");
    navigator.geolocation.getCurrentPosition(
      async (p) => {
        const r: any = await checkpoint({ id, stopIdx: progress, lat: p.coords.latitude, lng: p.coords.longitude });
        if (r.data?.ok) setMsg(`✓ Reached ${stops[progress]?.name}! +${r.data.xp} XP`);
        else setMsg(r.data?.status === "too-far" ? "Get closer to the stop to check in." : r.data?.status || "Not yet.");
      },
      () => setMsg("Enable location to check in."),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }

  return (
    <div data-testid="crawl-detail">
      <button onClick={onBack} className="text-sm text-muted hover:text-text">← All crawls</button>
      <PageHeader title={crawl.name} sub={crawl.description || "A founder crawl through the city."} />
      {!mine && me?.user && <Button onClick={() => join(id)}>Join this crawl</Button>}
      <div className="mt-3 flex flex-col gap-2">
        {stops.map((s: any, i: number) => (
          <Card key={i} className={`flex items-center gap-3 p-3 ${i < progress ? "opacity-60" : ""}`}>
            <span className={`font-mono text-sm ${i < progress ? "text-ok" : "text-muted"}`}>{i < progress ? "✓" : i + 1}</span>
            <span className="flex-1">{s.name}</span>
            {mine && !mine.finishedAt && i === progress && <Button variant="ghost" onClick={checkIn}>I'm here</Button>}
          </Card>
        ))}
      </div>
      {msg && <p className="mt-2 text-sm text-ok">{msg}</p>}
      {mine?.finishedAt && <p className="mt-2 text-sm text-gold">🏁 You finished this crawl!</p>}
      <h3 className="mb-1 mt-5 text-sm font-semibold text-muted">Walkers</h3>
      <div className="flex flex-col gap-1">
        {participants.map((p: any) => (
          <div key={p.userId} className="flex items-center gap-2 text-sm">
            <span className="flex-1 truncate">{p.displayName}</span>
            <span className="font-mono text-xs text-muted">{p.progress}/{stops.length}{p.finishedAt ? " 🏁" : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
