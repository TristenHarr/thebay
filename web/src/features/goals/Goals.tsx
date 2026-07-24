import { useState } from "react";
import { Link } from "react-router-dom";
import { useGetGoalsQuery, useCreateGoalMutation, useUpdateGoalMutation } from "../../api";
import { Card, Button, Chip, Badge, Spinner, PageHeader, EmptyState, input } from "../../ui/kit";

export function Goals() {
  const { data, isLoading } = useGetGoalsQuery();
  const [create] = useCreateGoalMutation();
  const [update] = useUpdateGoalMutation();
  const [title, setTitle] = useState("");
  const [vis, setVis] = useState("private");
  if (isLoading) return <Spinner />;
  const goals = data?.goals || [];

  return (
    <div data-testid="goals">
      <div className="mb-4 flex items-center justify-between">
        <PageHeader title="Goals" sub="Attend with intent — set overall goals, then a goal per event." />
        <Link to="/achievements"><Button variant="ghost" className="text-gold">🏆 Achievements</Button></Link>
      </div>
      <Card className="p-4">
        <form
          className="flex flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            await create({ kind: "overall", title, visibility: vis });
            setTitle("");
          }}
        >
          <input className={input} placeholder="e.g. Raise a seed round · Find a technical co-founder" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="flex items-center gap-2">
            {["private", "friends", "public"].map((v) => <Chip key={v} on={vis === v} onClick={() => setVis(v)}>{v}</Chip>)}
            <div className="flex-1" />
            <Button type="submit">Add goal</Button>
          </div>
        </form>
      </Card>

      <div className="mt-4 flex flex-col gap-2">
        {goals.map((g: any) => (
          <Card key={g.id} className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <div className={g.status === "done" ? "text-muted line-through" : ""}>{g.title}</div>
              <div className="mt-1 flex gap-1.5"><Badge>{g.kind}</Badge> <Badge>{g.visibility}</Badge></div>
            </div>
            {g.status !== "done" && <Button variant="ghost" onClick={() => update({ id: g.id, patch: { status: "done", progress: 100 } })}>Mark done</Button>}
          </Card>
        ))}
        {!goals.length && <EmptyState title="No goals yet" hint="What do you want to get out of the rooms you show up in?" />}
      </div>
    </div>
  );
}
