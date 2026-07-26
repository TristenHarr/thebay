import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import { displayDomain } from "../../news/canonical";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

export type FlagTarget = "story" | "comment";
export type FlagReason = "spam" | "off_topic" | "abuse" | "duplicate" | "broken" | "other";

export interface QueueItem {
  targetType: FlagTarget;
  targetId: string;
  title: string;
  url: string | null;
  slug: string | null;
  author: string | null;
  handle: string | null;
  createdAt: string;
  dead: number;
  flagCount: number;
  reasons: string[];
  storyId: string;
  storySlug: string | null;
}

export interface ModAction {
  id: string;
  targetType: string;
  targetId: string;
  action: string;
  actor: string | null;
  note: string | null;
  createdAt: string;
}

/**
 * ModerationRepo — flags, the review queue, and the reversible actions a human
 * can take.
 *
 * Two invariants hold everywhere in this file:
 *
 *   1. NOTHING HERE IS AUTOMATIC. There is no threshold, no count, and no score
 *      that hides content. `hide`/`kill`/`ban` are only ever called from an
 *      admin-gated route. Flags exist purely to sort `queue()`.
 *   2. NOTHING HARD-DELETES, and every mutation writes a `moderation_actions`
 *      row in the same call — so the audit log cannot drift from what actually
 *      happened, and every decision is reversible and attributable.
 */
export class ModerationRepo {
  constructor(private db: D1Database) {}

  private async log(
    targetType: string,
    targetId: string,
    action: string,
    actorId: string | null,
    note?: string | null,
    atIso: string = nowIso(),
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO moderation_actions (id, target_type, target_id, action, actor_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(ulid(), targetType, targetId, action, actorId, note ?? null, atIso)
      .run();
  }

  // ── flags (a signal; never an action) ───────────────────────────────────────

  /** Idempotent: flagging twice is the same as flagging once. */
  async flag(
    targetType: FlagTarget,
    targetId: string,
    userId: string,
    reason: FlagReason = "other",
    atIso: string = nowIso(),
  ): Promise<{ counted: boolean; total: number }> {
    const r = await this.db
      .prepare("INSERT OR IGNORE INTO flags (target_type, target_id, user_id, reason, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(targetType, targetId, userId, reason, atIso)
      .run();
    return { counted: !!r.meta?.changes, total: await this.flagCount(targetType, targetId) };
  }

  async unflag(targetType: FlagTarget, targetId: string, userId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM flags WHERE target_type = ? AND target_id = ? AND user_id = ?")
      .bind(targetType, targetId, userId)
      .run();
  }

  async flagCount(targetType: FlagTarget, targetId: string): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS n FROM flags WHERE target_type = ? AND target_id = ?")
      .bind(targetType, targetId)
      .first<Row>();
    return r?.n ?? 0;
  }

  /** Who flagged something — so a reviewer can see a pile-on for what it is. */
  async flaggers(targetType: FlagTarget, targetId: string): Promise<{ handle: string; reason: string; at: string }[]> {
    const r = await this.db
      .prepare(
        `SELECT u.handle, f.reason, f.created_at
           FROM flags f JOIN users u ON u.id = f.user_id
          WHERE f.target_type = ? AND f.target_id = ? ORDER BY f.created_at`,
      )
      .bind(targetType, targetId)
      .all<Row>();
    return (r.results ?? []).map((x) => ({ handle: x.handle, reason: x.reason, at: x.created_at }));
  }

  // ── the queue ───────────────────────────────────────────────────────────────

  /** Flagged stories and comments, most-flagged first. Includes already-hidden
   *  items so a moderator can review and REVERSE their own calls. */
  async queue(limit = 50): Promise<QueueItem[]> {
    const stories = await this.db
      .prepare(
        `SELECT 'story' AS target_type, s.id AS target_id, s.title, s.url, s.slug, s.dead, s.created_at,
                u.display_name AS author, u.handle,
                s.id AS story_id, s.slug AS story_slug,
                (SELECT COUNT(*) FROM flags f WHERE f.target_type='story' AND f.target_id=s.id) AS flag_count,
                (SELECT GROUP_CONCAT(DISTINCT f.reason) FROM flags f WHERE f.target_type='story' AND f.target_id=s.id) AS reasons
           FROM stories s LEFT JOIN users u ON u.id = s.author_id
          WHERE EXISTS (SELECT 1 FROM flags f WHERE f.target_type='story' AND f.target_id=s.id)
          ORDER BY flag_count DESC, s.created_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();

    const comments = await this.db
      .prepare(
        `SELECT 'comment' AS target_type, c.id AS target_id, c.body AS title, NULL AS url, NULL AS slug,
                c.dead, c.created_at, u.display_name AS author, u.handle,
                c.story_id, st.slug AS story_slug,
                (SELECT COUNT(*) FROM flags f WHERE f.target_type='comment' AND f.target_id=c.id) AS flag_count,
                (SELECT GROUP_CONCAT(DISTINCT f.reason) FROM flags f WHERE f.target_type='comment' AND f.target_id=c.id) AS reasons
           FROM comments c
           LEFT JOIN users u ON u.id = c.author_id
           JOIN stories st ON st.id = c.story_id
          WHERE EXISTS (SELECT 1 FROM flags f WHERE f.target_type='comment' AND f.target_id=c.id)
          ORDER BY flag_count DESC, c.created_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();

    const map = (x: Row): QueueItem => ({
      targetType: x.target_type,
      targetId: x.target_id,
      title: String(x.title ?? "").slice(0, 300),
      url: x.url ?? null,
      slug: x.slug ?? null,
      author: x.author ?? null,
      handle: x.handle ?? null,
      createdAt: x.created_at,
      dead: x.dead ?? 0,
      flagCount: x.flag_count ?? 0,
      reasons: String(x.reasons ?? "").split(",").filter(Boolean),
      storyId: x.story_id,
      storySlug: x.story_slug ?? null,
    });

    return [...(stories.results ?? []).map(map), ...(comments.results ?? []).map(map)]
      .sort((a, b) => b.flagCount - a.flagCount || (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  // ── reversible actions (admin only, always logged) ───────────────────────────

  async hideStory(storyId: string, actorId: string, note?: string): Promise<void> {
    await this.db.prepare("UPDATE stories SET dead = 1 WHERE id = ?").bind(storyId).run();
    await this.log("story", storyId, "hide", actorId, note);
  }

  async unhideStory(storyId: string, actorId: string, note?: string): Promise<void> {
    await this.db.prepare("UPDATE stories SET dead = 0 WHERE id = ?").bind(storyId).run();
    await this.log("story", storyId, "unhide", actorId, note);
  }

  async killComment(commentId: string, actorId: string, note?: string): Promise<void> {
    await this.db.prepare("UPDATE comments SET dead = 1 WHERE id = ?").bind(commentId).run();
    await this.log("comment", commentId, "kill", actorId, note);
  }

  async reviveComment(commentId: string, actorId: string, note?: string): Promise<void> {
    await this.db.prepare("UPDATE comments SET dead = 0 WHERE id = ?").bind(commentId).run();
    await this.log("comment", commentId, "revive", actorId, note);
  }

  /** Blocks WRITING only. Reading stays open and existing contributions stay up
   *  with their attribution intact — a ban is not a retroactive erasure. */
  async ban(userId: string, actorId: string, note?: string, atIso: string = nowIso()): Promise<void> {
    await this.db.prepare("UPDATE users SET banned_at = ? WHERE id = ?").bind(atIso, userId).run();
    await this.log("user", userId, "ban", actorId, note, atIso);
  }

  async unban(userId: string, actorId: string, note?: string): Promise<void> {
    await this.db.prepare("UPDATE users SET banned_at = NULL WHERE id = ?").bind(userId).run();
    await this.log("user", userId, "unban", actorId, note);
  }

  async isBanned(userId: string): Promise<boolean> {
    const r = await this.db.prepare("SELECT banned_at FROM users WHERE id = ?").bind(userId).first<Row>();
    return !!r?.banned_at;
  }

  // ── domains ─────────────────────────────────────────────────────────────────

  /** An operator decision taken after seeing spam — not an automatic filter.
   *  Hides the domain's existing stories too, and logs both parts. */
  async blockDomain(rawDomain: string, actorId: string, reason?: string, atIso: string = nowIso()): Promise<number> {
    const domain = displayDomain(rawDomain.startsWith("http") ? rawDomain : `https://${rawDomain}`) || rawDomain.toLowerCase();
    await this.db
      .prepare("INSERT OR IGNORE INTO blocked_domains (domain, reason, created_at) VALUES (?, ?, ?)")
      .bind(domain, reason ?? null, atIso)
      .run();
    const r = await this.db
      .prepare("UPDATE stories SET dead = 1 WHERE url LIKE ? OR url LIKE ?")
      .bind(`https://${domain}/%`, `https://www.${domain}/%`)
      .run();
    await this.log("story", domain, "block_domain", actorId, reason, atIso);
    return r.meta?.changes ?? 0;
  }

  async unblockDomain(domain: string, actorId: string): Promise<void> {
    await this.db.prepare("DELETE FROM blocked_domains WHERE domain = ?").bind(domain.toLowerCase()).run();
    await this.log("story", domain.toLowerCase(), "unblock_domain", actorId, null);
  }

  async blockedDomains(): Promise<string[]> {
    const r = await this.db.prepare("SELECT domain FROM blocked_domains ORDER BY domain").all<Row>();
    return (r.results ?? []).map((x) => x.domain);
  }

  // ── audit ───────────────────────────────────────────────────────────────────

  async actionLog(limit = 100): Promise<ModAction[]> {
    const r = await this.db
      .prepare(
        // Tie-break on rowid, not id. Two actions in the same millisecond share a
        // created_at, and ULIDs are NOT ordered within a millisecond (the suffix
        // is random) — so ordering by id renders the log out of sequence at
        // random, which for an audit log is a correctness bug, not cosmetics.
        // rowid is SQLite's monotonic insertion order: exactly what append-only
        // wants.
        `SELECT m.id, m.target_type, m.target_id, m.action, m.note, m.created_at, u.handle AS actor
           FROM moderation_actions m LEFT JOIN users u ON u.id = m.actor_id
          ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return (r.results ?? []).map((x) => ({
      id: x.id, targetType: x.target_type, targetId: x.target_id, action: x.action,
      actor: x.actor ?? null, note: x.note ?? null, createdAt: x.created_at,
    }));
  }
}
