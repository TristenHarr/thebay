import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import { useMintCatchTokenMutation, useScanCatchMutation, useGetPokedexQuery, useGetMyStatsQuery, useGetMeQuery } from "../../api";
import { Card, Button, Avatar, Spinner, PageHeader, EmptyState, input } from "../../ui/kit";

/* eslint-disable @typescript-eslint/no-explicit-any */

const RARITY: Record<string, string> = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary" };
const STAT_ROWS: [string, string][] = [["capital", "Capital"], ["technical", "Technical"], ["network", "Network"], ["momentum", "Momentum"], ["reach", "Reach"]];
const QR_ROTATE_MS = 4 * 60 * 1000; // re-mint before the 5-min token expires

function StatBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <span className="w-6 shrink-0 text-right font-mono text-[10px] text-muted">{value}</span>
    </div>
  );
}

function FounderCard({ f, self }: { f: any; self?: boolean }) {
  const s = f.stats || {};
  return (
    <Card className={`pokedex-card rarity-${s.rarity || "common"} flex flex-col gap-2 p-3`} data-testid={self ? "my-card" : "founder-card"}>
      <div className="flex items-center gap-2">
        <Avatar user={{ displayName: f.displayName, avatarKey: f.avatarKey }} size={40} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{f.displayName}{self && <span className="ml-1 text-[10px] text-muted">(you)</span>}</div>
          <div className="font-mono text-[10px] text-muted">@{f.handle}</div>
        </div>
        <div className="text-right">
          <div className="pokedex-rarity">{RARITY[s.rarity] || "—"}</div>
          <div className="font-mono text-xs text-gold">⚔ {s.power ?? 0}</div>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        {STAT_ROWS.map(([k, label]) => <StatBar key={k} label={label} value={s[k] ?? 0} />)}
      </div>
    </Card>
  );
}

export function Pokedex() {
  const { data: me } = useGetMeQuery();
  const [mint] = useMintCatchTokenMutation();
  const [scan] = useScanCatchMutation();
  const { data: dexData, isLoading } = useGetPokedexQuery();
  const { data: myStats } = useGetMyStatsQuery(undefined, { skip: !me?.user });
  const [params, setParams] = useSearchParams();
  const [qr, setQr] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [caught, setCaught] = useState<any>(null);
  const [msg, setMsg] = useState("");

  // Rotating catch QR — encodes a URL a phone camera opens straight into a scan.
  useEffect(() => {
    if (!me?.user) return;
    let alive = true;
    const newCode = async () => {
      const r: any = await mint();
      if (alive && r.data?.token) {
        const url = `${location.origin}/app/pokedex?token=${r.data.token}`;
        setQr(await QRCode.toDataURL(url, { width: 240, margin: 1, color: { dark: "#0a0d12", light: "#ffffff" } }));
      }
    };
    newCode();
    const t = setInterval(newCode, QR_ROTATE_MS);
    return () => { alive = false; clearInterval(t); };
  }, [me?.user?.id, mint]);

  // Someone scanned MY code → their phone opened this page with ?token=<their code
  // is actually the SCANNED person's> — i.e. we scan whatever token arrives.
  const tokenParam = params.get("token");
  useEffect(() => {
    if (!tokenParam || !me?.user) return;
    (async () => {
      const r: any = await scan({ token: tokenParam });
      if (r.data?.ok) setCaught(r.data.caught);
      else setMsg(r.data?.reason === "self" ? "That's your own code 🙂" : r.data?.reason === "already" ? "Already in your Pokédex ✓" : "That code has expired — get a fresh one.");
      params.delete("token");
      setParams(params, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenParam, me?.user?.id]);

  async function scanManual() {
    setMsg("");
    const r: any = await scan({ token: manual.trim() });
    if (r.data?.ok) { setCaught(r.data.caught); setManual(""); }
    else setMsg(r.data?.reason || "Couldn't catch that.");
  }

  if (isLoading) return <Spinner />;
  const pokedex = dexData?.pokedex || [];

  return (
    <div data-testid="pokedex">
      <PageHeader
        title="Founder Pokédex"
        sub="The catches are people. Meet a founder in real life, scan their code, add them to your collection."
        right={<span className="font-mono text-sm text-gold">{pokedex.length} caught</span>}
      />

      {caught && (
        <Card className="mb-4 flex items-center gap-3 border-gold/50 bg-gold/5 p-3 animate-pop" data-testid="caught-banner">
          <span className="text-2xl">🎉</span>
          <div className="flex-1">
            <div className="text-sm font-semibold">Caught {caught.displayName}!</div>
            <div className="text-xs text-muted">{RARITY[caught.stats?.rarity] || ""} · added to your Pokédex</div>
          </div>
          <Button variant="quiet" onClick={() => setCaught(null)}>Nice</Button>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {myStats && me?.user && <FounderCard f={{ ...me.user, stats: myStats.stats }} self />}
        <Card className="flex flex-col items-center gap-2 p-4">
          <h3 className="text-sm font-semibold">Your catch code</h3>
          <p className="text-center text-xs text-muted">Someone scans this to catch you — or you scan theirs.</p>
          {qr ? <img src={qr} alt="Your catch QR" className="w-40 rounded-lg" /> : <div className="flex h-40 w-40 items-center justify-center"><Spinner /></div>}
          <div className="flex w-full gap-2">
            <input className={input} placeholder="…or paste a code" value={manual} onChange={(e) => setManual(e.target.value)} />
            <Button disabled={!manual.trim()} onClick={scanManual}>Catch</Button>
          </div>
          {msg && <p className="text-xs text-warn">{msg}</p>}
        </Card>
      </div>

      <h3 className="mb-2 mt-6 text-sm font-semibold text-muted">Your collection</h3>
      {pokedex.length ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {pokedex.map((f: any) => <FounderCard key={f.id} f={f} />)}
        </div>
      ) : (
        <EmptyState title="No catches yet" hint="Find a founder, open their catch code, and scan it. Rarer founders are worth more XP." />
      )}
    </div>
  );
}
