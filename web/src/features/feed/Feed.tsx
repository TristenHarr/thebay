import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useGetEventsQuery, useFriendsFeedQuery, useRsvpMutation } from "../../api";
import { Card, Avatar, Chip, Badge, Spinner, PageHeader, EmptyState } from "../../ui/kit";

export const fmtDate = (iso: string, tz = "America/Los_Angeles") => {
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
  } catch {
    return iso;
  }
};

export function Feed({ me }: { me: any }) {
  const { data, isLoading } = useGetEventsQuery("?limit=100");
  const { data: ff } = useFriendsFeedQuery(undefined, { skip: !me });
  const [rsvp] = useRsvpMutation();
  const nav = useNavigate();
  const [mine, setMine] = useState<Record<string, string>>({});

  const friendsByEvent = useMemo(() => new Map((ff?.items || []).map((i: any) => [i.event.id, i.friends])), [ff]);

  async function doRsvp(id: string, status: string) {
    const r: any = await rsvp({ id, status });
    if (r.error?.status === 403 && r.error.data?.error === "review_required") {
      const pending = r.error.data.pending?.[0];
      if (pending) nav(`/event/${pending}/review`);
      return;
    }
    setMine((m) => ({ ...m, [id]: status }));
  }

  if (isLoading) return <Spinner />;
  const events = data?.events || [];
  return (
    <div data-testid="feed">
      <PageHeader title="Discover" sub={`${(data?.total ?? events.length).toLocaleString()} upcoming Bay Area tech events`} />
      <div className="flex flex-col gap-3">
        {events.map((e: any) => {
          const friends = friendsByEvent.get(e.id) as any[] | undefined;
          return (
            <Card key={e.id} className="flex gap-3 overflow-hidden">
              {e.imageUrl && <img src={e.imageUrl} alt="" className="w-28 shrink-0 object-cover" loading="lazy" />}
              <div className="min-w-0 flex-1 p-3">
                <div className="font-mono text-xs text-accent">{fmtDate(e.startUtc, e.timezone)}</div>
                <h3 className="mt-0.5 font-semibold leading-snug">
                  <Link to={`/event/${e.id}`} className="hover:text-accent">{e.title}</Link>
                </h3>
                <div className="truncate text-xs text-muted">{[e.venueName, e.organizer].filter(Boolean).join(" · ")}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">{(e.categories || []).slice(0, 3).map((c: string) => <Badge key={c}>{c}</Badge>)}</div>
                {friends?.length ? (
                  <div className="mt-1.5 flex items-center gap-1">
                    {friends.slice(0, 4).map((f) => <Avatar key={f.id} user={f} size={20} />)}
                    <span className="ml-1 text-xs text-muted">{friends.length} friend{friends.length > 1 ? "s" : ""} going</span>
                  </div>
                ) : null}
                {me && (
                  <div className="mt-2 flex gap-1.5">
                    {["going", "interested", "none"].map((s) => (
                      <Chip key={s} on={mine[e.id] === s} onClick={() => doRsvp(e.id, s)}>
                        {s === "none" ? "Not going" : s[0]!.toUpperCase() + s.slice(1)}
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
        {!events.length && <EmptyState title="No events found" />}
      </div>
    </div>
  );
}
