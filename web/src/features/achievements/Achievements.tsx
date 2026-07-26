import { useGetAchievementsQuery, useGetMeQuery, useGetTrophiesQuery } from "../../api";
import { Card, Spinner, PageHeader, EmptyState, Badge, cx } from "../../ui/kit";

/**
 * The trophy case.
 *
 * Every trophy on this screen — name, flavor, icon, threshold, rarity — arrives from
 * `GET /api/trophies`, which serves `src/core/trophies/catalog.ts`. This file used to
 * carry its own hard-coded table of seven trophies, and the drift was exactly what you
 * would expect: three entries the server never granted, two grants the table didn't
 * know about (rendered as a generic 🏅), no way to draw a LOCKED trophy at all, and an
 * internal `shadow_area` counter that had to be filtered out by hand.
 *
 * Points and streaks still come from `/api/me/achievements` — they are a different
 * currency (the credible founder score) and deliberately stay separate from XP.
 */

/** Display labels for the points ledger. An unlisted kind still renders, title-cased. */
const POINT_LABELS: Record<string, { icon: string; label: string }> = {
  rsvp: { icon: "✋", label: "RSVPs" },
  checkin: { icon: "📍", label: "Check-ins" },
  photo: { icon: "📸", label: "Photos & videos" },
  review: { icon: "⭐", label: "Reviews" },
  host: { icon: "🎤", label: "Events hosted" },
  intro: { icon: "🤝", label: "Warm intros" },
  mentor: { icon: "🧭", label: "Mentoring" },
  shadow: { icon: "🌉", label: "Shadows cast" },
  connection: { icon: "🤝", label: "Connections made" },
  reaction: { icon: "🔥", label: "Reactions earned" },
  vibe_report: { icon: "🌡️", label: "Vibe reports" },
  place: { icon: "🗺️", label: "Places pinned" },
  place_confirm: { icon: "✅", label: "Places confirmed" },
  submit: { icon: "📰", label: "Stories submitted" },
  comment: { icon: "💬", label: "Comments" },
};
const STREAK_LABEL: Record<string, string> = { attend: "Attendance streak", review: "Review streak", shadow: "Daily shadow streak" };
const title = (k: string) => k.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

type Trophy = {
  id: string;
  series: string;
  tier: number;
  name: string | null;
  flavor: string | null;
  icon: string | null;
  threshold: number | null;
  xp: number;
  earned: boolean;
  awardedAt: string | null;
  value: number;
  pct: number;
  remaining: number;
  rarity: number;
  hidden: boolean;
};

/** How rare a trophy is, in words. Below 0.1% we stop quoting a figure nobody can
 *  picture and just say it's rare. */
function rarityLabel(r: number): string {
  if (r <= 0) return "Unclaimed";
  const pct = r * 100;
  if (pct < 0.1) return "<0.1% have this";
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}% have this`;
}

function Flame({ n }: { n: number }) {
  return (
    <span className="font-mono text-gold">
      {"🔥".repeat(Math.min(5, Math.max(1, n)))}
      <span className="ml-1 text-text">{n}</span>
    </span>
  );
}

function Meter({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%` }} />
    </div>
  );
}

function TrophyCard({ t }: { t: Trophy }) {
  // A hidden secret ships no name, flavor, icon or threshold from the server, so
  // there is nothing here to leak even to someone reading the network tab.
  if (t.hidden) {
    return (
      <Card className="flex flex-col items-center gap-1 p-3 text-center opacity-50" data-testid="trophy-secret">
        <span className="text-3xl grayscale">🎁</span>
        <span className="text-sm font-semibold">Secret</span>
        <span className="text-xs text-muted">Keep playing.</span>
      </Card>
    );
  }
  return (
    <Card
      className={cx("flex flex-col items-center gap-1 p-3 text-center", !t.earned && "opacity-60")}
      data-testid={t.earned ? "trophy-earned" : "trophy-locked"}
    >
      <span className={cx("text-3xl", !t.earned && "grayscale")}>{t.icon}</span>
      <span className="text-sm font-semibold">{t.name}</span>
      <span className="text-xs text-muted">{t.flavor}</span>
      {t.earned ? (
        <>
          <span className="mt-1 font-mono text-[10px] text-gold">+{t.xp} XP</span>
          {t.awardedAt && <span className="font-mono text-[10px] text-muted">{new Date(t.awardedAt).toLocaleDateString()}</span>}
        </>
      ) : (
        <div className="mt-1 w-full">
          <Meter pct={t.pct} />
          <span className="mt-1 block font-mono text-[10px] text-muted">
            {Math.floor(t.value).toLocaleString()} / {(t.threshold ?? 0).toLocaleString()}
          </span>
        </div>
      )}
      <span className="font-mono text-[10px] text-muted">{rarityLabel(t.rarity)}</span>
    </Card>
  );
}

export function Achievements() {
  const { data: trophies, isLoading: loadingTrophies } = useGetTrophiesQuery();
  const { data, isLoading } = useGetAchievementsQuery();
  const { data: me } = useGetMeQuery();
  if (isLoading || loadingTrophies) return <Spinner />;

  const streaks = (data?.streaks || []).filter((s: any) => s.count > 0 || s.best > 0);
  const points = data?.points || [];
  const total = points.reduce((s: number, p: any) => s + (p.points || 0), 0);
  const max = Math.max(1, ...points.map((p: any) => p.points));
  const handle = me?.user?.handle;

  const all: Trophy[] = trophies?.progress || [];
  const nextUp: Trophy[] = trophies?.nextUp || [];
  // Group into ladders, preserving the catalog's own order rather than sorting — the
  // catalog is arranged by theme, and that arrangement is editorial.
  const ladders: Array<[string, Trophy[]]> = [];
  for (const t of all) {
    const last = ladders[ladders.length - 1];
    if (last && last[0] === t.series) last[1].push(t);
    else ladders.push([t.series, [t]]);
  }

  return (
    <div data-testid="achievements">
      <PageHeader
        title="Achievements"
        sub="Your track record on The Bay — points, streaks, and trophies."
        right={
          <span className="font-mono text-sm text-gold">
            🏆 {trophies?.earnedCount ?? 0}
            <span className="text-muted">/{trophies?.total ?? 0}</span>
          </span>
        }
      />

      {/* What you're closest to. The single most motivating thing on the page, so it
          goes above the fold rather than under the ledger. */}
      {nextUp.length > 0 && (
        <Card className="mb-4 p-4" data-testid="trophy-next-up">
          <h3 className="mb-3 text-sm font-semibold">Next up</h3>
          <div className="flex flex-col gap-3">
            {nextUp.map((t) => (
              <div key={t.id} className="flex items-center gap-3">
                <span className="text-xl grayscale">{t.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{t.name}</span>
                    <span className="shrink-0 font-mono text-xs text-muted">
                      {Math.floor(t.value).toLocaleString()}/{(t.threshold ?? 0).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-1">
                    <Meter pct={t.pct} />
                  </div>
                </div>
                <span className="shrink-0 font-mono text-xs text-gold">+{t.xp}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

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
                <span className="w-40 shrink-0 text-sm">
                  {meta.icon} {meta.label} <span className="font-mono text-xs text-muted">×{p.count}</span>
                </span>
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
                <span className="flex items-center gap-3">
                  <Flame n={s.count} />
                  <span className="font-mono text-xs text-muted">best {s.best}</span>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* the case itself — every ladder, locked rungs included */}
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Trophy case</h3>
        {trophies && trophies.xpFromTrophies > 0 && (
          <span className="font-mono text-xs text-muted">{trophies.xpFromTrophies.toLocaleString()} XP from trophies</span>
        )}
      </div>
      {all.length === 0 ? (
        <EmptyState title="No trophies yet" hint="Review an event, check in, or host to unlock your first." />
      ) : (
        <div className="flex flex-col gap-5">
          {ladders.map(([name, rungs]) => {
            const got = rungs.filter((r) => r.earned).length;
            return (
              <div key={name}>
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted">{title(name)}</span>
                  <span className="font-mono text-[10px] text-muted">
                    {got}/{rungs.length}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {rungs.map((t) => (
                    <TrophyCard key={t.id} t={t} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {handle && (
        <Card className="mt-4 flex items-center justify-between p-3 text-sm">
          <span className="text-muted">Share your achievements</span>
          <a className="font-mono text-accent hover:underline" href={`/app/u/${handle}`}>
            the.bay/u/{handle} →
          </a>
        </Card>
      )}
      {handle && (
        <div className="mt-2">
          <Badge>Public profile shows goals &amp; trophies when social sharing is on</Badge>
        </div>
      )}
    </div>
  );
}
