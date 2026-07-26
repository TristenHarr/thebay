import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useGetEventsQuery, useFriendsFeedQuery, useRsvpMutation } from "../../api";
import { Card, Avatar, Chip, Badge, SkeletonList, PageHeader, EmptyState, Button, input } from "../../ui/kit";
import { fmtDate } from "../feed/Feed";
import { baseFilter, categoryCounts, applyCategoryAndSort, communityCounts, COMMUNITY_LABELS, type DateKey, type TimeKey } from "./filter";
import { useInfinite } from "../../ui/useInfinite";

export function Discover({ me }: { me: any }) {
  const { data, isLoading } = useGetEventsQuery("?limit=3000");
  const { data: ff } = useFriendsFeedQuery(undefined, { skip: !me });
  const [rsvp] = useRsvpMutation();
  const nav = useNavigate();

  const [date, setDate] = useState<DateKey>("30d");
  const [time, setTime] = useState<TimeKey>("any");
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [communities, setCommunities] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [free, setFree] = useState(false);
  const [sort, setSort] = useState<"soonest" | "interesting">("soonest");
  const [trip, setTrip] = useState<{ from: string; to: string } | null>(null);
  const [tripOpen, setTripOpen] = useState(false);
  const [mine, setMine] = useState<Record<string, string>>({});

  const all = data?.events || [];
  const friendsByEvent = useMemo(() => new Map((ff?.items || []).map((i: any) => [i.event.id, i.friends])), [ff]);

  const base = useMemo(() => baseFilter(all, { date, time, q, free, trip }), [all, date, time, free, q, trip]);
  // category + community facet counts (ignoring their own filter, so counts stay stable)
  const catCounts = useMemo(() => categoryCounts(base), [base]);
  const commCounts = useMemo(() => communityCounts(base), [base]);
  const list = useMemo(() => applyCategoryAndSort(base, cats, sort, communities), [base, cats, sort, communities]);
  const toggleComm = (id: string) => setCommunities((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // lazy render — only ~24 cards up front, more as you scroll (resets when filters change)
  const { shown, sentinelRef } = useInfinite(list.length, 24, list);

  async function doRsvp(id: string, status: string) {
    const r: any = await rsvp({ id, status });
    if (r.error?.status === 403 && r.error.data?.error === "review_required") {
      const p = r.error.data.pending?.[0]; if (p) nav(`/event/${p}/review`); return;
    }
    setMine((m) => ({ ...m, [id]: status }));
  }
  const toggleCat = (c: string) => setCats((s) => { const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n; });

  if (isLoading) return <div data-testid="feed"><PageHeader title="Discover" sub="Loading events…" /><SkeletonList rows={6} /></div>;

  return (
    <div data-testid="feed">
      <PageHeader
        title="Discover"
        sub={`${list.length.toLocaleString()} of ${all.length.toLocaleString()} events`}
        right={<div className="flex gap-1.5"><Link to="/board"><Button variant="ghost">📌 Board</Button></Link><Link to="/map"><Button variant="ghost">🗺 Map</Button></Link></div>}
      />

      {/* filter bar */}
      <div className="mb-4 flex flex-col gap-2">
        <input className={input} placeholder="Search title, org, venue, description…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex flex-wrap gap-1.5">
          {(["today", "weekend", "7d", "30d", "upcoming", "all"] as DateKey[]).map((k) => (
            <Chip key={k} on={!trip && date === k} onClick={() => { setTrip(null); setDate(k); }}>{k === "7d" ? "7 days" : k === "30d" ? "30 days" : k}</Chip>
          ))}
          <Chip on={!!trip} onClick={() => setTripOpen((v) => !v)}>🧳 Trip</Chip>
        </div>
        {tripOpen && (
          <Card className="flex flex-wrap items-end gap-2 p-3">
            <label className="text-xs text-muted">Arrive<input type="date" className={`${input} mt-1`} onChange={(e) => setTrip((t) => ({ from: e.target.value, to: t?.to || e.target.value }))} /></label>
            <label className="text-xs text-muted">Depart<input type="date" className={`${input} mt-1`} onChange={(e) => setTrip((t) => ({ from: t?.from || e.target.value, to: e.target.value }))} /></label>
            <Button variant="quiet" onClick={() => { setTrip(null); setTripOpen(false); }}>Clear</Button>
          </Card>
        )}
        <div className="flex flex-wrap gap-1.5">
          {(["any", "morning", "afternoon", "evening"] as TimeKey[]).map((k) => <Chip key={k} on={time === k} onClick={() => setTime(k)}>{k === "any" ? "Any time" : k}</Chip>)}
          <Chip on={free} onClick={() => setFree(!free)}>Free</Chip>
          <Chip on={sort === "interesting"} onClick={() => setSort(sort === "interesting" ? "soonest" : "interesting")}>Most interesting</Chip>
        </div>
        {catCounts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {catCounts.slice(0, 10).map(([c, n]) => <Chip key={c} on={cats.has(c)} onClick={() => toggleCat(c)}>{c} <span className="font-mono opacity-60">{n}</span></Chip>)}
          </div>
        )}
        {commCounts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="community-filters">
            <span className="text-xs font-semibold text-muted">🏛 Communities</span>
            {commCounts.map(([id, n]) => (
              <Chip key={id} on={communities.has(id)} onClick={() => toggleComm(id)}>{COMMUNITY_LABELS[id]} <span className="font-mono opacity-60">{n}</span></Chip>
            ))}
          </div>
        )}
      </div>

      {trip && <Card className="mb-3 border-accent bg-accent/10 p-2 text-center text-sm">🧳 Your trip: {list.length} events between {trip.from} and {trip.to}</Card>}

      <div className="flex flex-col gap-3">
        {list.slice(0, shown).map((e: any) => {
          const friends = friendsByEvent.get(e.id) as any[] | undefined;
          return (
            <Card key={e.id} className="flex gap-3 overflow-hidden">
              {e.imageUrl && <img src={e.imageUrl} alt="" className="w-28 shrink-0 object-cover" loading="lazy" />}
              <div className="min-w-0 flex-1 p-3">
                <div className="font-mono text-xs text-accent">{fmtDate(e.startUtc, e.timezone)}</div>
                <h3 className="mt-0.5 font-semibold leading-snug"><Link to={`/event/${e.id}`} className="hover:text-accent">{e.title}</Link></h3>
                <div className="truncate text-xs text-muted">{[e.venueName, e.organizer].filter(Boolean).join(" · ")}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">{(e.categories || []).slice(0, 3).map((c: string) => <Badge key={c}>{c}</Badge>)}</div>
                {friends?.length ? (
                  <div className="mt-1.5 flex items-center gap-1">{friends.slice(0, 4).map((f) => <Avatar key={f.id} user={f} size={20} />)}<span className="ml-1 text-xs text-muted">{friends.length} going</span></div>
                ) : null}
                {me && (
                  <div className="mt-2 flex gap-1.5">
                    {["going", "interested", "none"].map((s) => <Chip key={s} on={mine[e.id] === s} onClick={() => doRsvp(e.id, s)}>{s === "none" ? "Not going" : s[0]!.toUpperCase() + s.slice(1)}</Chip>)}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
        {!list.length && <EmptyState title="No events match" hint="Widen the date range or clear a filter." />}
        {shown < list.length && (
          <div ref={sentinelRef} className="py-4 text-center text-xs text-muted">Showing {shown} of {list.length.toLocaleString()} — scroll for more…</div>
        )}
      </div>
    </div>
  );
}
