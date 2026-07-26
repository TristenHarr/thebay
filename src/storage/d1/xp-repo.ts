import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import { levelProgress, type LevelProgress } from "../../core/xp/levels";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

/**
 * XpRepo — the Experience ledger (the game's leveling track), separate from the
 * social points ledger. Every grant is idempotent via a globally-unique dedup_key
 * (keys embed the user + the thing earned), so a replayed movement ping / orb / catch
 * never double-grants. The level is always derived from the pure curve (src/core/xp/levels).
 */
export class XpRepo {
  constructor(private db: D1Database) {}

  /** Grant XP idempotently. Returns true iff this was a NEW grant (dedup_key unseen). */
  async grant(userId: string, kind: string, xp: number, dedupKey: string, meta?: Record<string, unknown>): Promise<boolean> {
    const r: any = await this.db
      .prepare("INSERT OR IGNORE INTO xp_ledger (id, user_id, kind, xp, dedup_key, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(ulid(), userId, kind, Math.round(xp), dedupKey, meta ? JSON.stringify(meta) : null, nowIso())
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  async total(userId: string): Promise<number> {
    const r = await this.db.prepare("SELECT COALESCE(SUM(xp),0) AS n FROM xp_ledger WHERE user_id = ?").bind(userId).first<Row>();
    return Number(r?.n ?? 0);
  }

  /** Total XP + everything the level bar needs, from the pure curve. */
  async levelInfo(userId: string): Promise<LevelProgress> {
    return levelProgress(await this.total(userId));
  }

  async breakdown(userId: string): Promise<Array<{ kind: string; xp: number; count: number }>> {
    const r = await this.db
      .prepare("SELECT kind, SUM(xp) AS xp, COUNT(*) AS count FROM xp_ledger WHERE user_id = ? GROUP BY kind ORDER BY xp DESC")
      .bind(userId)
      .all<Row>();
    return (r.results ?? []).map((x) => ({ kind: x.kind, xp: Number(x.xp), count: Number(x.count) }));
  }

  /** Leaderboard by total XP (metric='xp') or by a single kind (e.g. 'movement'). */
  async leaderboard(metric = "xp", limit = 50): Promise<Array<{ userId: string; displayName: string; handle: string; xp: number; level: number }>> {
    const byKind = metric !== "xp";
    const rows = await this.db
      .prepare(
        `SELECT u.id AS userId, u.display_name AS displayName, u.handle AS handle, SUM(x.xp) AS xp
           FROM xp_ledger x JOIN users u ON u.id = x.user_id
          ${byKind ? "WHERE x.kind = ?" : ""}
          GROUP BY u.id ORDER BY xp DESC LIMIT ?`,
      )
      .bind(...(byKind ? [metric, limit] : [limit]))
      .all<Row>();
    return (rows.results ?? []).map((r) => ({ userId: r.userId, displayName: r.displayName, handle: r.handle, xp: Number(r.xp), level: levelProgress(Number(r.xp)).level }));
  }
}
