import { useState } from "react";
import { Link } from "react-router-dom";
import { useGetRankingsQuery, useGetLeaderboardQuery } from "../../api";
import { Avatar, Card, Chip, Spinner, PageHeader, EmptyState, Badge } from "../../ui/kit";

export function Leaderboard({ me }: { me: any }) {
  const [tab, setTab] = useState<"points" | "intros" | "nps" | "friends">("points");
  const ranks = useGetRankingsQuery(tab === "intros" ? "intros" : tab === "nps" ? "nps" : "points", { skip: tab === "friends" });
  const friends = useGetLeaderboardQuery("friends", { skip: tab !== "friends" });
  const rows = (tab === "friends" ? friends.data?.rows : ranks.data?.rows) || [];
  const loading = tab === "friends" ? friends.isLoading : ranks.isLoading;

  return (
    <div data-testid="leaderboard">
      <PageHeader title="Rankings" sub="Points, introductions made, and your friend circle." />
      <div className="mb-4 flex gap-2">
        <Chip on={tab === "points"} onClick={() => setTab("points")}>Points</Chip>
        <Chip on={tab === "intros"} onClick={() => setTab("intros")}>Super-connectors</Chip>
        <Chip on={tab === "nps"} onClick={() => setTab("nps")}>Host NPS</Chip>
        {me && <Chip on={tab === "friends"} onClick={() => setTab("friends")}>Friends</Chip>}
      </div>
      {loading ? <Spinner /> : (
        <ol className="flex flex-col gap-2">
          {rows.map((r: any, i: number) => (
            <Card key={r.id} className="flex items-center gap-3 p-3">
              <span className="w-6 font-mono font-bold text-muted">{i + 1}</span>
              <Avatar user={r} />
              <Link to={`/u/${r.handle}`} className="font-semibold hover:text-accent">{r.displayName}</Link>
              {tab === "intros" && i === 0 && r.intros > 0 && <Badge gold>super-connector</Badge>}
              <div className="flex-1" />
              <span className="font-mono text-sm text-gold">{tab === "intros" ? `${r.intros ?? 0} intros` : tab === "nps" ? (r.nps == null ? "—" : `NPS ${r.nps}`) : `${r.points ?? 0} pts`}</span>
            </Card>
          ))}
          {!rows.length && <EmptyState title="No one ranked yet" hint="RSVP, check in, host, and make intros to climb." />}
        </ol>
      )}
    </div>
  );
}
