import { useState } from "react";
import { Link } from "react-router-dom";
import { useGetAgendaQuery, useSubscribeCalendarMutation } from "../../api";
import { Button, Card, Spinner, PageHeader, EmptyState, Badge } from "../../ui/kit";
import { eventLinks, BAY_TRANSIT } from "./links";

const chip = "rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-text";

const STATUS: Record<string, { label: string; cls: string }> = {
  going: { label: "Going", cls: "bg-ok/15 text-ok" },
  interested: { label: "Interested", cls: "bg-accent/15 text-accent" },
  went: { label: "Attended", cls: "bg-border text-muted" },
};

function fmtTime(iso: string, tz?: string) {
  try { return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso)); } catch { return ""; }
}
function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

export function Itinerary() {
  const { data, isLoading } = useGetAgendaQuery();
  const [subscribe] = useSubscribeCalendarMutation();
  const [calUrl, setCalUrl] = useState<string | null>(null);

  if (isLoading) return <Spinner />;
  const events = data?.events || [];

  // group by calendar day
  const groups = new Map<string, any[]>();
  for (const e of events) {
    const k = fmtDay(e.startUtc);
    (groups.get(k) || groups.set(k, []).get(k)!).push(e);
  }

  return (
    <div data-testid="itinerary">
      <PageHeader title="My itinerary" sub="Everything you're going to, in order — sync it to your calendar." />

      {/* calendar sync */}
      <Card className="mb-3 flex flex-wrap items-center gap-2 p-3">
        <span className="text-sm font-semibold">Calendar sync</span>
        <a href="/api/me/calendar.ics"><Button variant="ghost">⬇︎ Download .ics</Button></a>
        <Button variant="ghost" onClick={async () => { const r: any = await subscribe(); if (r.data?.url) setCalUrl(r.data.url); }}>🔗 Subscribe URL</Button>
        <Link to="/discover" className="ml-auto"><Button variant="quiet">🧳 Plan a trip →</Button></Link>
      </Card>

      {/* Bay Area transit hub — links to everything you need to get around */}
      <Card className="mb-4 flex flex-wrap items-center gap-2 p-3">
        <span className="text-sm font-semibold">🚆 Getting around the Bay</span>
        {BAY_TRANSIT.map((t) => <a key={t.name} href={t.url} target="_blank" rel="noopener" className={chip}>{t.name}</a>)}
      </Card>
      {calUrl && (
        <Card className="mb-4 p-3 text-sm">
          <div className="mb-1 text-muted">Add this URL in Google/Apple/Outlook → “Subscribe to calendar”. It stays in sync automatically.</div>
          <code className="block select-all break-all rounded bg-bg p-2 font-mono text-xs text-accent">{calUrl}</code>
        </Card>
      )}

      {!events.length && <EmptyState title="Nothing scheduled" hint="RSVP ‘going’ to events on Discover and they’ll appear here." />}

      <div className="relative">
        {[...groups.entries()].map(([day, items]) => (
          <div key={day} className="mb-6">
            <h3 className="mb-2 text-sm font-bold">{day}</h3>
            <div className="flex flex-col gap-2 border-l-2 border-border pl-4">
              {items.map((e: any) => {
                const st = STATUS[e.status] || STATUS.going!;
                return (
                  <Card key={e.id} className="p-3">
                    <div className="flex items-center gap-3">
                      <div className="w-16 shrink-0 font-mono text-sm text-accent">{fmtTime(e.startUtc, e.timezone)}</div>
                      <div className="min-w-0 flex-1">
                        <Link to={`/event/${e.id}`} className="font-semibold hover:text-accent">{e.title}</Link>
                        <div className="truncate text-xs text-muted">{[e.venueName, e.city].filter(Boolean).join(" · ")}</div>
                      </div>
                      <span className={`rounded-full px-2 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                      <Link to={`/event/${e.id}/checkin`}><Badge>check in</Badge></Link>
                    </div>
                    {/* link out to everything — directions, transit, rideshare, food, event site */}
                    <div className="mt-2 flex flex-wrap gap-1.5 pl-[76px]">
                      {eventLinks(e).map((l, i) => <a key={i} href={l.url} target="_blank" rel="noopener" className={chip}>{l.label}</a>)}
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
