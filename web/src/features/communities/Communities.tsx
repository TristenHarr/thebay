import { useState } from "react";
import { Link } from "react-router-dom";
import { useGetCommunitiesQuery, useCreateCommunityMutation } from "../../api";
import { Button, Card, Spinner, PageHeader, EmptyState, input } from "../../ui/kit";

export function Communities() {
  const { data, isLoading } = useGetCommunitiesQuery();
  const [create] = useCreateCommunityMutation();
  const [name, setName] = useState("");
  if (isLoading) return <Spinner />;
  const communities = data?.communities || [];
  return (
    <div data-testid="communities">
      <PageHeader title="Communities" sub="Shared spaces with their own rankings & super-connectors." />
      <form className="mb-4 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; await create({ name }); setName(""); }}>
        <input className={input} placeholder="New community name…" value={name} onChange={(e) => setName(e.target.value)} />
        <Button>Create</Button>
      </form>
      {communities.map((c: any) => (
        <Link key={c.id} to={`/community/${c.id}`}>
          <Card className="mb-2 flex items-center gap-3 p-3 hover:border-accent">
            <b>{c.name}</b>
            {c.kind && <span className="font-mono text-xs text-muted">{c.kind}</span>}
          </Card>
        </Link>
      ))}
      {!communities.length && <EmptyState title="No communities yet" hint="Start one for your founder circle or event series." />}
    </div>
  );
}
