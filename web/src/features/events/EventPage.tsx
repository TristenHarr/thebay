import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useGetEventFullQuery, useRsvpMutation, useReviewEventMutation, useGetEventMediaQuery, useGetResearchQuery } from "../../api";
import { Card, Avatar, Chip, Button, Spinner, PageHeader, Badge, EventThumb, input } from "../../ui/kit";
import { fmtDate } from "../feed/Feed";
import { mediaUrl } from "../media/Media";

export function EventPage({ me }: { me: any }) {
  const { id = "" } = useParams();
  const { data, isLoading, refetch } = useGetEventFullQuery(id);
  const { data: mediaData } = useGetEventMediaQuery(id, { skip: !id });
  const [rsvp] = useRsvpMutation();
  const nav = useNavigate();
  if (isLoading || !data) return <Spinner />;
  if (data.error) return <p className="text-muted">Event not found.</p>;
  const e = data.event;

  async function doRsvp(status: string) {
    const r: any = await rsvp({ id, status });
    if (r.error?.status === 403 && r.error.data?.error === "review_required") {
      const p = r.error.data.pending?.[0];
      if (p) nav(`/event/${p}/review`);
      return;
    }
    refetch();
  }

  return (
    <div data-testid="event-page">
      <EventThumb event={e} className="mb-4 h-56 w-full rounded-lg object-cover" glyph={72} />
      <h1 className="text-2xl font-bold tracking-tight" style={{ textWrap: "balance" } as any}>{e.title}</h1>
      <div className="mt-1 font-mono text-sm text-muted">{fmtDate(e.startUtc, e.timezone)}{e.venueName ? ` · ${e.venueName}` : ""}</div>
      {data.host && (
        <div className="mt-2 text-sm">
          Hosted by <Link to={`/u/${data.host.handle}`} className="text-gold">{data.host.displayName}</Link>
        </div>
      )}
      {e.url && (
        <a href={e.url} target="_blank" rel="noopener" className="mt-3 inline-block">
          <Button variant="ghost">Event link ↗</Button>
        </a>
      )}
      {e.description && <p className="mt-3 whitespace-pre-wrap text-muted">{e.description}</p>}

      {me ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {["going", "interested", "none"].map((s) => (
            <Chip key={s} on={data.myRsvp === s} onClick={() => doRsvp(s)}>
              {s === "none" ? "Not going" : s[0]!.toUpperCase() + s.slice(1)}
            </Chip>
          ))}
          {data.host?.id === me.id ? (
            <Link to={`/event/${id}/checkin`}><Button variant="ghost">📲 Open door check-in</Button></Link>
          ) : (
            <Link to={`/event/${id}/checkin`}><Button variant="ghost">✅ Check in</Button></Link>
          )}
          {/* The vibe read is the whole point of showing up informed — link it from
              the one screen people actually open before deciding to go. */}
          <Link to={`/event/${id}/vibe`}><Button variant="ghost">🌡️ Read the room</Button></Link>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link to="/signin"><Button>Sign in to RSVP</Button></Link>
          <Link to={`/event/${id}/vibe`}><Button variant="ghost">🌡️ Read the room</Button></Link>
        </div>
      )}

      <div className="mt-3 flex gap-5 font-mono text-sm text-muted">
        <span>{data.counts?.going || 0} going</span>
        <span>{data.counts?.interested || 0} interested</span>
      </div>

      {data.friends?.length > 0 && (
        <Section title="Your friends going">
          <div className="flex flex-wrap gap-1">{data.friends.map((f: any) => <Link key={f.id} to={`/u/${f.handle}`}><Avatar user={f} size={28} /></Link>)}</div>
        </Section>
      )}
      <Section title={`Attendees (${data.attendees?.length || 0})`}>
        <div className="flex flex-wrap gap-1">{(data.attendees || []).map((a: any) => <Link key={a.id} to={`/u/${a.handle}`}><Avatar user={a} size={28} /></Link>)}</div>
      </Section>
      {me && <ResearchPanel id={id} />}

      {(mediaData?.media?.length ?? 0) > 0 && (
        <Section title={`Photos & videos (${mediaData!.media.length})`}>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {mediaData!.media.map((m: any) => {
              const url = mediaUrl(m);
              return url
                ? <img key={m.id} src={url} alt={m.caption || ""} className="aspect-square w-full rounded-lg object-cover" loading="lazy" />
                : <div key={m.id} className="flex aspect-square w-full items-center justify-center rounded-lg bg-elev text-2xl text-muted">▶</div>;
            })}
          </div>
        </Section>
      )}
      <Section title={`Reviews (${data.reviews?.length || 0})`}>
        {(data.reviews || []).map((r: any, i: number) => (
          <div key={i} className="border-b border-border py-2 text-sm">
            <span className="text-gold">{"★".repeat(r.rating)}</span> <span className="text-muted">{r.author}</span>
            {r.body && <div>{r.body}</div>}
          </div>
        ))}
        {me && data.canReview && <Link to={`/event/${id}/review`}><Button variant="ghost" className="mt-2">Write a review</Button></Link>}
      </Section>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="mt-6">
    <h4 className="mb-2 font-semibold">{title}</h4>
    {children}
  </div>
);

/** On-demand AI deep-research: fit score, who to meet, VIPs, talking points. */
function ResearchPanel({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const { data, isFetching } = useGetResearchQuery(id, { skip: !open });
  const brief = data?.brief;
  return (
    <div className="mt-6">
      {!open ? (
        <Button variant="ghost" onClick={() => setOpen(true)}>🔮 Research this room</Button>
      ) : (
        <Card className="p-4">
          {isFetching || !brief ? <Spinner /> : (
            <div data-testid="research">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold">{brief.headline}</h4>
                <span className="font-mono text-sm text-gold">fit {brief.fitScore}/100</span>
              </div>
              <p className="mt-1 text-sm text-muted">{brief.summary}</p>
              {data?.aiEnhanced && <div className="mt-1"><Badge>AI-enhanced</Badge></div>}

              {brief.whoToMeet?.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Who to meet</div>
                  <div className="flex flex-col gap-1.5">
                    {brief.whoToMeet.map((w: any) => (
                      <div key={w.id} className="flex items-center gap-2 text-sm">
                        <Link to={`/u/${w.handle}`} className="font-semibold hover:text-accent">{w.displayName}</Link>
                        <span className="truncate text-xs text-muted">{w.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {brief.vips?.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {brief.vips.map((v: any, i: number) => <Badge key={i}>⭐ {v.displayName} · {v.note}</Badge>)}
                </div>
              )}
              {brief.talkingPoints?.length > 0 && (
                <ul className="mt-3 list-inside list-disc text-sm text-muted">
                  {brief.talkingPoints.map((t: string, i: number) => <li key={i}>{t}</li>)}
                </ul>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/** The quick review survey — also the destination when the review-gate blocks an RSVP. */
export function ReviewPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [review, { isLoading }] = useReviewEventMutation();
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState("");
  return (
    <div className="mx-auto max-w-md" data-testid="review-page">
      <PageHeader title="Quick review" sub="One tap and you're done — then you can register for more." />
      <Card className="p-5">
        <div className="flex justify-center gap-2 text-3xl">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} onClick={() => setRating(n)} className={n <= rating ? "text-gold" : "text-border"} aria-label={`${n} stars`}>★</button>
          ))}
        </div>
        <textarea className={`${input} mt-4`} rows={3} placeholder="How was it? (optional)" value={body} onChange={(e) => setBody(e.target.value)} />
        <Button
          className="mt-4 w-full"
          disabled={isLoading}
          onClick={async () => {
            await review({ id, rating, body });
            nav("/");
          }}
        >
          Submit review
        </Button>
      </Card>
    </div>
  );
}
