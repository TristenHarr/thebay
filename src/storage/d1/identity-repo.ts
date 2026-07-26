import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import { buildCard, type CardBadge, type FounderCard } from "../../core/xp/card";
import type { FounderSnapshot } from "../../core/xp/stats";
import { badgeKind, badgeSlug, checkBadge, parseBadgeKind, type BadgeCheck } from "../../core/gym/badge";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();
const safeJson = (s: unknown): string[] => {
  if (typeof s !== "string" || !s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

export interface FounderIdentity {
  typeId: string | null;
  type2Id: string | null;
  vouches: Record<string, number>;
}

/**
 * Identity — what you are, who vouched for it, and the card that renders from it.
 *
 * The interesting part of this file is `snapshot()`. `founderStats` has existed and been unit
 * tested since the XP module was written, and it was wired to NOTHING: no query anywhere built
 * a `FounderSnapshot`, so no user had ever seen one. Several of its fields had no query at all
 * — friend COUNT (only a list existed), lifetime shadows (the rows are purged at 24h expiry),
 * per-user check-in count — which is presumably why it was never finished.
 *
 * It also reads `match_prefs.interests_json`, which is WRITTEN by the live `/match` screen
 * (`graph-repo.ts:255`) and read by nothing in the entire codebase. Feeding it here turns on
 * the `capital` and `technical` axes for the first time in production.
 */
export class IdentityRepo {
  constructor(private db: D1Database) {}

  // ── what you are ────────────────────────────────────────────────────────────
  async identity(userId: string): Promise<FounderIdentity> {
    const [row, vouches] = await Promise.all([
      this.db.prepare("SELECT type_id, type2_id FROM founder_identity WHERE user_id = ?").bind(userId).first<Row>(),
      this.db.prepare("SELECT type_id, COUNT(*) AS n FROM founder_type_vouches WHERE user_id = ? GROUP BY type_id").bind(userId).all<Row>(),
    ]);
    const counts: Record<string, number> = {};
    for (const v of vouches.results ?? []) counts[v.type_id] = Number(v.n);
    return { typeId: row?.type_id ?? null, type2Id: row?.type2_id ?? null, vouches: counts };
  }

  /** The active type chart, from the table — so a tenth type is a row, not a redeploy. */
  async types(): Promise<Array<{ id: string; label: string; emoji: string; color: string; blurb: string | null; crowdKey: string }>> {
    const r = await this.db
      .prepare("SELECT id, label, emoji, color, blurb, crowd_key FROM founder_types WHERE status = 'active' ORDER BY sort")
      .all<Row>();
    return (r.results ?? []).map((t) => ({ id: t.id, label: t.label, emoji: t.emoji, color: t.color, blurb: t.blurb ?? null, crowdKey: t.crowd_key }));
  }

  /** Declare (or change) what you are. The FK to `founder_types` is what rejects a made-up id. */
  async declare(userId: string, typeId: string, type2Id: string | null, atIso: string = nowIso()): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO founder_identity (user_id, type_id, type2_id, declared_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET type_id = excluded.type_id, type2_id = excluded.type2_id, updated_at = excluded.updated_at`,
      )
      .bind(userId, typeId, type2Id, atIso, atIso)
      .run();
  }

  /**
   * Vouch that somebody really is what they say.
   *
   * A tick on a card and nothing else — no XP, no budget, no access. `INSERT OR IGNORE` because
   * the PK already makes it once-per-voucher, and the CHECK already makes self-vouching
   * impossible; a second attempt is a no-op rather than an error.
   */
  async vouch(userId: string, voucherId: string, typeId: string, eventId: string | null = null, atIso: string = nowIso()): Promise<boolean> {
    if (userId === voucherId) return false;
    const r: any = await this.db
      .prepare("INSERT OR IGNORE INTO founder_type_vouches (user_id, voucher_id, type_id, event_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, voucherId, typeId, eventId, atIso)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  // ── the snapshot ────────────────────────────────────────────────────────────
  /**
   * Everything `founderStats` needs, in one query.
   *
   * Two fields deserve a note, because the obvious source is wrong for both:
   *
   *  · **shadows** counts `points_ledger` rows, not `shadows` rows. A shadow is deleted when
   *    its author posts another and purged 24h after expiry, so the table holds at most one
   *    row per person — the once-per-day points row is the only lifetime record.
   *  · **interests** comes from `match_prefs.interests_json`, written by the live `/match`
   *    screen and read nowhere until now.
   */
  async snapshot(userId: string): Promise<{ snapshot: FounderSnapshot; xpTotal: number; trophies: number }> {
    // 12 placeholders below — `friends` binds the id twice (user_low OR user_high). Counted
    // rather than derived, because an off-by-one here throws only at runtime.
    const BINDS = 12;
    const r = await this.db
      .prepare(
        `SELECT
           (SELECT COALESCE(technical,0) FROM match_prefs WHERE user_id = ?)                                    AS technical,
           (SELECT interests_json FROM match_prefs WHERE user_id = ?)                                           AS interests,
           (SELECT topics_json FROM mentor_profiles WHERE user_id = ?)                                          AS topics,
           (SELECT COUNT(*) FROM friendships WHERE status='accepted' AND (user_low = ? OR user_high = ?))       AS friends,
           (SELECT COUNT(*) FROM intro_forwards WHERE connector_id = ? AND status='accepted')                   AS intros,
           (SELECT COALESCE(SUM(points),0) FROM points_ledger WHERE user_id = ?)                                AS points,
           (SELECT COALESCE(SUM(xp),0) FROM xp_ledger WHERE user_id = ?)                                        AS xp,
           (SELECT COALESCE(MAX(best),0) FROM streaks WHERE user_id = ?)                                        AS streak_best,
           (SELECT COUNT(*) FROM points_ledger WHERE user_id = ? AND kind='shadow')                             AS shadows,
           (SELECT COUNT(*) FROM checkins WHERE user_id = ?)                                                    AS checkins,
           (SELECT COUNT(*) FROM achievements WHERE user_id = ?)                                                AS trophies`,
      )
      .bind(...(Array(BINDS).fill(userId) as string[]))
      .first<Row>();

    // Reputation is a separate shape (`subject_reviews` aggregates by subject), so it stays its
    // own small query rather than being flattened into the one above.
    const rep = await this.db
      .prepare("SELECT COUNT(*) AS n, AVG(rating) AS avg FROM subject_reviews WHERE subject_id = ?")
      .bind(userId)
      .first<Row>();

    const xpTotal = Number(r?.xp ?? 0);
    const level = Math.floor(Math.sqrt(Math.max(0, xpTotal) / 100)) + 1;
    return {
      xpTotal,
      trophies: Number(r?.trophies ?? 0),
      snapshot: {
        technical: !!r?.technical,
        interests: safeJson(r?.interests),
        mentorTopics: safeJson(r?.topics),
        friends: Number(r?.friends ?? 0),
        introsMade: Number(r?.intros ?? 0),
        points: Number(r?.points ?? 0),
        level,
        streakBest: Number(r?.streak_best ?? 0),
        reviewAvg: rep?.avg == null ? null : Number(rep.avg),
        reviewCount: Number(rep?.n ?? 0),
        shadows: Number(r?.shadows ?? 0),
        checkins: Number(r?.checkins ?? 0),
      },
    };
  }

  /** Host badges somebody holds, hydrated with the provenance that keeps them honest. */
  async badges(userId: string): Promise<CardBadge[]> {
    const r = await this.db
      .prepare(
        `SELECT a.kind, a.awarded_at, b.id, b.label, b.emoji, b.color, e.title AS event_title, u.handle AS host_handle
           FROM achievements a
           JOIN gym_badges b ON ('gym:' || b.id) = a.kind
           JOIN events e ON e.id = b.event_id
           LEFT JOIN users u ON u.id = b.host_id
          WHERE a.user_id = ? AND a.kind LIKE 'gym:%' AND b.hidden_at IS NULL
          ORDER BY a.awarded_at DESC`,
      )
      .bind(userId)
      .all<Row>();
    return (r.results ?? []).map((x) => ({
      id: x.id,
      label: x.label,
      emoji: x.emoji,
      color: x.color,
      awardedBy: x.host_handle ?? null,
      eventTitle: x.event_title ?? null,
      awardedAt: x.awarded_at,
    }));
  }

  /** The whole card, ready to render. */
  async card(userId: string): Promise<FounderCard | null> {
    const user = await this.db.prepare("SELECT id, handle, display_name FROM users WHERE id = ?").bind(userId).first<Row>();
    if (!user) return null;
    const [{ snapshot, xpTotal, trophies }, ident, badges] = await Promise.all([
      this.snapshot(userId),
      this.identity(userId),
      this.badges(userId),
    ]);
    const typeIds = [ident.typeId, ident.type2Id].filter((x): x is string => !!x);
    return buildCard({
      userId: user.id,
      handle: user.handle,
      displayName: user.display_name,
      snapshot,
      xpTotal,
      typeIds,
      vouches: ident.vouches,
      badges,
      // Canonical trophies only — a host badge is not a system award.
      trophies: trophies - badges.length,
    });
  }

  // ── host-minted badges ──────────────────────────────────────────────────────
  /**
   * Mint a badge for an event. Returns the check verdict rather than throwing, so the route can
   * explain what to change.
   */
  async mintBadge(
    eventId: string,
    hostId: string,
    b: { label: string; emoji: string; color?: string; blurb?: string },
    atIso: string = nowIso(),
  ): Promise<{ result: BadgeCheck | "duplicate"; badgeId?: string }> {
    const verdict = checkBadge(b);
    if (verdict !== "ok") return { result: verdict };
    const slug = badgeSlug(b.label);
    if (!slug) return { result: "blank" };

    const id = ulid();
    try {
      await this.db
        .prepare(
          `INSERT INTO gym_badges (id, event_id, host_id, slug, label, emoji, color, blurb, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, eventId, hostId, slug, b.label.trim(), b.emoji.trim(), b.color ?? "#f5c451", b.blurb ?? null, atIso)
        .run();
    } catch {
      return { result: "duplicate" }; // UNIQUE (event_id, slug)
    }
    return { result: "ok", badgeId: id };
  }

  async eventBadges(eventId: string): Promise<Array<{ id: string; slug: string; label: string; emoji: string; color: string }>> {
    const r = await this.db
      .prepare("SELECT id, slug, label, emoji, color FROM gym_badges WHERE event_id = ? AND hidden_at IS NULL ORDER BY created_at")
      .bind(eventId)
      .all<Row>();
    return (r.results ?? []).map((b) => ({ id: b.id, slug: b.slug, label: b.label, emoji: b.emoji, color: b.color }));
  }

  /**
   * Give a badge to somebody.
   *
   * Written into `achievements` as `gym:<badgeId>` — the same table the trophy engine uses, in
   * the one namespace the schema trigger permits. `INSERT OR IGNORE` on the dedup key makes a
   * second award a no-op.
   */
  async awardBadge(userId: string, badgeId: string, atIso: string = nowIso()): Promise<boolean> {
    const r: any = await this.db
      .prepare("INSERT OR IGNORE INTO achievements (id, user_id, kind, dedup_key, meta_json, awarded_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(ulid(), userId, badgeKind(badgeId), `${badgeKind(badgeId)}:${userId}`, JSON.stringify({ badgeId }), atIso)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** Hide a badge without deleting the grant — the grant is a true record of what a host did. */
  async hideBadge(badgeId: string, atIso: string = nowIso()): Promise<void> {
    await this.db.prepare("UPDATE gym_badges SET hidden_at = ? WHERE id = ?").bind(atIso, badgeId).run();
  }

  /** Badge id for an `achievements.kind`, or null. Re-exported so routes don't parse by hand. */
  static badgeIdOf(kind: string): string | null {
    return parseBadgeKind(kind);
  }
}
