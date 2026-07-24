import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useGetGroupsQuery, useCreateGroupMutation, useGetGroupQuery, useSendMessageMutation } from "../../api";
import { Avatar, Button, Card, Spinner, PageHeader, EmptyState, input, cx } from "../../ui/kit";

export function Groups() {
  const { data, isLoading } = useGetGroupsQuery();
  const [create] = useCreateGroupMutation();
  const [name, setName] = useState("");
  const nav = useNavigate();
  if (isLoading) return <Spinner />;
  const groups = data?.groups || [];
  return (
    <div data-testid="groups">
      <PageHeader title="Groups" sub="Themed spaces to coordinate — real-time chat." />
      <form className="mb-4 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; const r: any = await create({ name }); if (r.data?.id) nav(`/group/${r.data.id}`); }}>
        <input className={input} placeholder="New group name…" value={name} onChange={(e) => setName(e.target.value)} />
        <Button>Create</Button>
      </form>
      {groups.map((g: any) => (
        <Link key={g.id} to={`/group/${g.id}`}>
          <Card className="mb-2 flex items-center gap-3 p-3 hover:border-accent">
            <b>{g.name}</b> <span className="font-mono text-xs text-muted">{g.members} member{g.members > 1 ? "s" : ""}</span>
          </Card>
        </Link>
      ))}
      {!groups.length && <EmptyState title="No groups yet" hint="Create one, or spin one up from an event page." />}
    </div>
  );
}

export function GroupChat({ me }: { me: any }) {
  const { id = "" } = useParams();
  const { data } = useGetGroupQuery(id);
  const [send] = useSendMessageMutation();
  const [msgs, setMsgs] = useState<any[]>([]);
  const [text, setText] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const scroll = () => setTimeout(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; }, 30);

  useEffect(() => { if (data?.messages) { setMsgs(data.messages); scroll(); } }, [data]);
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/groups/${id}/ws`);
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); setMsgs((p) => [...p, m]); scroll(); } catch { /* ignore */ } };
    return () => ws.close();
  }, [id]);

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col" data-testid="group-chat">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <Link to="/groups" className="text-sm text-muted hover:text-text">← Groups</Link>
        <div className="flex -space-x-1">{(data?.members || []).map((m: any) => <Avatar key={m.id} user={m} size={24} />)}</div>
      </div>
      <div ref={boxRef} className="flex flex-1 flex-col gap-2 overflow-y-auto py-3">
        {msgs.map((m, i) => (
          <div key={m.id || i} className={cx("max-w-[78%] rounded-2xl px-3 py-2 text-sm", m.userId === me?.id ? "self-end bg-accent text-accent-ink" : "self-start bg-surface")}>
            <span className="block text-[11px] font-bold opacity-70">{m.author}</span>
            {m.body}
          </div>
        ))}
        {!msgs.length && <p className="text-center text-sm text-muted">No messages yet — say hi 👋</p>}
      </div>
      <form className="flex gap-2 pt-2" onSubmit={async (e) => { e.preventDefault(); const body = text.trim(); if (!body) return; setText(""); await send({ id, body }); }}>
        <input className={input} placeholder="Message…" value={text} onChange={(e) => setText(e.target.value)} />
        <Button>Send</Button>
      </form>
    </div>
  );
}
