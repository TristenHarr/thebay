import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSearchEventsQuery, useGetEventsQuery, useFriendsFeedQuery, useRsvpMutation, useRankFeedbackMutation } from "../../api";
import { Card, Avatar, Chip, Badge, SkeletonList, PageHeader, EmptyState, Button, EventThumb, input } from "../../ui/kit";
import { fmtDate } from "../feed/Feed";
import {
  baseFilter,
  applyCategoryAndSort,
  communityCounts,
  serverRange,
  timeOfDay,
  COMMUNITY_LABELS,
  type DateKey,
  type TimeKey,
} from "./filter";

/**
 * Discover — server-side search.
 *
 * This screen used to fetch `?limit=3000`, throw away the facet counts the API had
 * already computed, and re-filter the whole catalog in the browser on every
 * keystroke. That is megabytes of JSON on a phone, a filter pass that gets slower
 * as the product succeeds, and a hard ceiling: the browser can only filter what it
 * downloaded, so event 3,001 was unfindable.
 *
 * Now each (debounced) keystroke is a `POST /api/search`: FTS5 + an optional vector
 * leg, RRF-fused, with facet counts computed in SQL over the WHOLE match rather
 * than over the page. Tag chips render from the live `tag_vocab` facets in the
 * response, so a tag added as a row in D1 appears here with no deploy.
 *
 * `filter.ts` is unchanged and still fully tested — it is now the OFFLINE path. If
 * the search request fails, we filter whatever `/api/events` is already in the RTK
 * Query cache and the screen keeps working.
 */

const PAGE = 24;
/** Ceiling on one session's scroll. Past this, narrowing beats paging. */
const MAX_LOADED = 240;
/** Facet display order — topic is how people think, perks are a tiebreak. */
const FACET_ORDER = ["topic", "format", "audience", "cost", "perk", "stage"];
const FACET_LABEL: Record<string, string> = {
  topic: "Topic",
  format: "Format",
  audience: "For",
  cost: "Cost",
  perk: "Perks",
  stage: "Stage",
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Discover({ me }: { me: any }) {
  const [date, setDate] = useState<DateKey>("30d");
  const [time, setTime] = useState<TimeKey>("any");
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [communities, setCommunities] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [free, setFree] = useState(false);
  const [sort, setSort] = useState<"relevance" | "soonest" | "interesting">("relevance");
  const [trip, setTrip] = useState<{ from: string; to: string } | null>(null);
  const [tripOpen, setTripOpen] = useState(false);
  const [mine, setMine] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState(PAGE);

  // Typing must not fire a request per keystroke. 250ms is under the threshold
  // where a search box starts to feel laggy and over a fast typist's key gap.
  const dq = useDebounced(q, 250);

  const filters = useMemo(
    () => ({
      free: free || undefined,
      tags: tags.size ? [...tags] : undefined,
      sources: communities.size ? [...communities] : undefined,
      ...serverRange(date, trip),
    }),
    [free, tags, communities, date, trip],
  );
  // Everything except `limit`: growing the page must not reset the page.
  const filterKey = useMemo(() => JSON.stringify([dq, filters, sort]), [dq, filters, sort]);
  useEffect(() => setLimit(PAGE), [filterKey]);

  const { data, isLoading, isFetching, isError } = useSearchEventsQuery({ q: dq || undefined, filters, sort, limit });
  // The offline path — only fetched if search actually failed.
  const { data: cached } = useGetEventsQuery("?limit=1000", { skip: !isError });
  const { data: ff } = useFriendsFeedQuery(undefined, { skip: !me });
  const [rsvp] = useRsvpMutation();
  const [feedback] = useRankFeedbackMutation();
  const nav = useNavigate();

  /** Opening an event is a positive the server cannot observe for itself: an RSVP is a
   *  row in `rsvps`, a click is not. Fire-and-forget — a dropped signal costs one
   *  training row, and must never cost a navigation. */
  const noteOpen = (id: string) => { if (me) void feedback({ surface: "events", itemId: id, kind: "open" }); };

  const friendsByEvent = useMemo(() => new Map((ff?.items || []).map((i: any) => [i.event.id, i.friends])), [ff]);
  const serverEvents: any[] = data?.events ?? [];

  const offline = useMemo(() => {
    if (!isError) return null;
    const base = baseFilter(cached?.events || [], { date, time, q: dq, free, trip });
    // Cached events carry the LEGACY category slugs, so map tag ids down to them.
    const slugs = new Set([...tags].map((t) => t.split(":").pop()!));
    return applyCategoryAndSort(base, slugs, sort === "interesting" ? "interesting" : "soonest", communities);
  }, [isError, cached, date, time, dq, free, trip, tags, sort, communities]);

  // Time-of-day stays a client-side lens: it depends on each event's own IANA
  // timezone, which is a per-row Intl computation, not work for SQL.
  const list: any[] = useMemo(
    () => (offline ?? serverEvents).filter((e: any) => time === "any" || timeOfDay(e.startUtc, e.timezone) === time),
    [offline, serverEvents, time],
  );
  const total = offline ? offline.length : data?.total ?? 0;

  // Facets come from the server, over the whole match — not over the loaded page.
  const tagFacets = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const t of data?.facets.tags ?? []) {
      const g = groups.get(t.facet) ?? [];
      g.push(t);
      groups.set(t.facet, g);
    }
    return FACET_ORDER.filter((f) => groups.has(f)).map((f) => [f, groups.get(f)!.slice(0, 8)] as const);
  }, [data]);

  const commCounts = useMemo<[string, number][]>(() => {
    if (offline) return communityCounts(cached?.events || []);
    return (data?.facets.sources ?? [])
      .filter((s) => COMMUNITY_LABELS[s.value])
      .map((s) => [s.value, s.count] as [string, number]);
  }, [data, offline, cached]);

  // Infinite scroll = ask the server for a bigger page, not filter a bigger blob.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const canLoadMore = !offline && serverEvents.length < total && limit < MAX_LOADED;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !canLoadMore) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) setLimit((l) => Math.min(l + PAGE, MAX_LOADED)); },
      { rootMargin: "800px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canLoadMore, serverEvents.length]);

  async function doRsvp(id: string, status: string) {
    const r: any = await rsvp({ id, status });
    if (r.error?.status === 403 && r.error.data?.error === "review_required") {
      const p = r.error.data.pending?.[0]; if (p) nav(`/event/${p}/review`); return;
    }
    setMine((m) => ({ ...m, [id]: status }));
  }
  const toggler = (set: typeof setTags) => (id: string) =>
    set((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleTag = toggler(setTags);
  const toggleComm = toggler(setCommunities);

  if (isLoading && !data) {
    return <div data-testid="feed"><PageHeader title="Discover" sub="Loading events…" /><SkeletonList rows={6} /></div>;
  }

  const u = data?.query;
  const showUnderstood = !!u?.raw && !!(u.filters?.tags?.length || u.filters?.window || u.filters?.near || u.filters?.free);

  return (
    <div data-testid="feed">
      <PageHeader
        title="Discover"
        sub={`${list.length.toLocaleString()} of ${total.toLocaleString()} events${isFetching ? " · searching…" : ""}`}
        right={<div className="flex gap-1.5"><Link to="/board"><Button variant="ghost">📌 Board</Button></Link><Link to="/map"><Button variant="ghost">🗺 Map</Button></Link></div>}
      />

      {/* filter bar */}
      <div className="mb-4 flex flex-col gap-2">
        <input
          className={input}
          placeholder="Try: free hardware meetups in SoMa next week…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {/* What the server understood. Search that explains itself is search you can
            correct, rather than search you fight. */}
        {showUnderstood && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted" data-testid="query-understood">
            <span>Understood:</span>
            {u!.filters.free && <Badge>free</Badge>}
            {u!.filters.window && <Badge>{u!.filters.window}</Badge>}
            {u!.filters.near && <Badge>near {u!.filters.near}</Badge>}
            {(u!.filters.tags || []).map((t: string) => <Badge key={t}>{t.split(":").pop()}</Badge>)}
            {u!.relaxed && <span className="opacity-70">· nothing carried those tags, so we searched the words</span>}
          </div>
        )}
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
          <Chip on={sort === "interesting"} onClick={() => setSort(sort === "interesting" ? "relevance" : "interesting")}>Most interesting</Chip>
          <Chip on={sort === "soonest"} onClick={() => setSort(sort === "soonest" ? "relevance" : "soonest")}>Soonest</Chip>
        </div>
        {/* Facet chips render from tag_vocab — a new tag needs no deploy. */}
        {tagFacets.map(([facet, items]) => (
          <div key={facet} className="flex flex-wrap items-center gap-1.5" data-testid={`facet-${facet}`}>
            <span className="text-xs font-semibold text-muted">{FACET_LABEL[facet] ?? facet}</span>
            {items.map((t: any) => (
              <Chip key={t.value} on={tags.has(t.value)} onClick={() => toggleTag(t.value)}>
                {t.emoji ? `${t.emoji} ` : ""}{t.label} <span className="font-mono opacity-60">{t.count}</span>
              </Chip>
            ))}
          </div>
        ))}
        {commCounts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="community-filters">
            <span className="text-xs font-semibold text-muted">🏛 Communities</span>
            {commCounts.map(([id, n]) => (
              <Chip key={id} on={communities.has(id)} onClick={() => toggleComm(id)}>{COMMUNITY_LABELS[id]} <span className="font-mono opacity-60">{n}</span></Chip>
            ))}
          </div>
        )}
      </div>

      {isError && <Card className="mb-3 p-2 text-center text-sm">Search is unavailable — showing cached events filtered on this device.</Card>}
      {trip && <Card className="mb-3 border-accent bg-accent/10 p-2 text-center text-sm">🧳 Your trip: {list.length} events between {trip.from} and {trip.to}</Card>}

      <div className="flex flex-col gap-3">
        {list.map((e: any) => {
          const friends = friendsByEvent.get(e.id) as any[] | undefined;
          return (
            <Card key={e.id} className="flex gap-3 overflow-hidden">
              <EventThumb event={e} className="w-28 shrink-0 object-cover" glyph={34} />
              <div className="min-w-0 flex-1 p-3">
                <div className="font-mono text-xs text-accent">{fmtDate(e.startUtc, e.timezone)}</div>
                <h3 className="mt-0.5 font-semibold leading-snug"><Link to={`/event/${e.id}`} className="hover:text-accent" onClick={() => noteOpen(e.id)}>{e.title}</Link></h3>
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
        {!list.length && !isFetching && <EmptyState title="No events match" hint="Widen the date range or clear a filter." />}
        {canLoadMore && (
          <div ref={sentinelRef} className="py-4 text-center text-xs text-muted">
            Showing {list.length} of {total.toLocaleString()} — scroll for more…
          </div>
        )}
        {!offline && limit >= MAX_LOADED && serverEvents.length < total && (
          <div className="py-4 text-center text-xs text-muted">Showing the first {MAX_LOADED} — narrow the search to see the rest.</div>
        )}
      </div>
      {list.length ? <RankingNote ranking={data?.ranking} /> : null}
    </div>
  );
}

/**
 * Say out loud how this page was ordered.
 *
 * A recommendation feed has no visible "wrong", so the only way anyone can tell that
 * personalization is on — or notice the week it silently stops working — is if the page
 * says so. `null` means this was an explicit search or sort, which is answered verbatim
 * and deliberately not ranked, so there is nothing to explain.
 */
function RankingNote({ ranking }: { ranking?: { model: number | null; rescored: boolean; explored: boolean } | null }) {
  if (!ranking) return null;
  return (
    <p className="mt-4 font-mono text-[11px] text-muted" data-testid="ranking-note">
      {ranking.rescored
        ? `Ranked for you by model v${ranking.model}`
        : "Ordered by relevance — personal ranking starts once there's enough signal"}
      {ranking.explored ? " · shuffled a little so it keeps learning" : ""}
    </p>
  );
}
