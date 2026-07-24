import { useState } from "react";
import { useGetMentorsQuery, useSetMentorProfileMutation, useRequestMentorMutation, useMentorInboxQuery, useRespondMentorMutation } from "../../api";
import { Avatar, Button, Card, Badge, Spinner, PageHeader, EmptyState, input } from "../../ui/kit";

export function Mentors() {
  const [topic, setTopic] = useState("");
  const { data, isLoading } = useGetMentorsQuery(topic || undefined);
  const inbox = useMentorInboxQuery();
  const [request] = useRequestMentorMutation();
  const [respond] = useRespondMentorMutation();
  const [setProfile] = useSetMentorProfileMutation();
  const [topics, setTopics] = useState("");

  return (
    <div data-testid="mentors">
      <PageHeader title="Mentors" sub="Find a mentor, offer to mentor, or co-mentor a peer." />

      <Card className="mb-4 p-4">
        <div className="mb-2 text-sm font-semibold">Offer to mentor / co-mentor</div>
        <div className="flex gap-2">
          <input className={input} placeholder="topics, comma-separated (fundraising, gtm…)" value={topics} onChange={(e) => setTopics(e.target.value)} />
          <Button onClick={() => setProfile({ topics: topics.split(",").map((t) => t.trim()).filter(Boolean), active: true })}>Publish</Button>
        </div>
      </Card>

      {(inbox.data?.requests?.length ?? 0) > 0 && (
        <div className="mb-4">
          <h4 className="mb-2 font-semibold">Mentorship requests</h4>
          {inbox.data!.requests.map((r: any) => (
            <Card key={r.id} className="mb-2 flex items-center gap-3 p-3">
              {r.mentee && <Avatar user={r.mentee} size={28} />}
              <div className="min-w-0 flex-1"><b>{r.mentee?.displayName}</b> {r.message && <span className="text-muted">— {r.message}</span>}</div>
              <Button variant="ghost" onClick={() => { respond({ id: r.id, accept: true }); inbox.refetch(); }}>Accept</Button>
              <Button variant="quiet" onClick={() => { respond({ id: r.id, accept: false }); inbox.refetch(); }}>Decline</Button>
            </Card>
          ))}
        </div>
      )}

      <form className="mb-3 flex gap-2" onSubmit={(e) => e.preventDefault()}>
        <input className={input} placeholder="filter by topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
      </form>
      {isLoading ? <Spinner /> : (
        <>
          {(data?.mentors || []).map((m: any) => (
            <Card key={m.id} className="mb-2 flex items-center gap-3 p-3">
              <Avatar user={m} />
              <div className="min-w-0 flex-1">
                <b>{m.displayName}</b>
                <div className="mt-0.5 flex flex-wrap gap-1">{(m.topics || []).map((t: string) => <Badge key={t}>{t}</Badge>)}</div>
              </div>
              <Button variant="ghost" onClick={() => request({ mentorId: m.id })}>Request</Button>
            </Card>
          ))}
          {!(data?.mentors?.length) && <EmptyState title="No mentors yet" hint="Be the first — publish your mentor profile above." />}
        </>
      )}
    </div>
  );
}
