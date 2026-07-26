import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import { POINTS } from "../../../shared/schema";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

/**
 * GraphRepo — the founder graph: warm intros, mentors, co-founder/people matching,
 * and communities + rankings. State machines and "connect two people" logic live
 * here; every credit (intro made, etc.) is idempotent via the points ledger.
 */
export class GraphRepo {
  constructor(private db: D1Database) {}

  /**
   * Accepted friendship edges touching any of `ids`.
   *
   * CHUNKED, and it has to be: the natural form of this query is
   * `user_low IN (…) OR user_high IN (…)`, which binds the id list TWICE. D1
   * caps a statement at 100 bound parameters, so a user with ~50 connections
   * would 500 the network graph in production while every small-fixture test
   * passed. 45 per chunk keeps the doubled bind under the cap.
   */
  private async edgesTouching(ids: string[]): Promise<{ user_low: string; user_high: string }[]> {
    const out: { user_low: string; user_high: string }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < ids.length; i += 45) {
      const chunk = ids.slice(i, i + 45);
      const ph = chunk.map(() => "?").join(",");
      const r = await this.db
        .prepare(`SELECT user_low, user_high FROM friendships WHERE status = 'accepted' AND (user_low IN (${ph}) OR user_high IN (${ph}))`)
        .bind(...chunk, ...chunk)
        .all<{ user_low: string; user_high: string }>();
      for (const e of r.results ?? []) {
        const key = `${e.user_low}|${e.user_high}`;
        if (!seen.has(key)) { seen.add(key); out.push(e); }
      }
    }
    return out;
  }

  private async connect(a: string, b: string): Promise<void> {
    const [low, high] = a < b ? [a, b] : [b, a];
    const ts = nowIso();
    await this.db
      .prepare(
        `INSERT INTO friendships (user_low, user_high, status, requested_by, created_at, updated_at)
         VALUES (?, ?, 'accepted', ?, ?, ?)
         ON CONFLICT(user_low, user_high) DO UPDATE SET status='accepted', updated_at=excluded.updated_at
           WHERE friendships.status <> 'blocked'`,
      )
      .bind(low, high, a, ts, ts)
      .run();
  }
  private async award(userId: string, kind: keyof typeof POINTS, dedupKey: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO points_ledger (id, user_id, kind, points, dedup_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(ulid(), userId, kind, POINTS[kind], dedupKey, nowIso())
      .run();
  }
  private async grant(userId: string, kind: string, dedupKey: string): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO achievements (id, user_id, kind, dedup_key, meta_json, awarded_at) VALUES (?, ?, ?, ?, '{}', ?)")
      .bind(ulid(), userId, kind, dedupKey, nowIso())
      .run();
  }
  private async profile(userId: string): Promise<Row | null> {
    return this.db.prepare("SELECT id, display_name AS displayName, handle, avatar_key AS avatarKey FROM users WHERE id = ?").bind(userId).first<Row>();
  }

  // ── warm intros ─────────────────────────────────────────────────────────────
  async createIntroRequest(requesterId: string, r: { targetDesc: string; targetUserId?: string }): Promise<string> {
    const id = ulid();
    await this.db
      .prepare("INSERT INTO intro_requests (id, requester_id, target_desc, target_user_id, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)")
      .bind(id, requesterId, r.targetDesc, r.targetUserId ?? null, nowIso())
      .run();
    return id;
  }
  async myIntroRequests(userId: string): Promise<Array<{ id: string; targetDesc: string; status: string }>> {
    const res = await this.db
      .prepare("SELECT id, target_desc AS targetDesc, status FROM intro_requests WHERE requester_id = ? ORDER BY created_at DESC")
      .bind(userId)
      .all<Row>();
    return (res.results ?? []) as any;
  }
  /** Open requests where the connector is friends with BOTH the requester and the
   *  target — i.e. the connector can actually make the intro. */
  async connectorInbox(connectorId: string): Promise<Array<{ request: Row; requester: Row | null }>> {
    const res = await this.db
      .prepare(
        `SELECT r.id, r.requester_id, r.target_desc, r.target_user_id, r.status, r.created_at
         FROM intro_requests r
         WHERE r.status='open' AND r.requester_id <> ? AND r.target_user_id IS NOT NULL AND r.target_user_id <> ?
           AND EXISTS (SELECT 1 FROM friendships f WHERE f.status='accepted'
             AND ((f.user_low=? AND f.user_high=r.requester_id) OR (f.user_low=r.requester_id AND f.user_high=?)))
           AND EXISTS (SELECT 1 FROM friendships g WHERE g.status='accepted'
             AND ((g.user_low=? AND g.user_high=r.target_user_id) OR (g.user_low=r.target_user_id AND g.user_high=?)))
         ORDER BY r.created_at`,
      )
      .bind(connectorId, connectorId, connectorId, connectorId, connectorId, connectorId)
      .all<Row>();
    const out: Array<{ request: Row; requester: Row | null }> = [];
    for (const r of res.results ?? []) out.push({ request: r, requester: await this.profile(r.requester_id) });
    return out;
  }
  async forwardIntro(connectorId: string, requestId: string): Promise<string | null> {
    // Re-verify eligibility server-side: the request must be open with a target, and
    // the connector must actually be friends with BOTH the requester and the target.
    // (connectorInbox filters for display; this stops a forged forward from farming
    // intro credit or crashing on a bogus requestId's FK.)
    const eligible = await this.db
      .prepare(
        `SELECT 1 FROM intro_requests r
          WHERE r.id = ? AND r.status = 'open' AND r.target_user_id IS NOT NULL AND r.requester_id <> ? AND r.target_user_id <> ?
            AND EXISTS (SELECT 1 FROM friendships f WHERE f.status='accepted'
              AND ((f.user_low=? AND f.user_high=r.requester_id) OR (f.user_low=r.requester_id AND f.user_high=?)))
            AND EXISTS (SELECT 1 FROM friendships g WHERE g.status='accepted'
              AND ((g.user_low=? AND g.user_high=r.target_user_id) OR (g.user_low=r.target_user_id AND g.user_high=?)))`,
      )
      .bind(requestId, connectorId, connectorId, connectorId, connectorId, connectorId, connectorId)
      .first();
    if (!eligible) return null;
    const id = ulid();
    await this.db
      .prepare(
        `INSERT INTO intro_forwards (id, request_id, connector_id, status, created_at) VALUES (?, ?, ?, 'forwarded', ?)
         ON CONFLICT(request_id, connector_id) DO UPDATE SET status='forwarded'`,
      )
      .bind(id, requestId, connectorId, nowIso())
      .run();
    const row = await this.db.prepare("SELECT id FROM intro_forwards WHERE request_id=? AND connector_id=?").bind(requestId, connectorId).first<{ id: string }>();
    return row!.id;
  }
  /** The target accepts the intro → both are connected, the connector is credited. */
  /** Forwards addressed to me (I'm the target), awaiting my acceptance. This is the
   *  screen the target uses to complete a warm intro — without it, forwards dead-end. */
  async incomingForwards(userId: string): Promise<Array<{ forwardId: string; requestId: string; targetDesc: string; connector: Row | null; requester: Row | null }>> {
    const res = await this.db
      .prepare(
        `SELECT f.id AS forward_id, f.request_id, f.connector_id, r.requester_id, r.target_desc
           FROM intro_forwards f JOIN intro_requests r ON r.id = f.request_id
          WHERE r.target_user_id = ? AND f.status = 'forwarded' AND r.status = 'open'
          ORDER BY f.created_at`,
      )
      .bind(userId)
      .all<Row>();
    const out: Array<{ forwardId: string; requestId: string; targetDesc: string; connector: Row | null; requester: Row | null }> = [];
    for (const r of res.results ?? []) {
      out.push({ forwardId: r.forward_id, requestId: r.request_id, targetDesc: r.target_desc, connector: await this.profile(r.connector_id), requester: await this.profile(r.requester_id) });
    }
    return out;
  }

  async acceptIntro(userId: string, forwardId: string): Promise<"connected" | "forbidden" | "invalid"> {
    const f = await this.db.prepare("SELECT * FROM intro_forwards WHERE id = ?").bind(forwardId).first<Row>();
    if (!f) return "invalid";
    const r = await this.db.prepare("SELECT * FROM intro_requests WHERE id = ?").bind(f.request_id).first<Row>();
    if (!r || !r.target_user_id) return "invalid";
    if (r.target_user_id !== userId) return "forbidden";
    await this.db.batch([
      this.db.prepare("UPDATE intro_forwards SET status='accepted' WHERE id=?").bind(forwardId),
      this.db.prepare("UPDATE intro_requests SET status='matched' WHERE id=?").bind(r.id),
    ]);
    await this.connect(r.requester_id, r.target_user_id);
    await this.award(f.connector_id, "intro", `intro:${forwardId}`);
    await this.grant(f.connector_id, "intro_made", `intro_made:${forwardId}`);
    return "connected";
  }
  async introsMade(userId: string): Promise<number> {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM intro_forwards WHERE connector_id=? AND status='accepted'").bind(userId).first<{ n: number }>();
    return r?.n ?? 0;
  }

  /**
   * Warm intros on autopilot. For every connector who has the networking agent
   * enabled AND set to 'auto' mode, auto-forward each open intro request they're a
   * genuine mutual for (reusing {@link connectorInbox} eligibility) that they
   * haven't already forwarded. Idempotent via UNIQUE(request_id, connector_id).
   * Runs on the scheduled (cron) handler and can be triggered from the admin route.
   */
  async runIntroAutopilot(): Promise<{ forwarded: number; details: Array<{ connectorId: string; requestId: string; forwardId: string }> }> {
    const connectors = await this.db
      .prepare(`SELECT user_id FROM agent_settings WHERE networking_enabled = 1 AND json_extract(guardrails_json, '$.mode') = 'auto'`)
      .all<{ user_id: string }>();
    const details: Array<{ connectorId: string; requestId: string; forwardId: string }> = [];
    for (const { user_id: connectorId } of connectors.results ?? []) {
      const inbox = await this.connectorInbox(connectorId);
      for (const { request } of inbox) {
        const already = await this.db.prepare("SELECT 1 FROM intro_forwards WHERE request_id=? AND connector_id=?").bind(request.id, connectorId).first();
        if (already) continue; // never re-forward or double-count
        const forwardId = await this.forwardIntro(connectorId, request.id);
        if (forwardId) details.push({ connectorId, requestId: request.id, forwardId });
      }
    }
    return { forwarded: details.length, details };
  }

  // ── mentors ─────────────────────────────────────────────────────────────────
  async setMentorProfile(userId: string, p: { topics: string[]; availability?: string; blurb?: string; active?: boolean }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO mentor_profiles (user_id, topics_json, availability, blurb, active, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET topics_json=excluded.topics_json, availability=excluded.availability, blurb=excluded.blurb, active=excluded.active, updated_at=excluded.updated_at`,
      )
      .bind(userId, JSON.stringify(p.topics), p.availability ?? null, p.blurb ?? null, p.active === false ? 0 : 1, nowIso())
      .run();
  }
  async listMentors(topic?: string): Promise<Array<{ id: string; displayName: string; handle: string; topics: string[]; blurb: string | null }>> {
    const where = topic ? "AND EXISTS (SELECT 1 FROM json_each(mp.topics_json) WHERE value = ?)" : "";
    const stmt = this.db.prepare(
      `SELECT mp.user_id AS id, u.display_name AS displayName, u.handle, mp.topics_json, mp.blurb
       FROM mentor_profiles mp JOIN users u ON u.id = mp.user_id WHERE mp.active=1 ${where} ORDER BY mp.updated_at DESC`,
    );
    const res = await (topic ? stmt.bind(topic) : stmt).all<Row>();
    return (res.results ?? []).map((r) => ({ id: r.id, displayName: r.displayName, handle: r.handle, topics: JSON.parse(r.topics_json || "[]"), blurb: r.blurb ?? null }));
  }
  async requestMentor(menteeId: string, mentorId: string, message?: string): Promise<string> {
    const id = ulid();
    await this.db
      .prepare(
        `INSERT INTO mentor_requests (id, mentee_id, mentor_id, message, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(mentee_id, mentor_id) DO NOTHING`,
      )
      .bind(id, menteeId, mentorId, message ?? null, nowIso())
      .run();
    const row = await this.db.prepare("SELECT id FROM mentor_requests WHERE mentee_id=? AND mentor_id=?").bind(menteeId, mentorId).first<{ id: string }>();
    return row!.id;
  }
  async mentorInbox(mentorId: string): Promise<Array<{ id: string; mentee: Row | null; message: string | null }>> {
    const res = await this.db.prepare("SELECT id, mentee_id, message FROM mentor_requests WHERE mentor_id=? AND status='pending' ORDER BY created_at").bind(mentorId).all<Row>();
    const out = [];
    for (const r of res.results ?? []) out.push({ id: r.id, mentee: await this.profile(r.mentee_id), message: r.message ?? null });
    return out;
  }
  async respondMentorRequest(mentorId: string, requestId: string, accept: boolean): Promise<void> {
    const r = await this.db.prepare("SELECT * FROM mentor_requests WHERE id=? AND mentor_id=?").bind(requestId, mentorId).first<Row>();
    if (!r) return;
    await this.db.prepare("UPDATE mentor_requests SET status=? WHERE id=?").bind(accept ? "accepted" : "declined", requestId).run();
    if (accept) {
      await this.connect(r.mentee_id, mentorId);
      await this.award(mentorId, "mentor", `mentor:${requestId}`);
    }
  }

  // ── matching ────────────────────────────────────────────────────────────────
  async setMatchPrefs(userId: string, p: { hasIdea?: boolean; technical?: boolean; commitment?: string; radiusKm?: number; interests?: string[]; looking?: boolean }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO match_prefs (user_id, has_idea, technical, commitment, radius_km, interests_json, looking, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET has_idea=excluded.has_idea, technical=excluded.technical, commitment=excluded.commitment,
           radius_km=excluded.radius_km, interests_json=excluded.interests_json, looking=excluded.looking, updated_at=excluded.updated_at`,
      )
      .bind(
        userId,
        p.hasIdea == null ? null : p.hasIdea ? 1 : 0,
        p.technical == null ? null : p.technical ? 1 : 0,
        p.commitment ?? null,
        p.radiusKm ?? null,
        JSON.stringify(p.interests ?? []),
        p.looking ? 1 : 0,
        nowIso(),
      )
      .run();
  }
  async deck(userId: string): Promise<Array<{ id: string; displayName: string; handle: string; bio: string | null; technical: boolean; hasIdea: boolean; commitment: string | null }>> {
    const res = await this.db
      .prepare(
        `SELECT u.id, u.display_name AS displayName, u.handle, u.bio, mp.technical, mp.has_idea, mp.commitment
         FROM users u JOIN match_prefs mp ON mp.user_id = u.id
         WHERE u.id <> ? AND mp.looking = 1 AND u.social_enabled = 1
           AND u.id NOT IN (SELECT target_id FROM match_actions WHERE actor_id = ?)
         ORDER BY u.created_at`,
      )
      .bind(userId, userId)
      .all<Row>();
    return (res.results ?? []).map((r) => ({ id: r.id, displayName: r.displayName, handle: r.handle, bio: r.bio ?? null, technical: !!r.technical, hasIdea: !!r.has_idea, commitment: r.commitment ?? null })) as any;
  }
  async act(actorId: string, targetId: string, action: "invite" | "save" | "skip" | "hide"): Promise<{ matched: boolean }> {
    await this.db
      .prepare(
        `INSERT INTO match_actions (actor_id, target_id, action, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(actor_id, target_id) DO UPDATE SET action=excluded.action`,
      )
      .bind(actorId, targetId, action, nowIso())
      .run();
    if (action === "invite") {
      const recip = await this.db.prepare("SELECT 1 FROM match_actions WHERE actor_id=? AND target_id=? AND action='invite'").bind(targetId, actorId).first();
      if (recip) {
        await this.connect(actorId, targetId);
        return { matched: true };
      }
    }
    return { matched: false };
  }

  // ── communities + rankings ──────────────────────────────────────────────────
  async createCommunity(userId: string, name: string, kind?: string): Promise<string> {
    const id = ulid();
    const ts = nowIso();
    await this.db.batch([
      this.db.prepare("INSERT INTO communities (id, name, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, name, kind ?? null, userId, ts),
      this.db.prepare("INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)").bind(id, userId, ts),
    ]);
    return id;
  }
  async joinCommunity(userId: string, communityId: string): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").bind(communityId, userId, nowIso()).run();
  }
  async communityMembers(communityId: string): Promise<Row[]> {
    const res = await this.db
      .prepare("SELECT u.id, u.display_name AS displayName, u.handle FROM community_members m JOIN users u ON u.id=m.user_id WHERE m.community_id=? ORDER BY m.joined_at")
      .bind(communityId)
      .all<Row>();
    return res.results ?? [];
  }
  async myCommunities(userId: string): Promise<Array<{ id: string; name: string; kind: string | null }>> {
    const res = await this.db
      .prepare("SELECT c.id, c.name, c.kind FROM community_members m JOIN communities c ON c.id=m.community_id WHERE m.user_id=? ORDER BY c.created_at DESC")
      .bind(userId)
      .all<Row>();
    return (res.results ?? []) as any;
  }
  async community(communityId: string): Promise<{ id: string; name: string; kind: string | null } | null> {
    const r = await this.db.prepare("SELECT id, name, kind FROM communities WHERE id=?").bind(communityId).first<Row>();
    return r ? ({ id: r.id, name: r.name, kind: r.kind ?? null } as any) : null;
  }
  /** Same board as {@link rankings} but restricted to one community's members —
   *  the "per-community rankings" from the spec. Metric orders identically. */
  async communityRankings(communityId: string, metric: "intros" | "points" | "nps" = "points", limit = 50): Promise<Array<{ id: string; displayName: string; handle: string; intros: number; points: number; nps: number | null }>> {
    const order = metric === "intros" ? "intros DESC, points DESC" : metric === "nps" ? "nps DESC, points DESC" : "points DESC, intros DESC";
    const res = await this.db
      .prepare(
        `SELECT u.id, u.display_name AS displayName, u.handle,
           (SELECT COUNT(*) FROM intro_forwards f WHERE f.connector_id=u.id AND f.status='accepted') AS intros,
           COALESCE((SELECT SUM(points) FROM points_ledger p WHERE p.user_id=u.id), 0) AS points,
           (SELECT CASE WHEN COUNT(*)=0 THEN NULL
                   ELSE ROUND(100.0 * (SUM(CASE WHEN r.rating=5 THEN 1 ELSE 0 END) - SUM(CASE WHEN r.rating<=3 THEN 1 ELSE 0 END)) / COUNT(*)) END
            FROM reviews r JOIN events e ON e.id=r.event_id WHERE e.host_user_id=u.id) AS nps
         FROM community_members m JOIN users u ON u.id=m.user_id
         WHERE m.community_id=? AND u.social_enabled=1
         ORDER BY ${order} LIMIT ?`,
      )
      .bind(communityId, limit)
      .all<Row>();
    return (res.results ?? []).map((r) => ({ ...r, nps: r.nps == null ? null : Number(r.nps) })) as any;
  }

  /** Attendees of an event, annotated for the AI research brief: bio, whether
   *  they're already your friend, and how many mutual friends you share. */
  async eventResearchAttendees(userId: string, eventId: string): Promise<Array<{ id: string; displayName: string; handle: string; bio: string | null; isFriend: boolean; mutuals: number }>> {
    const att = await this.db
      .prepare(
        `SELECT u.id, u.display_name AS displayName, u.handle, u.bio
           FROM rsvps r JOIN users u ON u.id = r.user_id
          WHERE r.event_id = ? AND r.user_id != ? AND r.status IN ('going','interested','went') AND u.social_enabled = 1`,
      )
      .bind(eventId, userId)
      .all<Row>();
    const rows = (att.results ?? []).map((r) => ({ id: r.id, displayName: r.displayName, handle: r.handle, bio: r.bio ?? null, isFriend: false, mutuals: 0 }));
    if (rows.length === 0) return rows;

    const myFriends = new Set(
      ((await this.db.prepare(`SELECT CASE WHEN user_low = ? THEN user_high ELSE user_low END AS f FROM friendships WHERE (user_low = ? OR user_high = ?) AND status = 'accepted'`).bind(userId, userId, userId).all<{ f: string }>()).results ?? []).map((x) => x.f),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) if (myFriends.has(r.id)) r.isFriend = true;

    const ids = rows.map((r) => r.id);
    const edges = { results: await this.edgesTouching(ids) };
    for (const e of edges.results ?? []) {
      const candId = byId.has(e.user_low) ? e.user_low : byId.has(e.user_high) ? e.user_high : null;
      const friend = candId === e.user_low ? e.user_high : e.user_low;
      if (candId && myFriends.has(friend)) byId.get(candId)!.mutuals++;
    }
    return rows;
  }

  /** People to consider connecting with: attendees of your upcoming events who
   *  aren't already friends, annotated with shared-event and mutual-friend counts.
   *  Feeds the AI networking agent's suggestions. */
  async networkCandidates(userId: string, limit = 20): Promise<Array<{ id: string; displayName: string; handle: string; bio: string | null; sharedEvents: number; mutuals: number }>> {
    const cand = await this.db
      .prepare(
        `WITH my_events AS (
           SELECT event_id FROM rsvps WHERE user_id = ? AND status IN ('going','interested','went')
         )
         SELECT u.id, u.display_name AS displayName, u.handle, u.bio, COUNT(*) AS sharedEvents
           FROM rsvps r
           JOIN my_events me ON me.event_id = r.event_id
           JOIN users u ON u.id = r.user_id
          WHERE r.user_id != ? AND u.social_enabled = 1
            AND r.user_id NOT IN (
              SELECT CASE WHEN user_low = ? THEN user_high ELSE user_low END
                FROM friendships WHERE (user_low = ? OR user_high = ?) AND status = 'accepted'
            )
          GROUP BY u.id
          ORDER BY sharedEvents DESC
          LIMIT ?`,
      )
      .bind(userId, userId, userId, userId, userId, limit)
      .all<Row>();
    const rows = (cand.results ?? []).map((r) => ({ id: r.id, displayName: r.displayName, handle: r.handle, bio: r.bio ?? null, sharedEvents: Number(r.sharedEvents) || 0, mutuals: 0 }));
    if (rows.length === 0) return rows;

    // mutual-friend counts: my friends ∩ each candidate's friends
    const myFriends = new Set(
      ((await this.db.prepare(`SELECT CASE WHEN user_low = ? THEN user_high ELSE user_low END AS f FROM friendships WHERE (user_low = ? OR user_high = ?) AND status = 'accepted'`).bind(userId, userId, userId).all<{ f: string }>()).results ?? []).map((x) => x.f),
    );
    const ids = rows.map((r) => r.id);
    const edges = { results: await this.edgesTouching(ids) };
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const e of edges.results ?? []) {
      const [a, b] = [e.user_low, e.user_high];
      const candId = byId.has(a) ? a : byId.has(b) ? b : null;
      const friend = candId === a ? b : a;
      if (candId && myFriends.has(friend)) byId.get(candId)!.mutuals++;
    }
    return rows;
  }

  /** Your ego network: you + friends + the friendship edges among them. Powers the
   *  interactive network-graph visualization. */
  async networkGraph(userId: string): Promise<{ nodes: any[]; edges: any[] }> {
    const fr = await this.db
      .prepare(`SELECT CASE WHEN user_low=? THEN user_high ELSE user_low END AS id FROM friendships WHERE (user_low=? OR user_high=?) AND status='accepted'`)
      .bind(userId, userId, userId)
      .all<{ id: string }>();
    const uniq = [...new Set([userId, ...(fr.results ?? []).map((r) => r.id)])];
    const ph = uniq.map(() => "?").join(",");
    const nodesRes = await this.db.prepare(`SELECT id, display_name AS name, handle FROM users WHERE id IN (${ph})`).bind(...uniq).all<Row>();
    // Both sides must be inside the ego-net, so filter the chunked result rather
    // than binding `uniq` twice in one statement (see edgesTouching).
    const inNet = new Set(uniq);
    const edgesRes = {
      results: (await this.edgesTouching(uniq))
        .filter((e) => inNet.has(e.user_low) && inNet.has(e.user_high))
        .map((e) => ({ a: e.user_low, b: e.user_high })),
    };
    return {
      nodes: (nodesRes.results ?? []).map((n) => ({ id: n.id, name: n.name, handle: n.handle, me: n.id === userId })),
      edges: edgesRes.results ?? [],
    };
  }

  /** Global rankings by `intros` made or total `points`. */
  async rankings(metric: "intros" | "points" | "nps" = "points", limit = 50): Promise<Array<{ id: string; displayName: string; handle: string; intros: number; points: number; nps: number | null }>> {
    const order = metric === "intros" ? "intros DESC, points DESC" : metric === "nps" ? "nps DESC, points DESC" : "points DESC, intros DESC";
    // NPS across the events a person HOSTED: %promoters(5★) − %detractors(≤3★), −100…100.
    const res = await this.db
      .prepare(
        `SELECT u.id, u.display_name AS displayName, u.handle,
           (SELECT COUNT(*) FROM intro_forwards f WHERE f.connector_id=u.id AND f.status='accepted') AS intros,
           COALESCE((SELECT SUM(points) FROM points_ledger p WHERE p.user_id=u.id), 0) AS points,
           (SELECT CASE WHEN COUNT(*)=0 THEN NULL
                   ELSE ROUND(100.0 * (SUM(CASE WHEN r.rating=5 THEN 1 ELSE 0 END) - SUM(CASE WHEN r.rating<=3 THEN 1 ELSE 0 END)) / COUNT(*)) END
            FROM reviews r JOIN events e ON e.id=r.event_id WHERE e.host_user_id=u.id) AS nps
         FROM users u WHERE u.social_enabled=1
         ORDER BY ${order} LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return (res.results ?? []).map((r) => ({ ...r, nps: r.nps == null ? null : Number(r.nps) })) as any;
  }
}
