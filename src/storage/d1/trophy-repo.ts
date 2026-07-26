import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import { TROPHIES, trophyById, type Trophy } from "../../core/trophies/catalog";
import { evaluate, emptyMetrics, type TrophyMetrics } from "../../core/trophies/evaluate";
import { XpRepo } from "./xp-repo";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

/**
 * TrophyRepo — reads the metric snapshot, grants the diff, pays the XP.
 *
 * Three deliberate choices:
 *
 * **The snapshot is ONE statement.** Twenty-two scalar subqueries in a single
 * `SELECT` rather than twenty-two round trips. On D1 the cost of a read is the round
 * trip, not the row, and the achievements screen would otherwise be twenty-two
 * sequential hops. Every subquery is against an existing index (`idx_points_user`,
 * `idx_achievements_user`, `idx_events_host`, `idx_friend_high`, …).
 *
 * **Earned-ness is decided by `kind`, not by `dedup_key`.** Shipped code granted five
 * trophies with a `<kind>:<userId>` key but `intro_made` with `intro_made:<forwardId>`
 * (graph-repo.ts:171), so a connector who forwarded three intros has three rows for
 * one trophy. Keying the "do I already have it" check on `kind` handles both shapes,
 * collapses the duplicates on read, and means a future grant site with yet another key
 * format still cannot produce a double award. The `dedup_key` UNIQUE remains the
 * concurrency guarantee — the `kind` read is the compatibility layer above it.
 *
 * **XP is granted per trophy, not per sync**, keyed `trophy:<id>:<userId>`. So a
 * replayed sync, a concurrent sync and a future backfill all converge on the same
 * ledger, and `XpRepo.grant`'s `INSERT OR IGNORE` does the arbitrating. This is that
 * repo's first production call site.
 */
export class TrophyRepo {
  constructor(private db: D1Database) {}

  /**
   * Every counter the catalog can measure, for one user, in one query.
   *
   * `shadows` and `connections` come from `points_ledger` rather than their own
   * tables on purpose: `shadows` rows are deleted on repost (shadows-repo.ts:53) and
   * purged at expiry, so the once-per-day points row is the only lifetime record.
   */
  async metrics(userId: string): Promise<TrophyMetrics> {
    // Positional `?` rather than `?1` — D1 accepts numbered parameters but
    // better-sqlite3 (the engine behind tests/helpers/d1.ts) rejects them when bound
    // positionally, so a `?1` query would pass in production and throw in every test.
    // 23 binds, comfortably inside D1's 100-parameter ceiling.
    const BINDS = 23;
    const r = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM checkins        WHERE user_id = ?)                                        AS checkins,
           (SELECT COUNT(*) FROM rsvps           WHERE user_id = ?)                                        AS rsvps,
           (SELECT COUNT(*) FROM reviews         WHERE user_id = ?)                                        AS reviews,
           (SELECT COUNT(*) FROM events          WHERE host_user_id = ?)                                   AS hosted,
           (SELECT COUNT(*) FROM media           WHERE user_id = ?)                                        AS photos,
           (SELECT COUNT(*) FROM vibe_reports    WHERE user_id = ?)                                        AS vibeReports,
           (SELECT COUNT(*) FROM places          WHERE created_by = ?)                                     AS places,
           (SELECT COUNT(*) FROM place_reports   WHERE user_id = ? AND verdict = 'confirm')                AS placeConfirms,
           (SELECT COUNT(*) FROM stories         WHERE author_id = ? AND dead = 0)                         AS stories,
           (SELECT COUNT(*) FROM comments        WHERE author_id = ? AND dead = 0)                         AS comments,
           (SELECT COUNT(*) FROM story_votes     WHERE user_id = ?)                                        AS storyVotes,
           (SELECT COUNT(*) FROM community_members WHERE user_id = ?)                                      AS communities,
           (SELECT COUNT(*) FROM intro_forwards  WHERE connector_id = ? AND status = 'accepted')           AS intros,
           (SELECT COUNT(*) FROM mentor_requests WHERE mentor_id = ? AND status = 'accepted')              AS mentorships,
           (SELECT COUNT(*) FROM friendships     WHERE status = 'accepted'
                                                   AND (user_low = ? OR user_high = ?))                    AS friends,
           (SELECT COUNT(*) FROM points_ledger   WHERE user_id = ? AND kind = 'shadow')                    AS shadows,
           (SELECT COUNT(*) FROM points_ledger   WHERE user_id = ? AND kind = 'connection')                AS connections,
           (SELECT COUNT(*) FROM achievements    WHERE user_id = ? AND kind = 'shadow_area')               AS shadowAreas,
           (SELECT COALESCE(MAX(best),0) FROM streaks WHERE user_id = ? AND kind = 'attend')               AS attendStreak,
           (SELECT COALESCE(MAX(best),0) FROM streaks WHERE user_id = ? AND kind = 'shadow')               AS shadowStreak,
           (SELECT COALESCE(SUM(xp),0)     FROM xp_ledger     WHERE user_id = ?)                           AS xp,
           (SELECT COALESCE(SUM(points),0) FROM points_ledger WHERE user_id = ?)                           AS points`,
      )
      .bind(...(Array(BINDS).fill(userId) as string[]))
      .first<Row>();

    const m = emptyMetrics();
    if (!r) return m;
    for (const k of Object.keys(m) as (keyof TrophyMetrics)[]) m[k] = Number(r[k] ?? 0);
    return m;
  }

  /** Trophy id → the EARLIEST award date held. Collapses `intro_made`'s per-forward rows. */
  async held(userId: string): Promise<Map<string, string>> {
    const r = await this.db
      .prepare("SELECT kind, MIN(awarded_at) AS awarded_at FROM achievements WHERE user_id = ? GROUP BY kind")
      .bind(userId)
      .all<Row>();
    const out = new Map<string, string>();
    // Unknown kinds (`shadow_area`, and anything a future gym badge writes) are
    // skipped here rather than filtered downstream — the catalog decides what a
    // trophy is, and nothing else gets to appear in the case.
    for (const row of r.results ?? []) if (trophyById(row.kind)) out.set(row.kind, row.awarded_at);
    return out;
  }

  /**
   * Grant everything earned-but-not-held, and pay its XP.
   *
   * Returns only what was NEWLY granted, so a caller can toast "🏆 Local Legend
   * unlocked" without diffing anything itself.
   */
  async sync(userId: string, atIso: string = nowIso()): Promise<{ granted: string[]; xp: number }> {
    const [metrics, held] = await Promise.all([this.metrics(userId), this.held(userId)]);
    const fresh = evaluate(metrics).earned.filter((id) => !held.has(id));
    if (fresh.length === 0) return { granted: [], xp: 0 };

    const xpRepo = new XpRepo(this.db);
    const granted: string[] = [];
    let xp = 0;

    for (const id of fresh) {
      const t = trophyById(id)!;
      // Legacy-compatible dedup key: the five kinds shipped code already granted used
      // exactly this shape, so even a race against the old grant sites collapses.
      const res: any = await this.db
        .prepare("INSERT OR IGNORE INTO achievements (id, user_id, kind, dedup_key, meta_json, awarded_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(ulid(), userId, t.id, `${t.id}:${userId}`, JSON.stringify({ series: t.series, tier: t.tier, metric: t.metric, threshold: t.threshold }), atIso)
        .run();
      if ((res.meta?.changes ?? 0) === 0) continue; // somebody else got there first

      granted.push(t.id);
      // Keyed per trophy, so the XP survives a replay even if the achievement row
      // is later hidden or the sync is run twice concurrently.
      if (await xpRepo.grant(userId, "trophy", t.xp, `trophy:${t.id}:${userId}`, { trophy: t.id, series: t.series, tier: t.tier })) {
        xp += t.xp;
      }
    }
    return { granted, xp };
  }

  /** How many members hold each trophy, and how many members there are. */
  private async rarity(): Promise<{ holders: Map<string, number>; members: number }> {
    const [counts, total] = await Promise.all([
      this.db.prepare("SELECT kind, COUNT(DISTINCT user_id) AS n FROM achievements GROUP BY kind").all<Row>(),
      this.db.prepare("SELECT COUNT(*) AS n FROM users").first<Row>(),
    ]);
    const holders = new Map<string, number>();
    for (const r of counts.results ?? []) holders.set(r.kind, Number(r.n));
    return { holders, members: Number(total?.n ?? 0) };
  }

  /**
   * The whole catalog, resolved for one user — earned, locked, in-progress, and how
   * rare each one is. This is what `GET /api/trophies` returns, and it is why the
   * client no longer needs a hard-coded trophy table.
   */
  async view(userId: string): Promise<TrophyView> {
    const [metrics, held, { holders, members }] = await Promise.all([this.metrics(userId), this.held(userId), this.rarity()]);
    const ev = evaluate(metrics);
    const byId = new Map(ev.progress.map((p) => [p.id, p]));

    const progress: TrophyRow[] = TROPHIES.map((t: Trophy) => {
      const p = byId.get(t.id)!;
      // Held wins over computed: a legacy grant, or a trophy whose underlying metric
      // later decreased (a deleted story, a revoked award), must not be taken back.
      const earned = p.earned || held.has(t.id);
      // A secret is redacted HERE, not in the route, so no future caller can leak it
      // by forgetting to. `threshold` and `metric` go too — "200 shadows" names the
      // trophy as surely as its title does.
      const hidden = !!t.secret && !earned;
      return {
        id: t.id,
        series: t.series,
        tier: t.tier,
        name: hidden ? null : t.name,
        flavor: hidden ? null : t.flavor,
        icon: hidden ? null : t.icon,
        metric: hidden ? null : t.metric,
        threshold: hidden ? null : t.threshold,
        xp: t.xp,
        earned,
        awardedAt: held.get(t.id) ?? null,
        value: hidden ? 0 : p.value,
        pct: hidden ? 0 : earned ? 1 : p.pct,
        remaining: hidden ? 0 : earned ? 0 : p.remaining,
        rarity: members > 0 ? (holders.get(t.id) ?? 0) / members : 0,
        /** A secret stays a blank slot until you earn it. */
        hidden,
      };
    });

    const earnedRows = progress.filter((p) => p.earned);
    return {
      progress,
      nextUp: ev.nextUp.map((n) => progress.find((p) => p.id === n.id)!).filter((p) => !p.earned),
      earnedCount: earnedRows.length,
      total: progress.length,
      xpFromTrophies: earnedRows.reduce((s, p) => s + p.xp, 0),
    };
  }
}

export interface TrophyRow {
  id: string;
  series: string;
  tier: number;
  /** Null while `hidden` — a redacted secret ships no title, flavor, icon or target. */
  name: string | null;
  flavor: string | null;
  icon: string | null;
  metric: string | null;
  threshold: number | null;
  xp: number;
  earned: boolean;
  awardedAt: string | null;
  value: number;
  pct: number;
  remaining: number;
  /** 0..1 — share of members holding this. */
  rarity: number;
  hidden: boolean;
}

export interface TrophyView {
  progress: TrophyRow[];
  nextUp: TrophyRow[];
  earnedCount: number;
  total: number;
  xpFromTrophies: number;
}
