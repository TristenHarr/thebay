import { useState } from "react";
import { Link } from "react-router-dom";
import { useGetFriendsQuery, useGetProfileQuery, useRequestFriendMutation, useRespondFriendMutation } from "../../api";
import { Avatar, Button, Card, Spinner, PageHeader, EmptyState, input } from "../../ui/kit";

export function Friends() {
  const { data, isLoading, refetch } = useGetFriendsQuery();
  const [req] = useRequestFriendMutation();
  const [respond] = useRespondFriendMutation();
  const [handle, setHandle] = useState("");
  const [search, setSearch] = useState<string | undefined>();
  const found = useGetProfileQuery(search!, { skip: !search });

  if (isLoading) return <Spinner />;
  const friends = data?.friends || [];
  const pending = data?.pending || [];

  return (
    <div data-testid="friends">
      <PageHeader title="Friends" />
      <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(handle.replace(/^@/, "")); }}>
        <input className={input} placeholder="find by @handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
        <Button>Find</Button>
      </form>
      {found.data?.profile && (
        <Card className="mb-4 flex items-center gap-3 p-3">
          <Avatar user={found.data.profile} /> <b>{found.data.profile.displayName}</b> <span className="text-muted">@{found.data.profile.handle}</span>
          <div className="flex-1" />
          <Button onClick={async () => { await req(found.data.profile.id); setSearch(undefined); setHandle(""); }}>Add</Button>
        </Card>
      )}

      {pending.length > 0 && (
        <div className="mb-4">
          <h4 className="mb-2 font-semibold">Requests</h4>
          {pending.map((pp: any) => (
            <Card key={pp.id} className="mb-2 flex items-center gap-3 p-3">
              <Avatar user={pp} /> <b>{pp.displayName}</b>
              <div className="flex-1" />
              <Button onClick={async () => { await respond({ uid: pp.id, accept: true }); refetch(); }}>Accept</Button>
              <Button variant="quiet" onClick={async () => { await respond({ uid: pp.id, accept: false }); refetch(); }}>Decline</Button>
            </Card>
          ))}
        </div>
      )}

      <h4 className="mb-2 font-semibold">Your friends ({friends.length})</h4>
      {friends.map((f: any) => (
        <Link key={f.id} to={`/u/${f.handle}`}>
          <Card className="mb-2 flex items-center gap-3 p-3 hover:border-accent">
            <Avatar user={f} /> <b>{f.displayName}</b> <span className="font-mono text-xs text-muted">@{f.handle}</span>
          </Card>
        </Link>
      ))}
      {!friends.length && <EmptyState title="No friends yet" hint="Find people by @handle, or connect at events." />}
    </div>
  );
}
