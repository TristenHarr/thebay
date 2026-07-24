import { useGetAchievementsQuery, useGetMeQuery } from "../../api";
import { Card, Spinner, PageHeader, EmptyState, Badge } from "../../ui/kit";

// Display catalog. Any kind not listed still renders gracefully (title-cased).
const POINT_LABELS: Record<string, { icon: string; label: string }> = {
  rsvp: { icon: "✋", label: "RSVPs" },
  checkin: { icon: "📍", label: "Check-ins" },
  photo: { icon: "📸", label: "Photos & videos" },
  review: { icon: "⭐", label: "Reviews" },
  host: { icon: "🎤", label: "Events hosted" },
  intro: { icon: "🤝", label: "Warm intros" },
  mentor: { icon: "🧭", label: "Mentoring" },
};
const ACHIEVEMENTS: Record<string, { icon: string; title: string; desc: string }> = {
  first_review: { icon: "⭐", title: "Critic", desc: "Wrote your first event review." },
  first_checkin: { icon: "📍", title: "Showed up", desc: "Checked in to your first event." },
  first_host: { icon: "🎤", title: "Host", desc: "Hosted your first event." },
  super_connector: { icon: "🌟", title: "Super-connector", desc: "Made warm intros across the community." },
};
const title = (k: string) => k.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
const STREAK_LABEL: Record<string, string> = { attend: "Attendance streak", review: "Review streak" };

function Flame({ n }: { n: number }) {
  return <span className="font-mono text-gold">{"🔥".repeat(Math.min(5, Math.max(1, n)))}<span className="ml-1 text-text">{n}</span></span>;
}

export function Achievements() {
  const { data, isLoading } = useGetAchievementsQuery();
  const { data: me } = useGetMeQuery();
  if (isLoading) return <Spinner />;

  const achievements = data?.achievements || [];
  const streaks = (data?.streaks || []).filter((s: any) => s.count > 0 || s.best > 0);
  const points = data?.points || [];
  const total = points.reduce((s: number, p: any) => s + (p.points || 0), 0);
  const max = Math.max(1, ...points.map((p: any) => p.points));
  const handle = me?.user?.handle;

  return (
    <div data-testid="achievements">
      <PageHeader title="Achievements" sub="Your track record on The Bay — points, streaks, and trophies." />

      {/* points summary */}
      <Card className="mb-4 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted">Total points</span>
          <span className="font-mono text-2xl font-bold text-gold">✦ {total.toLocaleString()}</span>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {points.length === 0 && <p className="text-sm text-muted">Attend events, check in, and review to start earning.</p>}
          {points.map((p: any) => {
            const meta = POINT_LABELS[p.kind] || { icon: "•", label: title(p.kind) };
            return (
              <div key={p.kind} className="flex items-center gap-3">
                <span className="w-40 shrink-0 text-sm">{meta.icon} {meta.label} <span className="font-mono text-xs text-muted">×{p.count}</span></span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-border">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${(p.points / max) * 100}%` }} />
                </div>
                <span className="w-12 shrink-0 text-right font-mono text-xs text-gold">{p.points}</span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* streaks */}
      {streaks.length > 0 && (
        <Card className="mb-4 p-4">
          <h3 className="mb-2 text-sm font-semibold">Streaks</h3>
          <div className="flex flex-col gap-2">
            {streaks.map((s: any) => (
              <div key={s.kind} className="flex items-center justify-between text-sm">
                <span>{STREAK_LABEL[s.kind] || title(s.kind)}</span>
                <span className="flex items-center gap-3"><Flame n={s.count} /><span className="font-mono text-xs text-muted">best {s.best}</span></span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* trophy case */}
      <h3 className="mb-2 text-sm font-semibold">Trophy case</h3>
      {achievements.length === 0 ? (
        <EmptyState title="No trophies yet" hint="Review an event, check in, or host to unlock your first." />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {achievements.map((a: any, i: number) => {
            const meta = ACHIEVEMENTS[a.kind] || { icon: "🏅", title: title(a.kind), desc: "Achievement unlocked." };
            return (
              <Card key={i} className="flex flex-col items-center gap-1 p-4 text-center">
                <span className="text-3xl">{meta.icon}</span>
                <span className="font-semibold">{meta.title}</span>
                <span className="text-xs text-muted">{meta.desc}</span>
                <span className="mt-1 font-mono text-[10px] text-muted">{new Date(a.awardedAt).toLocaleDateString()}</span>
              </Card>
            );
          })}
        </div>
      )}

      {handle && (
        <Card className="mt-4 flex items-center justify-between p-3 text-sm">
          <span className="text-muted">Share your achievements</span>
          <a className="font-mono text-accent hover:underline" href={`/app/u/${handle}`}>the.bay/u/{handle} →</a>
        </Card>
      )}
      {handle && <div className="mt-2"><Badge>Public profile shows goals & trophies when social sharing is on</Badge></div>}
    </div>
  );
}
