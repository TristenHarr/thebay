import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import { hash128 } from "../../core/util/hash";
import type { User, PublicProfile, ProfileUpdate, RsvpStatus, HostEvent, PointKind } from "../../../shared/schema";
import { POINTS } from "../../../shared/schema";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const nowIso = () => new Date().toISOString();

function rowToUser(r: Row): User {
  return {
    id: r.id,
    email: r.email,
    handle: r.handle,
    displayName: r.display_name,
    avatarKey: r.avatar_key ?? null,
    bio: r.bio ?? null,
    homeCity: r.home_city ?? null,
    socialEnabled: !!r.social_enabled,
    createdAt: r.created_at,
  };
}
const toPublic = (u: User): PublicProfile => {
  const { email: _drop, ...rest } = u;
  void _drop;
  return rest;
};
/** ordered friendship pair so A↔B is always one row */
const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/**
 * SocialRepository — every user/social read+write on D1. Kept separate from the
 * event-pipeline Repository. All invariants that the schema can't express alone
 * (friendship normalization, review gating, idempotent points) live here.
 */
export class SocialRepo {
  constructor(private db: D1Database) {}

  // ── users & identity ──────────────────────────────────────────────────────
  async getUserById(id: string): Promise<User | null> {
    const r = await this.db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<Row>();
    return r ? rowToUser(r) : null;
  }
  async getUserByHandle(handle: string): Promise<User | null> {
    const r = await this.db.prepare("SELECT * FROM users WHERE handle = ?").bind(handle.toLowerCase()).first<Row>();
    return r ? rowToUser(r) : null;
  }
  /** Any user with this email, any provider (case-insensitive). Used to stop
   *  password-register from attaching to a pre-existing account (takeover guard). */
  async findByEmail(email: string): Promise<User | null> {
    const r = await this.db.prepare("SELECT * FROM users WHERE lower(email) = lower(?)").bind(email).first<Row>();
    return r ? rowToUser(r) : null;
  }

  // ── password credentials (self-contained email+password login) ───────────────
  async setPasswordCredential(userId: string, email: string, h: { salt: string; hash: string; iterations: number }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO password_credentials (user_id, email, salt, hash, iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, salt = excluded.salt, hash = excluded.hash, iterations = excluded.iterations`,
      )
      .bind(userId, email.toLowerCase(), h.salt, h.hash, h.iterations, nowIso())
      .run();
  }
  async getPasswordCredential(email: string): Promise<{ userId: string; salt: string; hash: string; iterations: number } | null> {
    const r = await this.db.prepare("SELECT user_id, salt, hash, iterations FROM password_credentials WHERE email = ?").bind(email.toLowerCase()).first<Row>();
    return r ? { userId: r.user_id, salt: r.salt, hash: r.hash, iterations: r.iterations } : null;
  }

  private async uniqueHandle(seed: string): Promise<string> {
    let base = (seed || "user").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 16) || "user";
    if (base.length < 3) base = `${base}${Math.floor(hash128(base).length)}`.slice(0, 16);
    for (let i = 0; i < 50; i++) {
      const cand = i === 0 ? base : `${base}${i}`.slice(0, 20);
      const hit = await this.db.prepare("SELECT 1 FROM users WHERE handle = ?").bind(cand).first();
      if (!hit) return cand;
    }
    return `${base}${ulid().slice(-4).toLowerCase()}`;
  }

  /** Find the user for an OAuth identity, or create one (first login). */
  async upsertByIdentity(input: {
    provider: string;
    providerUid: string;
    email: string;
    displayName: string;
    emailVerified?: boolean;
  }): Promise<User> {
    const found = await this.db
      .prepare("SELECT user_id FROM identities WHERE provider = ? AND provider_uid = ?")
      .bind(input.provider, input.providerUid)
      .first<{ user_id: string }>();
    if (found) return (await this.getUserById(found.user_id))!;

    // link to an existing user with the same email, else create a new user
    const existing = await this.db.prepare("SELECT * FROM users WHERE email = ?").bind(input.email).first<Row>();
    let user: User;
    const ts = nowIso();
    if (existing) {
      user = rowToUser(existing);
    } else {
      const id = ulid();
      const handle = await this.uniqueHandle(input.email.split("@")[0] || input.displayName);
      await this.db
        .prepare(
          `INSERT INTO users (id, email, email_verified, handle, display_name, social_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .bind(id, input.email, input.emailVerified ? 1 : 0, handle, input.displayName || handle, ts, ts)
        .run();
      user = (await this.getUserById(id))!;
    }
    await this.db
      .prepare(`INSERT OR IGNORE INTO identities (user_id, provider, provider_uid, created_at) VALUES (?, ?, ?, ?)`)
      .bind(user.id, input.provider, input.providerUid, ts)
      .run();
    return user;
  }

  async updateProfile(userId: string, patch: ProfileUpdate & { avatarKey?: string }): Promise<User | null> {
    const sets: string[] = [];
    const vals: any[] = [];
    const map: Record<string, any> = {
      display_name: patch.displayName,
      handle: patch.handle?.toLowerCase(),
      bio: patch.bio,
      home_city: patch.homeCity,
      social_enabled: patch.socialEnabled === undefined ? undefined : patch.socialEnabled ? 1 : 0,
      avatar_key: patch.avatarKey,
    };
    for (const [col, v] of Object.entries(map)) {
      if (v !== undefined) { sets.push(`${col} = ?`); vals.push(v); }
    }
    if (sets.length) {
      sets.push("updated_at = ?"); vals.push(nowIso());
      vals.push(userId);
      await this.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
    }
    return this.getUserById(userId);
  }

  // ── RSVPs ─────────────────────────────────────────────────────────────────
  async setRsvp(userId: string, eventId: string, status: RsvpStatus): Promise<void> {
    if (status === "none") {
      await this.db.prepare("DELETE FROM rsvps WHERE user_id = ? AND event_id = ?").bind(userId, eventId).run();
      return;
    }
    await this.db
      .prepare(
        `INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, event_id) DO UPDATE SET status = excluded.status`,
      )
      .bind(userId, eventId, status, nowIso())
      .run();
    if (status === "going" || status === "went") {
      await this.awardPoints(userId, "rsvp", `rsvp:${userId}:${eventId}`, eventId);
    }
  }
  async getRsvp(userId: string, eventId: string): Promise<RsvpStatus> {
    const r = await this.db.prepare("SELECT status FROM rsvps WHERE user_id = ? AND event_id = ?").bind(userId, eventId).first<{ status: RsvpStatus }>();
    return r?.status ?? "none";
  }
  async attendees(eventId: string, limit = 100): Promise<PublicProfile[]> {
    const res = await this.db
      .prepare(
        `SELECT u.* FROM rsvps r JOIN users u ON u.id = r.user_id
         WHERE r.event_id = ? AND r.status IN ('going','went') AND u.social_enabled = 1
         ORDER BY r.created_at DESC LIMIT ?`,
      )
      .bind(eventId, limit)
      .all<Row>();
    return (res.results ?? []).map((r) => toPublic(rowToUser(r)));
  }
  /** events my friends are going to (for the feed + the map). */
  async friendsAttending(userId: string, eventId: string): Promise<PublicProfile[]> {
    const res = await this.db
      .prepare(
        `SELECT u.* FROM rsvps r JOIN users u ON u.id = r.user_id
         WHERE r.event_id = ? AND r.status IN ('going','went') AND u.social_enabled = 1
           AND u.id IN (${FRIEND_IDS_SQL})`,
      )
      .bind(eventId, userId, userId, userId)
      .all<Row>();
    return (res.results ?? []).map((r) => toPublic(rowToUser(r)));
  }
  /** eventIds any of my friends are going to (upcoming). */
  async friendEventIds(userId: string): Promise<Array<{ eventId: string; friends: PublicProfile[] }>> {
    const res = await this.db
      .prepare(
        `SELECT r.event_id AS event_id, u.* FROM rsvps r JOIN users u ON u.id = r.user_id
         WHERE r.status IN ('going','went') AND u.social_enabled = 1 AND u.id IN (${FRIEND_IDS_SQL})`,
      )
      .bind(userId, userId, userId)
      .all<Row>();
    const byEvent = new Map<string, PublicProfile[]>();
    for (const r of res.results ?? []) {
      const list = byEvent.get(r.event_id) ?? [];
      list.push(toPublic(rowToUser(r)));
      byEvent.set(r.event_id, list);
    }
    return [...byEvent.entries()].map(([eventId, friends]) => ({ eventId, friends }));
  }

  // ── friendships ─────────────────────────────────────────────────────────
  async requestFriend(from: string, to: string): Promise<void> {
    if (from === to) return;
    const [low, high] = pair(from, to);
    const ts = nowIso();
    await this.db
      .prepare(
        `INSERT INTO friendships (user_low, user_high, status, requested_by, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?, ?)
         ON CONFLICT(user_low, user_high) DO NOTHING`,
      )
      .bind(low, high, from, ts, ts)
      .run();
  }
  async respondFriend(me: string, other: string, accept: boolean): Promise<void> {
    const [low, high] = pair(me, other);
    if (accept) {
      await this.db
        .prepare(`UPDATE friendships SET status='accepted', updated_at=? WHERE user_low=? AND user_high=? AND status='pending' AND requested_by != ?`)
        .bind(nowIso(), low, high, me)
        .run();
    } else {
      await this.db.prepare(`DELETE FROM friendships WHERE user_low=? AND user_high=?`).bind(low, high).run();
    }
  }
  async friendStatus(me: string, other: string): Promise<{ status: string; incoming: boolean } | null> {
    const [low, high] = pair(me, other);
    const r = await this.db.prepare("SELECT status, requested_by FROM friendships WHERE user_low=? AND user_high=?").bind(low, high).first<Row>();
    if (!r) return null;
    return { status: r.status, incoming: r.requested_by !== me };
  }
  async listFriends(userId: string): Promise<PublicProfile[]> {
    const res = await this.db
      .prepare(`SELECT u.* FROM users u WHERE u.social_enabled = 1 AND u.id IN (${FRIEND_IDS_SQL}) ORDER BY u.display_name`)
      .bind(userId, userId, userId)
      .all<Row>();
    return (res.results ?? []).map((r) => toPublic(rowToUser(r)));
  }
  async pendingRequests(userId: string): Promise<PublicProfile[]> {
    const res = await this.db
      .prepare(
        `SELECT u.* FROM friendships f
           JOIN users u ON u.id = CASE WHEN f.user_low = ? THEN f.user_high ELSE f.user_low END
         WHERE (f.user_low = ? OR f.user_high = ?) AND f.status='pending' AND f.requested_by != ?`,
      )
      .bind(userId, userId, userId, userId)
      .all<Row>();
    return (res.results ?? []).map((r) => toPublic(rowToUser(r)));
  }

  // ── groups & messages ─────────────────────────────────────────────────────
  async createGroup(userId: string, name: string, eventId?: string): Promise<string> {
    const id = ulid();
    const ts = nowIso();
    await this.db.batch([
      this.db.prepare("INSERT INTO groups (id, event_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, eventId ?? null, name, userId, ts),
      this.db.prepare("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)").bind(id, userId, ts),
    ]);
    return id;
  }
  async joinGroup(userId: string, groupId: string): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").bind(groupId, userId, nowIso()).run();
  }
  async isMember(userId: string, groupId: string): Promise<boolean> {
    return !!(await this.db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").bind(groupId, userId).first());
  }
  async myGroups(userId: string): Promise<Array<{ id: string; name: string; eventId: string | null; members: number }>> {
    const res = await this.db
      .prepare(
        `SELECT g.id, g.name, g.event_id AS eventId,
           (SELECT COUNT(*) FROM group_members m2 WHERE m2.group_id = g.id) AS members
         FROM groups g JOIN group_members m ON m.group_id = g.id
         WHERE m.user_id = ? ORDER BY g.created_at DESC`,
      )
      .bind(userId)
      .all<Row>();
    return (res.results ?? []).map((r) => ({ id: r.id, name: r.name, eventId: r.eventId ?? null, members: r.members }));
  }
  async groupMembers(groupId: string): Promise<PublicProfile[]> {
    const res = await this.db
      .prepare("SELECT u.* FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.joined_at")
      .bind(groupId)
      .all<Row>();
    return (res.results ?? []).map((r) => toPublic(rowToUser(r)));
  }
  async addMessage(groupId: string, userId: string, body: string): Promise<{ id: string; createdAt: string }> {
    const id = ulid();
    const createdAt = nowIso();
    await this.db.prepare("INSERT INTO messages (id, group_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, groupId, userId, body, createdAt).run();
    return { id, createdAt };
  }
  async recentMessages(groupId: string, limit = 50): Promise<Array<{ id: string; userId: string; body: string; createdAt: string; author: string }>> {
    const res = await this.db
      .prepare(
        `SELECT m.id, m.user_id AS userId, m.body, m.created_at AS createdAt, u.display_name AS author
         FROM messages m JOIN users u ON u.id = m.user_id WHERE m.group_id = ?
         ORDER BY m.created_at DESC LIMIT ?`,
      )
      .bind(groupId, limit)
      .all<Row>();
    return (res.results ?? []).reverse() as any;
  }

  // ── reviews & photos ──────────────────────────────────────────────────────
  /** Reviews are gated to attendees (went, or going to a past event). */
  async canReview(userId: string, eventId: string): Promise<boolean> {
    const r = await this.db
      .prepare(
        `SELECT r.status, e.start_utc FROM rsvps r JOIN events e ON e.id = r.event_id
         WHERE r.user_id = ? AND r.event_id = ?`,
      )
      .bind(userId, eventId)
      .first<{ status: string; start_utc: string }>();
    if (r) {
      if (r.status === "went") return true;
      if (r.status === "going" && new Date(r.start_utc).getTime() < Date.now()) return true;
    }
    // A QR check-in also proves attendance (and is what opens the review-gate obligation).
    const c = await this.db.prepare("SELECT 1 FROM checkins WHERE user_id = ? AND event_id = ?").bind(userId, eventId).first();
    return !!c;
  }
  async addReview(userId: string, eventId: string, rating: number, body?: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO reviews (id, event_id, user_id, rating, body, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id, user_id) DO UPDATE SET rating=excluded.rating, body=excluded.body`,
      )
      .bind(ulid(), eventId, userId, rating, body ?? null, nowIso())
      .run();
    await this.awardPoints(userId, "review", `review:${userId}:${eventId}`, eventId);
  }
  async reviews(eventId: string): Promise<Array<{ rating: number; body: string | null; author: string; createdAt: string }>> {
    const res = await this.db
      .prepare(
        `SELECT r.rating, r.body, r.created_at AS createdAt, u.display_name AS author
         FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? ORDER BY r.created_at DESC`,
      )
      .bind(eventId)
      .all<Row>();
    return (res.results ?? []) as any;
  }
  async addPhoto(userId: string, eventId: string, r2Key: string, caption?: string): Promise<void> {
    await this.db.prepare("INSERT INTO event_photos (id, event_id, user_id, r2_key, caption, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(ulid(), eventId, userId, r2Key, caption ?? null, nowIso()).run();
    // Points are idempotent per event (dedup key = user+event), so uploading many
    // photos to one event earns the 15 once — no farming.
    await this.awardPoints(userId, "photo", `photo:${userId}:${eventId}`, eventId);
  }
  async photos(eventId: string): Promise<Array<{ key: string; caption: string | null; author: string }>> {
    const res = await this.db
      .prepare(
        `SELECT p.r2_key AS key, p.caption, u.display_name AS author
         FROM event_photos p JOIN users u ON u.id = p.user_id WHERE p.event_id = ? ORDER BY p.created_at DESC`,
      )
      .bind(eventId)
      .all<Row>();
    return (res.results ?? []) as any;
  }

  // ── hosting ───────────────────────────────────────────────────────────────
  async createHostedEvent(userId: string, input: HostEvent): Promise<string> {
    const id = ulid();
    const ts = nowIso();
    const city = input.city || "sf-bay";
    const fingerprint = "host:" + hash128(`${input.title}|${input.startUtc}|${userId}`);
    await this.db
      .prepare(
        `INSERT INTO events (
           id, fingerprint, title, description, start_utc, end_utc, timezone, venue_name,
           address, city, url, organizer, is_free, price_text, image_url, categories,
           content_hash, sources_json, host_user_id, first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'America/Los_Angeles', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
      )
      .bind(
        id, fingerprint, input.title, input.description ?? null, input.startUtc, input.endUtc ?? null,
        input.venueName ?? null, input.address ?? null, city,
        input.url ?? `https://thebay.events/app/event/${id}`,
        null, input.isFree == null ? null : input.isFree ? 1 : 0, input.priceText ?? null,
        input.imageUrl ?? null, JSON.stringify(input.categories ?? ["tech"]), fingerprint, userId, ts, ts,
      )
      .run();
    await this.awardPoints(userId, "host", `host:${id}`, id);
    return id;
  }
  async eventHost(eventId: string): Promise<PublicProfile | null> {
    const r = await this.db
      .prepare("SELECT u.* FROM events e JOIN users u ON u.id = e.host_user_id WHERE e.id = ?")
      .bind(eventId)
      .first<Row>();
    return r ? toPublic(rowToUser(r)) : null;
  }

  // ── points & leaderboard ──────────────────────────────────────────────────
  /** Sole writer of points. dedup_key UNIQUE ⇒ awarding twice is a no-op. */
  async awardPoints(userId: string, kind: PointKind, dedupKey: string, eventId?: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO points_ledger (id, user_id, kind, points, event_id, dedup_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(ulid(), userId, kind, POINTS[kind], eventId ?? null, dedupKey, nowIso())
      .run();
  }
  async myPoints(userId: string): Promise<number> {
    const r = await this.db.prepare("SELECT COALESCE(SUM(points),0) AS n FROM points_ledger WHERE user_id = ?").bind(userId).first<{ n: number }>();
    return r?.n ?? 0;
  }
  async leaderboard(limit = 50, friendOf?: string): Promise<Array<PublicProfile & { points: number }>> {
    const sql = friendOf
      ? `SELECT u.*, COALESCE(SUM(p.points),0) AS points FROM users u
         LEFT JOIN points_ledger p ON p.user_id = u.id
         WHERE u.social_enabled = 1 AND (u.id = ? OR u.id IN (${FRIEND_IDS_SQL}))
         GROUP BY u.id ORDER BY points DESC LIMIT ?`
      : `SELECT u.*, COALESCE(SUM(p.points),0) AS points FROM users u
         LEFT JOIN points_ledger p ON p.user_id = u.id
         WHERE u.social_enabled = 1 GROUP BY u.id ORDER BY points DESC LIMIT ?`;
    const stmt = friendOf
      ? this.db.prepare(sql).bind(friendOf, friendOf, friendOf, friendOf, limit)
      : this.db.prepare(sql).bind(limit);
    const res = await stmt.all<Row>();
    return (res.results ?? []).map((r) => ({ ...toPublic(rowToUser(r)), points: r.points }));
  }
}

/** Subquery yielding the accepted-friend ids of a user. Bind the user id 3×
 *  (low-side, high-side, and the accepted filter shares the same two binds). */
const FRIEND_IDS_SQL = `
  SELECT CASE WHEN user_low = ? THEN user_high ELSE user_low END
  FROM friendships WHERE (user_low = ? OR user_high = ?) AND status = 'accepted'`;
