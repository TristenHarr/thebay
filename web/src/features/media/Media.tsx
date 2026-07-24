import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useGetMediaQuery, useGetAgendaQuery, useAttachMediaMutation } from "../../api";
import { Button, Card, Spinner, PageHeader, EmptyState, Badge } from "../../ui/kit";

export const mediaUrl = (m: any): string | null => (m.kind === "photo" && m.imageId ? `/api/img/${m.imageId}` : null);

function dayKey(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

export function Media() {
  const { data, isLoading, refetch } = useGetMediaQuery();
  const { data: agenda } = useGetAgendaQuery();
  const [attach] = useAttachMediaMutation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [suggestFor, setSuggestFor] = useState<{ id: string; eventId: string } | null>(null);

  async function upload(file: File) {
    setBusy(true);
    // best-effort geo/time tagging from the device
    let lat: number | undefined, lng: number | undefined;
    await new Promise<void>((res) => {
      if (!navigator.geolocation) return res();
      navigator.geolocation.getCurrentPosition(
        (p) => { lat = p.coords.latitude; lng = p.coords.longitude; res(); },
        () => res(),
        { timeout: 2500 },
      );
    });
    const takenAt = new Date(file.lastModified || Date.now()).toISOString();
    const qs = new URLSearchParams({ kind: file.type.startsWith("video") ? "video" : "photo", takenAt });
    if (lat != null && lng != null) { qs.set("lat", String(lat)); qs.set("lng", String(lng)); }
    const r = await fetch(`/api/media?${qs}`, { method: "POST", headers: { "content-type": file.type }, body: file, credentials: "same-origin" });
    const j: any = await r.json().catch(() => ({}));
    if (j.id && j.suggestion) setSuggestFor({ id: j.id, eventId: j.suggestion });
    setBusy(false);
    refetch();
  }

  if (isLoading) return <Spinner />;
  const media = data?.media || [];
  const evTitle = new Map((agenda?.events || []).map((e: any) => [e.id, e.title]));

  // group by day (taken_at ?? created_at)
  const groups = new Map<string, any[]>();
  for (const m of media) {
    const k = dayKey(m.takenAt || m.createdAt);
    (groups.get(k) || groups.set(k, []).get(k)!).push(m);
  }

  return (
    <div data-testid="media">
      <div className="mb-4 flex items-center justify-between">
        <PageHeader title="Moments" sub="Your photos & videos from the rooms you showed up in — geo & time tagged." />
        <Button disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Uploading…" : "＋ Add"}</Button>
        <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>

      {suggestFor && (
        <Card className="mb-4 flex items-center justify-between border-accent bg-accent/10 p-3 text-sm">
          <span>📍 Looks like this was at <b>{evTitle.get(suggestFor.eventId) || "an event"}</b>. Tag it?</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setSuggestFor(null)}>No</Button>
            <Button onClick={async () => { await attach({ id: suggestFor.id, eventId: suggestFor.eventId }); setSuggestFor(null); }}>Tag event</Button>
          </div>
        </Card>
      )}

      {!media.length && <EmptyState title="No moments yet" hint="Add a photo from an event — it'll be tagged with where and when." />}

      {[...groups.entries()].map(([day, items]) => (
        <div key={day} className="mb-6">
          <h3 className="mb-2 font-mono text-xs uppercase tracking-wide text-muted">{day}</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {items.map((m: any) => {
              const url = mediaUrl(m);
              return (
                <Card key={m.id} className="group relative overflow-hidden">
                  {url ? (
                    <img src={url} alt={m.caption || ""} className="aspect-square w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center bg-bg text-3xl text-muted">{m.kind === "video" ? "▶" : "🖼"}</div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/70 to-transparent p-1.5 text-[10px] text-white">
                    {m.lat != null && <span title="geo-tagged">📍</span>}
                    {m.eventId ? <Link to={`/event/${m.eventId}`} className="truncate hover:underline">{evTitle.get(m.eventId) || "event"}</Link> : <span className="opacity-70">untagged</span>}
                    {m.kind === "video" && <Badge>video</Badge>}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
