import { useState } from "react";
import { useGetIntrosQuery, useCreateIntroMutation, useForwardIntroMutation, useAcceptIntroMutation } from "../../api";
import { Avatar, Button, Card, Badge, Spinner, PageHeader, EmptyState, input } from "../../ui/kit";

export function Intros() {
  const { data, isLoading } = useGetIntrosQuery();
  const [create] = useCreateIntroMutation();
  const [forward] = useForwardIntroMutation();
  const [accept] = useAcceptIntroMutation();
  const [desc, setDesc] = useState("");
  if (isLoading) return <Spinner />;
  const mine = data?.mine || [];
  const inbox = data?.inbox || [];
  const incoming = data?.incoming || [];

  return (
    <div data-testid="intros">
      <PageHeader title="Intros" sub="Ask your network for a warm introduction — or make one." />
      <Card className="p-4">
        <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!desc.trim()) return; await create({ targetDesc: desc }); setDesc(""); }}>
          <input className={input} placeholder="Who do you want to meet? e.g. someone at Sequoia" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <Button>Ask</Button>
        </form>
      </Card>

      {incoming.length > 0 && (
        <div className="mt-5">
          <h4 className="mb-2 font-semibold">Introductions waiting for you</h4>
          {incoming.map((it: any) => (
            <Card key={it.forwardId} className="mb-2 flex items-center gap-3 border-accent/40 bg-accent/5 p-3">
              {it.requester && <Avatar user={it.requester} size={28} />}
              <div className="min-w-0 flex-1">
                <b>{it.requester?.displayName}</b> would like to meet you
                {it.connector && <span className="text-muted"> — via {it.connector.displayName}</span>}
              </div>
              <Button onClick={() => accept(it.forwardId)}>Accept</Button>
            </Card>
          ))}
        </div>
      )}

      {inbox.length > 0 && (
        <div className="mt-5">
          <h4 className="mb-2 font-semibold">You can help forward</h4>
          {inbox.map((it: any) => (
            <Card key={it.request.id} className="mb-2 flex items-center gap-3 p-3">
              {it.requester && <Avatar user={it.requester} size={28} />}
              <div className="min-w-0 flex-1">
                <b>{it.requester?.displayName}</b> wants an intro to <span className="text-muted">{it.request.target_desc}</span>
              </div>
              <Button variant="ghost" onClick={() => forward(it.request.id)}>Forward</Button>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-5">
        <h4 className="mb-2 font-semibold">Your requests</h4>
        {mine.map((r: any) => (
          <Card key={r.id} className="mb-2 flex items-center gap-3 p-3">
            <span className="flex-1">{r.targetDesc}</span>
            <Badge gold={r.status === "matched"}>{r.status}</Badge>
          </Card>
        ))}
        {!mine.length && <EmptyState title="No intro requests yet" hint="Ask above — the platform routes it through friends-of-friends." />}
      </div>
    </div>
  );
}
