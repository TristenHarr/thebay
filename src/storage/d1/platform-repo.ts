import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import { POINTS } from "../../../shared/schema";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();
const safeJson = (s: string | null | undefined): Record<string, unknown> => {
  if (!s) return {};
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
};
const WEEK_GRACE_MS = 8 * 86400000; // a check-in within 8 days keeps the weekly streak alive

export interface Goal {
  id: string;
  kind: "overall" | "event";
  eventId: string | null;
  title: string;
  metric: string | null;
  target: number | null;
  progress: number;
  status: "active" | "done" | "archived";
  visibility: "private" | "friends" | "public";
}
const rowToGoal = (r: Row): Goal => ({
  id: r.id,
  kind: r.kind,
  eventId: r.event_id ?? null,
  title: r.title,
  metric: r.metric ?? null,
  target: r.target ?? null,
  progress: r.progress,
  status: r.status,
  visibility: r.visibility,
});

/**
 * PlatformRepo — the new-feature data layer (goals, QR check-in, the review-gate,
 * streaks/achievements). Same conventions as SocialRepo; all invariants that the
 * schema can't express alone live here, and every award is idempotent.
 */
export class PlatformRepo {
  constructor(private db: D1Database) {}

  // ── goals ───────────────────────────────────────────────────────────────────
  async createGoal(
    userId: string,
    g: { kind: "overall" | "event"; eventId?: string; title: string; metric?: string; target?: number; visibility?: Goal["visibility"] },
  ): Promise<string> {
    const id = ulid();
    const ts = nowIso();
    await this.db
      .prepare(
        `INSERT INTO goals (id, user_id, kind, event_id, title, metric, target, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, userId, g.kind, g.eventId ?? null, g.title, g.metric ?? null, g.target ?? null, g.visibility ?? "private", ts, ts)
      .run();
    return id;
  }
  async listGoals(userId: string): Promise<Goal[]> {
    const res = await this.db.prepare("SELECT * FROM goals WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all<Row>();
    return (res.results ?? []).map(rowToGoal);
  }
  async publicGoals(userId: string): Promise<Goal[]> {
    const res = await this.db
      .prepare("SELECT * FROM goals WHERE user_id = ? AND visibility = 'public' AND status != 'archived' ORDER BY created_at DESC")
      .bind(userId)
      .all<Row>();
    return (res.results ?? []).map(rowToGoal);
  }
  async updateGoal(userId: string, goalId: string, patch: Partial<Pick<Goal, "title" | "status" | "progress" | "visibility">>): Promise<void> {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, col] of [["title", "title"], ["status", "status"], ["progress", "progress"], ["visibility", "visibility"]] as const) {
      if ((patch as any)[k] !== undefined) { sets.push(`${col} = ?`); vals.push((patch as any)[k]); }
    }
    if (!sets.length) return;
    sets.push("updated_at = ?"); vals.push(nowIso());
    await this.db.prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...vals, goalId, userId).run();
  }

  // ── QR check-in ─────────────────────────────────────────────────────────────
  async createCheckinToken(eventId: string, ttlMs = 60 * 60 * 1000, atMs = Date.now()): Promise<string> {
    const token = (ulid() + ulid()).toLowerCase();
    await this.db
      .prepare("INSERT INTO checkin_tokens (id, event_id, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(ulid(), eventId, token, new Date(atMs + ttlMs).toISOString(), new Date(atMs).toISOString())
      .run();
    return token;
  }

  /** Returns 'ok' | 'already' | 'invalid' | 'expired'. On 'ok': records the
   *  check-in, awards points, advances the attend-streak, and opens a review
   *  obligation (the gate). */
  async checkIn(userId: string, eventId: string, token: string, atMs = Date.now()): Promise<"ok" | "already" | "invalid" | "expired"> {
    const tok = await this.db.prepare("SELECT event_id, expires_at FROM checkin_tokens WHERE token = ?").bind(token).first<Row>();
    if (!tok || tok.event_id !== eventId) return "invalid";
    if (new Date(tok.expires_at).getTime() < atMs) return "expired";

    const exists = await this.db.prepare("SELECT 1 FROM checkins WHERE user_id = ? AND event_id = ?").bind(userId, eventId).first();
    if (exists) return "already";

    const at = new Date(atMs).toISOString();
    await this.db.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?, ?, ?, 'qr')").bind(userId, eventId, at).run();
    await this.award(userId, "checkin", `checkin:${userId}:${eventId}`, eventId);
    await this.db
      .prepare("INSERT OR IGNORE INTO review_obligations (user_id, event_id, satisfied, created_at) VALUES (?, ?, 0, ?)")
      .bind(userId, eventId, at)
      .run();
    await this.bumpStreak(userId, "attend", atMs);
    return "ok";
  }

  /** Who has checked in to an event (host dashboard). Newest first. */
  async eventCheckins(eventId: string): Promise<{ userId: string; displayName: string; handle: string; at: string; source: string }[]> {
    const r = await this.db
      .prepare(
        `SELECT c.user_id, c.at, c.source, u.display_name, u.handle
           FROM checkins c JOIN users u ON u.id = c.user_id
          WHERE c.event_id = ? ORDER BY c.at DESC`,
      )
      .bind(eventId)
      .all<Row>();
    return (r.results ?? []).map((x) => ({ userId: x.user_id, displayName: x.display_name, handle: x.handle, at: x.at, source: x.source }));
  }

  // ── review-gate ─────────────────────────────────────────────────────────────
  async openObligations(userId: string): Promise<string[]> {
    const res = await this.db
      .prepare("SELECT event_id FROM review_obligations WHERE user_id = ? AND satisfied = 0 ORDER BY created_at")
      .bind(userId)
      .all<{ event_id: string }>();
    return (res.results ?? []).map((r) => r.event_id);
  }
  /** The gate: you can't RSVP while you owe a review for an attended event. */
  async canRsvp(userId: string): Promise<boolean> {
    return (await this.openObligations(userId)).length === 0;
  }

  async reviewEvent(userId: string, eventId: string, rating: number, body?: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO reviews (id, event_id, user_id, rating, body, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id, user_id) DO UPDATE SET rating = excluded.rating, body = excluded.body`,
      )
      .bind(ulid(), eventId, userId, rating, body ?? null, nowIso())
      .run();
    await this.db.prepare("UPDATE review_obligations SET satisfied = 1 WHERE user_id = ? AND event_id = ?").bind(userId, eventId).run();
    await this.award(userId, "review", `review:${userId}:${eventId}`, eventId);
    await this.grantAchievement(userId, "first_review", `first_review:${userId}`);
  }

  // ── subject reviews (host / speaker / participant) — table from 0002; author=user_id ─
  /** You may only review a person you actually encountered: you attended (RSVP'd
   *  'went'/past-'going' or checked in) an event the subject hosted or was also at.
   *  Stops review-bombing of strangers. */
  async canReviewPerson(reviewerId: string, subjectId: string, atIso: string = nowIso()): Promise<boolean> {
    const r = await this.db
      .prepare(
        `SELECT 1 FROM events e
          WHERE (
            EXISTS (SELECT 1 FROM rsvps rr WHERE rr.user_id = ? AND rr.event_id = e.id AND (rr.status = 'went' OR (rr.status = 'going' AND e.start_utc < ?)))
            OR EXISTS (SELECT 1 FROM checkins cr WHERE cr.user_id = ? AND cr.event_id = e.id)
          ) AND (
            e.host_user_id = ?
            OR EXISTS (SELECT 1 FROM rsvps rs WHERE rs.user_id = ? AND rs.event_id = e.id)
            OR EXISTS (SELECT 1 FROM checkins cs WHERE cs.user_id = ? AND cs.event_id = e.id)
          ) LIMIT 1`,
      )
      .bind(reviewerId, atIso, reviewerId, subjectId, subjectId, subjectId)
      .first();
    return !!r;
  }

  async addSubjectReview(authorId: string, subjectType: "host" | "speaker" | "participant", subjectId: string, rating: number, body?: string, eventId?: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO subject_reviews (id, subject_type, subject_id, user_id, event_id, rating, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subject_type, subject_id, user_id) DO UPDATE SET rating=excluded.rating, body=excluded.body, event_id=excluded.event_id`,
      )
      .bind(ulid(), subjectType, subjectId, authorId, eventId ?? null, rating, body ?? null, nowIso())
      .run();
  }

  /** All reviews a person has received, with author names. Newest first. */
  async subjectReviews(subjectId: string): Promise<Array<{ subjectType: string; rating: number; body: string | null; author: string; authorHandle: string; createdAt: string }>> {
    const r = await this.db
      .prepare(
        `SELECT s.subject_type, s.rating, s.body, s.created_at, u.display_name AS author, u.handle AS author_handle
           FROM subject_reviews s JOIN users u ON u.id = s.user_id
          WHERE s.subject_id = ? ORDER BY s.created_at DESC`,
      )
      .bind(subjectId)
      .all<Row>();
    return (r.results ?? []).map((x) => ({ subjectType: x.subject_type, rating: x.rating, body: x.body ?? null, author: x.author, authorHandle: x.author_handle, createdAt: x.created_at }));
  }

  /** A person's aggregate reputation: average rating + count, overall and per role. */
  async subjectRating(subjectId: string): Promise<{ avg: number | null; count: number; byRole: Record<string, { avg: number; count: number }> }> {
    const rows = await this.db.prepare("SELECT subject_type, rating FROM subject_reviews WHERE subject_id = ?").bind(subjectId).all<Row>();
    const all = rows.results ?? [];
    const byRole: Record<string, { sum: number; count: number }> = {};
    let sum = 0;
    for (const r of all) { sum += r.rating; (byRole[r.subject_type] ||= { sum: 0, count: 0 }).sum += r.rating; byRole[r.subject_type]!.count++; }
    const out: Record<string, { avg: number; count: number }> = {};
    for (const [k, v] of Object.entries(byRole)) out[k] = { avg: Math.round((v.sum / v.count) * 10) / 10, count: v.count };
    return { avg: all.length ? Math.round((sum / all.length) * 10) / 10 : null, count: all.length, byRole: out };
  }

  // ── streaks & achievements ──────────────────────────────────────────────────
  async getStreak(userId: string, kind: string): Promise<{ count: number; best: number; last_at: string | null }> {
    const r = await this.db.prepare("SELECT count, best, last_at FROM streaks WHERE user_id = ? AND kind = ?").bind(userId, kind).first<Row>();
    return r ? { count: r.count, best: r.best, last_at: r.last_at ?? null } : { count: 0, best: 0, last_at: null };
  }
  private async bumpStreak(userId: string, kind: string, atMs: number): Promise<void> {
    const cur = await this.getStreak(userId, kind);
    const within = cur.last_at ? atMs - new Date(cur.last_at).getTime() <= WEEK_GRACE_MS : false;
    const count = within ? cur.count + 1 : 1;
    const best = Math.max(cur.best, count);
    await this.db
      .prepare(
        `INSERT INTO streaks (user_id, kind, count, best, last_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, kind) DO UPDATE SET count = excluded.count, best = excluded.best, last_at = excluded.last_at`,
      )
      .bind(userId, kind, count, best, new Date(atMs).toISOString())
      .run();
  }
  /** Every achievement a user has earned, newest first. */
  async listAchievements(userId: string): Promise<{ kind: string; meta: Record<string, unknown>; awardedAt: string }[]> {
    const r = await this.db.prepare("SELECT kind, meta_json, awarded_at FROM achievements WHERE user_id = ? ORDER BY awarded_at DESC").bind(userId).all<Row>();
    return (r.results ?? []).map((a) => ({ kind: a.kind, meta: safeJson(a.meta_json), awardedAt: a.awarded_at }));
  }

  /** All of a user's streaks (attend, review, …). */
  async listStreaks(userId: string): Promise<{ kind: string; count: number; best: number; lastAt: string | null }[]> {
    const r = await this.db.prepare("SELECT kind, count, best, last_at FROM streaks WHERE user_id = ?").bind(userId).all<Row>();
    return (r.results ?? []).map((s) => ({ kind: s.kind, count: s.count, best: s.best, lastAt: s.last_at ?? null }));
  }

  /** Points earned grouped by reason — the breakdown behind a profile's total. */
  async pointsBreakdown(userId: string): Promise<{ kind: string; points: number; count: number }[]> {
    const r = await this.db
      .prepare("SELECT kind, SUM(points) AS points, COUNT(*) AS count FROM points_ledger WHERE user_id = ? GROUP BY kind ORDER BY points DESC")
      .bind(userId)
      .all<Row>();
    return (r.results ?? []).map((p) => ({ kind: p.kind, points: p.points, count: p.count }));
  }

  // ── web push subscriptions ──────────────────────────────────────────────────
  async savePushSub(userId: string, sub: { endpoint: string; p256dh: string; auth: string }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .bind(ulid(), userId, sub.endpoint, sub.p256dh, sub.auth, nowIso())
      .run();
  }
  async listPushSubs(userId: string): Promise<Array<{ endpoint: string; p256dh: string; auth: string }>> {
    const r = await this.db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?").bind(userId).all<Row>();
    return (r.results ?? []).map((x) => ({ endpoint: x.endpoint, p256dh: x.p256dh, auth: x.auth }));
  }
  async deletePushSub(userId: string, endpoint: string): Promise<void> {
    await this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(endpoint, userId).run();
  }

  // ── AI networking agent settings ────────────────────────────────────────────
  async getAgentSettings(userId: string): Promise<{ enabled: boolean; mode: string; guardrails: Record<string, unknown>; hasAiKey: boolean; aiModel: string | null }> {
    const r = await this.db.prepare("SELECT networking_enabled, guardrails_json, ai_key, ai_model FROM agent_settings WHERE user_id = ?").bind(userId).first<Row>();
    const guardrails = safeJson(r?.guardrails_json);
    // NOTE: ai_key is deliberately NOT returned — only whether one exists.
    return { enabled: !!r?.networking_enabled, mode: (guardrails.mode as string) || "approve", guardrails, hasAiKey: !!r?.ai_key, aiModel: r?.ai_model ?? null };
  }

  /** Server-only: the actual OpenRouter key + model for making AI calls. */
  async getAiKey(userId: string): Promise<{ key: string | null; model: string | null }> {
    const r = await this.db.prepare("SELECT ai_key, ai_model FROM agent_settings WHERE user_id = ?").bind(userId).first<Row>();
    return { key: r?.ai_key ?? null, model: r?.ai_model ?? null };
  }

  /** Store (or clear, with null) the user's bring-your-own OpenRouter key. */
  async setAiKey(userId: string, key: string | null, model: string | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_settings (user_id, networking_enabled, guardrails_json, ai_key, ai_model, updated_at) VALUES (?, 0, '{}', ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET ai_key = excluded.ai_key, ai_model = excluded.ai_model, updated_at = excluded.updated_at`,
      )
      .bind(userId, key, model, nowIso())
      .run();
  }
  async setAgentSettings(userId: string, enabled: boolean, guardrails: Record<string, unknown>): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO agent_settings (user_id, networking_enabled, guardrails_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET networking_enabled = excluded.networking_enabled, guardrails_json = excluded.guardrails_json, updated_at = excluded.updated_at`,
      )
      .bind(userId, enabled ? 1 : 0, JSON.stringify(guardrails), nowIso())
      .run();
  }

  async grantAchievement(userId: string, kind: string, dedupKey: string, meta: Record<string, unknown> = {}): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO achievements (id, user_id, kind, dedup_key, meta_json, awarded_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(ulid(), userId, kind, dedupKey, JSON.stringify(meta), nowIso())
      .run();
  }

  // ── points (idempotent; shares the ledger with SocialRepo) ──────────────────
  private async award(userId: string, kind: keyof typeof POINTS, dedupKey: string, eventId?: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO points_ledger (id, user_id, kind, points, event_id, dedup_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(ulid(), userId, kind, POINTS[kind], eventId ?? null, dedupKey, nowIso())
      .run();
  }
}
