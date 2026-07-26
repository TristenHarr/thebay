import { Link } from "react-router-dom";
import { useGetGymsHostedQuery, useGetMyGymAwardsQuery } from "../../api";
import { Card, Spinner, PageHeader, EmptyState, Badge } from "../../ui/kit";

/**
 * "My gyms" — the host's index, and the first screen in the app that answers "what rooms
 * do I run?". There was no query for that anywhere before `SocialRepo.hostedEvents`.
 *
 * Also shows what OTHER hosts have given you, because a gym badge is worth nothing if
 * there is nowhere to see it.
 */

const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "text-muted" },
  armed: { label: "Live", tone: "text-ok" },
  settled: { label: "Closed", tone: "text-muted" },
};

export function Gyms() {
  const { data, isLoading } = useGetGymsHostedQuery();
  const { data: mine } = useGetMyGymAwardsQuery();
  if (isLoading) return <Spinner />;

  const hosted = data?.hosted || [];
  const awards = mine?.awards || [];

  return (
    <div data-testid="gyms">
      <PageHeader
        title="Gyms"
        sub="Your events are gyms. Set the rules, then reward the people who actually showed up."
      />

      {hosted.length === 0 ? (
        <EmptyState title="You're not hosting anything yet" hint="Post an event and it becomes a gym you can run." />
      ) : (
        <div className="mb-6 flex flex-col gap-3">
          {hosted.map(({ event, gym }: any) => {
            const s = gym ? STATUS[gym.status] : null;
            return (
              <Card key={event.id} className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{event.title}</div>
                  <div className="font-mono text-xs text-muted">
                    {new Date(event.startUtc).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {event.venueName ? ` · ${event.venueName}` : ""}
                  </div>
                </div>
                {gym ? (
                  <div className="shrink-0 text-right">
                    <div className={`text-xs font-semibold ${s?.tone}`}>{s?.label}</div>
                    <div className="font-mono text-xs text-muted">
                      {gym.spent}/{gym.budget} XP
                    </div>
                  </div>
                ) : (
                  <Badge>No gym</Badge>
                )}
                <Link className="shrink-0 font-mono text-sm text-accent hover:underline" to={`/event/${event.id}/gym`}>
                  {gym ? "Open →" : "Set up →"}
                </Link>
              </Card>
            );
          })}
        </div>
      )}

      <h3 className="mb-2 text-sm font-semibold">Awarded to you</h3>
      {awards.length === 0 ? (
        <EmptyState title="No gym XP yet" hint="Check in at the door of an event whose host is awarding XP." />
      ) : (
        <div className="flex flex-col gap-2">
          {awards.map((a: any) => (
            <Card key={a.id} className="flex items-center gap-3 p-3 text-sm">
              <span className="font-mono text-gold">+{a.xp}</span>
              <span className="min-w-0 flex-1 truncate">{a.eventTitle}</span>
              {a.bountyKey && <Badge>{a.bountyKey.replace(/_/g, " ")}</Badge>}
              <span className="shrink-0 font-mono text-xs text-muted">{new Date(a.awardedAt).toLocaleDateString()}</span>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
