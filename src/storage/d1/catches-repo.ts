import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import { founderStats, type FounderSnapshot, type FounderStats } from "../../core/xp/stats";
import { levelForXp } from "../../core/xp/levels";
import { XpRepo } from "./xp-repo";
import { GraphRepo } from "./graph-repo";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();
const CATCH_TOKEN_TTL_MS = 5 * 60 * 1000; // a catch QR rotates every 5 minutes
/** XP for a catch, scaled by how rare the founder is. */
const CATCH_XP: Record<string, number> = { common: 20, uncommon: 40, rare: 80, epic: 150, legendary: 300 };
const parseArr = (s: any): string[] => { try { return Array.isArray(s) ? s : JSON.parse(s || "[]"); } catch { return []; } };

/**
 * CatchesRepo — the founder Pokédex. Assembles a founder's derived stats snapshot
 * from data the platform already has (match prefs, mentor topics, reviews, the
 * social graph, activity, XP level) and the PURE {@link founderStats}. Catching is a
 * QR scan (rotating per-user token = you must be physically together), snapshots the
 * caught founder, grants rarity-scaled XP, and dedupes per pair.
 */
export class CatchesRepo {
  constructor(private db: D1Database) {}

  /** Gather everything the pure stats function needs for a user. */
  async snapshotFor(userId: string): Promise<FounderSnapshot> {
    const q = (sql: string) => this.db.prepare(sql).bind(userId).first<Row>();
    const [prefs, mentor, friends, points, streak, reviews, shadows, checkins] = await Promise.all([
      q("SELECT has_idea, technical, interests_json FROM match_prefs WHERE user_id = ?"),
      q("SELECT topics_json FROM mentor_profiles WHERE user_id = ?"),
      this.db.prepare("SELECT COUNT(*) AS n FROM friendships WHERE status='accepted' AND (user_low = ? OR user_high = ?)").bind(userId, userId).first<Row>(),
      q("SELECT COALESCE(SUM(points),0) AS n FROM points_ledger WHERE user_id = ?"),
      q("SELECT COALESCE(MAX(best),0) AS n FROM streaks WHERE user_id = ?"),
      q("SELECT AVG(rating) AS avg, COUNT(*) AS n FROM subject_reviews WHERE subject_id = ?"),
      q("SELECT COUNT(*) AS n FROM shadows WHERE author_id = ?"),
      q("SELECT COUNT(*) AS n FROM checkins WHERE user_id = ?"),
    ]);
    const [introsMade, xp] = await Promise.all([new GraphRepo(this.db).introsMade(userId), new XpRepo(this.db).total(userId)]);
    return {
      technical: !!prefs?.technical,
      interests: parseArr(prefs?.interests_json),
      mentorTopics: parseArr(mentor?.topics_json),
      friends: Number(friends?.n ?? 0),
      introsMade,
      points: Number(points?.n ?? 0),
      level: levelForXp(xp),
      streakBest: Number(streak?.n ?? 0),
      reviewAvg: reviews?.avg != null ? Number(reviews.avg) : null,
      reviewCount: Number(reviews?.n ?? 0),
      shadows: Number(shadows?.n ?? 0),
      checkins: Number(checkins?.n ?? 0),
    };
  }

  async statsFor(userId: string): Promise<FounderStats> {
    return founderStats(await this.snapshotFor(userId));
  }

  /** Mint the catch QR about to go on screen, revoking the previous one (rotation = revoke). */
  async mintToken(userId: string, atMs = Date.now()): Promise<string> {
    await this.db.prepare("UPDATE catch_tokens SET expires_at = ? WHERE user_id = ? AND expires_at > ?").bind(new Date(atMs - 1).toISOString(), userId, new Date(atMs).toISOString()).run();
    const token = (ulid() + ulid()).toLowerCase();
    await this.db.prepare("INSERT INTO catch_tokens (id, user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").bind(ulid(), userId, token, new Date(atMs + CATCH_TOKEN_TTL_MS).toISOString(), new Date(atMs).toISOString()).run();
    return token;
  }

  /** Scan someone's catch QR → add them to your Pokédex (once) + grant rarity XP. */
  async capture(catcherId: string, token: string, atMs = Date.now()): Promise<{ status: "ok" | "self" | "invalid" | "expired" | "already"; caught?: any; xp?: number }> {
    const tok = await this.db.prepare("SELECT user_id, expires_at FROM catch_tokens WHERE token = ?").bind(token).first<Row>();
    if (!tok) return { status: "invalid" };
    if (new Date(tok.expires_at).getTime() < atMs) return { status: "expired" };
    const caughtId = tok.user_id as string;
    if (caughtId === catcherId) return { status: "self" };
    if (await this.db.prepare("SELECT 1 FROM catches WHERE catcher_id = ? AND caught_id = ?").bind(catcherId, caughtId).first()) return { status: "already" };

    const stats = await this.statsFor(caughtId);
    await this.db
      .prepare("INSERT INTO catches (catcher_id, caught_id, caught_at, rarity, power, stats_json) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(catcherId, caughtId, new Date(atMs).toISOString(), stats.rarity, stats.power, JSON.stringify(stats))
      .run();
    const xp = CATCH_XP[stats.rarity] ?? 20;
    await new XpRepo(this.db).grant(catcherId, "catch", xp, `catch:${catcherId}:${caughtId}`, { caught: caughtId, rarity: stats.rarity });
    const u = await this.db.prepare("SELECT id, display_name, handle, avatar_key FROM users WHERE id = ?").bind(caughtId).first<Row>();
    return { status: "ok", caught: { id: u!.id, displayName: u!.display_name, handle: u!.handle, avatarKey: u!.avatar_key ?? null, stats }, xp };
  }

  /** Your collection — everyone you've caught, newest first, with their snapshot card. */
  async pokedex(userId: string): Promise<Array<{ id: string; displayName: string; handle: string; avatarKey: string | null; caughtAt: string; rarity: string; power: number; stats: FounderStats }>> {
    const r = await this.db
      .prepare(
        `SELECT c.caught_id, c.caught_at, c.rarity, c.power, c.stats_json, u.display_name, u.handle, u.avatar_key
           FROM catches c JOIN users u ON u.id = c.caught_id WHERE c.catcher_id = ? ORDER BY c.caught_at DESC`,
      )
      .bind(userId)
      .all<Row>();
    return (r.results ?? []).map((x) => ({
      id: x.caught_id, displayName: x.display_name, handle: x.handle, avatarKey: x.avatar_key ?? null,
      caughtAt: x.caught_at, rarity: x.rarity, power: x.power, stats: JSON.parse(x.stats_json),
    }));
  }
}
