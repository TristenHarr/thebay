import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useGetCommunityQuery, useJoinCommunityMutation, useGetCommunitiesQuery } from "../../api";
import { Avatar, Card, Chip, Spinner, PageHeader, EmptyState, Badge, Button } from "../../ui/kit";

type Metric = "points" | "intros" | "nps";

export function Community() {
  const { id = "" } = useParams();
  const [metric, setMetric] = useState<Metric>("points");
  const { data, isLoading } = useGetCommunityQuery({ id, metric });
  const mine = useGetCommunitiesQuery();
  const [join, { isLoading: joining }] = useJoinCommunityMutation();

  if (isLoading) return <Spinner />;
  if (!data?.community) return <EmptyState title="Community not found" hint="It may have been removed." />;

  const rows = data.rankings || [];
  const isMember = (mine.data?.communities || []).some((c: any) => c.id === id);

  return (
    <div data-testid="community">
      <PageHeader
        title={data.community.name}
        sub={`${data.members.length} member${data.members.length === 1 ? "" : "s"}${data.community.kind ? ` · ${data.community.kind}` : ""}`}
      />

      <div className="mb-4 flex items-center gap-2">
        <Link to="/communities" className="text-sm text-muted hover:text-accent">← All communities</Link>
        <div className="flex-1" />
        {!isMember && (
          <Button data-testid="join-community" disabled={joining} onClick={() => join(id)}>
            {joining ? "Joining…" : "Join"}
          </Button>
        )}
        {isMember && <Badge>Member</Badge>}
      </div>

      <div className="mb-4 flex gap-2" data-testid="community-metric-tabs">
        <Chip on={metric === "points"} onClick={() => setMetric("points")}>Points</Chip>
        <Chip on={metric === "intros"} onClick={() => setMetric("intros")}>Super-connectors</Chip>
        <Chip on={metric === "nps"} onClick={() => setMetric("nps")}>Host NPS</Chip>
      </div>

      <ol className="flex flex-col gap-2" data-testid="community-rankings">
        {rows.map((r: any, i: number) => (
          <Card key={r.id} className="flex items-center gap-3 p-3">
            <span className="w-6 font-mono font-bold text-muted">{i + 1}</span>
            <Avatar user={r} />
            <Link to={`/u/${r.handle}`} className="font-semibold hover:text-accent">{r.displayName}</Link>
            {metric === "intros" && i === 0 && r.intros > 0 && <Badge gold>super-connector</Badge>}
            <div className="flex-1" />
            <span className="font-mono text-sm text-gold">
              {metric === "intros" ? `${r.intros ?? 0} intros` : metric === "nps" ? (r.nps == null ? "—" : `NPS ${r.nps}`) : `${r.points ?? 0} pts`}
            </span>
          </Card>
        ))}
        {!rows.length && <EmptyState title="No one ranked yet" hint="Members climb by RSVPing, hosting, and making intros." />}
      </ol>
    </div>
  );
}
