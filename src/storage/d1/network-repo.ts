import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import type { MemberTier, WorkerCapability } from "../../../shared/schema";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

export interface Member {
  userId: string;
  tier: MemberTier;
  vouchedBy: string | null;
  inviteId: string | null;
  /** Founded by config rather than by a handshake — the operator. A floor on `tier`. */
  founding: boolean;
  confirms: number;
  contradictions: number;
  distinctDays: number;
  /** Invitee contradictions charged to this member for vouching (weighted in core/net/trust). */
  vouchDebits: number;
  /** The decaying score, recomputed whenever the counters move. Orders the board. */
  trust: number;
  lastScoredAt: string | null;
  quarantinedAt: string | null;
  joinedAt: string;
}

export interface WorkerClientRow {
  id: string;
  userId: string;
  kind: string;
  label: string | null;
  capabilities: WorkerCapability[];
  egressAsn: number | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const toMember = (r: Row): Member => ({
  userId: r.user_id,
  tier: r.tier,
  vouchedBy: r.vouched_by ?? null,
  inviteId: r.invite_id ?? null,
  founding: !!r.founding,
  confirms: r.confirms ?? 0,
  contradictions: r.contradictions ?? 0,
  distinctDays: r.distinct_days ?? 0,
  vouchDebits: r.vouch_debits ?? 0,
  trust: r.trust ?? 0,
  lastScoredAt: r.last_scored_at ?? null,
  quarantinedAt: r.quarantined_at ?? null,
  joinedAt: r.joined_at,
});

const toClient = (r: Row): WorkerClientRow => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind,
  label: r.label ?? null,
  // Never surface token_hash. The token itself is shown once, at registration.
  capabilities: JSON.parse(r.capabilities_json || "[]"),
  egressAsn: r.egress_asn ?? null,
  lastSeenAt: r.last_seen_at ?? null,
  revokedAt: r.revoked_at ?? null,
  createdAt: r.created_at,
});

/**
 * Membership, invites and clients for the scrape network (migrations/0022).
 *
 * Thin by design — the interesting parts live elsewhere on purpose: the crypto and
 * the redemption policy are pure in `src/core/net/invite.ts`, and tier promotion is
 * pure in `src/core/net/trust.ts`. What CANNOT leave this class is `claimInvite`,
 * because single-use is a property of one atomic UPDATE and nothing above the SQL
 * can promise it.
 */
export class NetworkRepo {
  constructor(private db: D1Database) {}

  // ── membership ──────────────────────────────────────────────────────────────
  async member(userId: string): Promise<Member | null> {
    const r = await this.db.prepare("SELECT * FROM network_members WHERE user_id = ?").bind(userId).first<Row>();
    return r ? toMember(r) : null;
  }

  // ── invites ─────────────────────────────────────────────────────────────────
  /**
   * Open a handshake session, and close whatever the ambassador's screen was playing
   * before it. The revoke is the rotation: sessions are ~30s long and the display
   * rolls straight into the next one, so a frame list that leaked out of the previous
   * session is dead the moment the new one starts.
   *
   * Stores no secret — see the header of migrations/0023 and src/core/net/handshake.ts.
   */
  async openSession(
    ambassadorId: string,
    at: { lat: number; lng: number },
    s: { stepMs: number; framesRequired: number; startStep: number; endStep: number; expiresAt: string },
    atMs: number = Date.now(),
  ): Promise<{ sessionId: string }> {
    const ts = new Date(atMs).toISOString();
    await this.db
      .prepare("UPDATE network_invites SET revoked_at = ? WHERE ambassador_id = ? AND redeemed_at IS NULL AND revoked_at IS NULL")
      .bind(ts, ambassadorId)
      .run();

    const sessionId = ulid();
    await this.db
      .prepare(
        `INSERT INTO network_invites
           (id, ambassador_id, lat, lng, step_ms, frames_required, start_step, end_step, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(sessionId, ambassadorId, at.lat, at.lng, s.stepMs, s.framesRequired, s.startStep, s.endStep, s.expiresAt, ts)
      .run();
    return { sessionId };
  }

  async session(sessionId: string): Promise<Row | null> {
    return await this.db.prepare("SELECT * FROM network_invites WHERE id = ?").bind(sessionId).first<Row>();
  }

  /**
   * Take the session, or lose the race. This is the single-use guarantee for the
   * whole network, and it is one statement on purpose:
   *
   *   UPDATE … WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL
   *
   * A SELECT-then-INSERT would let two phones filming the same screen both observe an
   * unredeemed row and both proceed. Here the database picks exactly one winner and
   * the loser sees `changes === 0`.
   */
  async claimInvite(inviteId: string, joinerId: string, atMs: number = Date.now()): Promise<boolean> {
    const res: any = await this.db
      .prepare(
        `UPDATE network_invites SET redeemed_at = ?, redeemed_by = ?
          WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(new Date(atMs).toISOString(), joinerId, inviteId)
      .run();
    return (res?.meta?.changes ?? res?.changes ?? 0) === 1;
  }

  /** Record the membership the claimed invite bought. Probation, always. */
  async admit(userId: string, vouchedBy: string, inviteId: string, atMs: number = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO network_members (user_id, tier, vouched_by, invite_id, joined_at)
         VALUES (?, 'probation', ?, ?, ?)
         ON CONFLICT(user_id) DO NOTHING`,
      )
      .bind(userId, vouchedBy, inviteId, new Date(atMs).toISOString())
      .run();
  }

  // ── clients ─────────────────────────────────────────────────────────────────
  async registerClient(
    userId: string,
    c: { kind: string; label?: string; capabilities: WorkerCapability[] },
    tokenHash: string,
    atMs: number = Date.now(),
  ): Promise<string> {
    const id = ulid();
    await this.db
      .prepare(
        `INSERT INTO worker_clients (id, user_id, kind, label, capabilities_json, token_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, userId, c.kind, c.label ?? null, JSON.stringify(c.capabilities), tokenHash, new Date(atMs).toISOString())
      .run();
    return id;
  }

  async listClients(userId: string): Promise<WorkerClientRow[]> {
    const r = await this.db
      .prepare("SELECT * FROM worker_clients WHERE user_id = ? ORDER BY created_at DESC")
      .bind(userId)
      .all<Row>();
    return (r.results || []).map(toClient);
  }

  /** Resolve a presented worker token. Revoked clients resolve to null. */
  async clientByTokenHash(tokenHash: string): Promise<WorkerClientRow | null> {
    const r = await this.db
      .prepare("SELECT * FROM worker_clients WHERE token_hash = ? AND revoked_at IS NULL")
      .bind(tokenHash)
      .first<Row>();
    return r ? toClient(r) : null;
  }

  /** Scoped to the owner: someone else's client id is a 404, not a 403 — we don't
   *  confirm that an id exists to a caller with no business knowing. */
  async revokeClient(userId: string, clientId: string, atMs: number = Date.now()): Promise<boolean> {
    const res: any = await this.db
      .prepare("UPDATE worker_clients SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .bind(new Date(atMs).toISOString(), clientId, userId)
      .run();
    return (res?.meta?.changes ?? res?.changes ?? 0) === 1;
  }

  /** Remember where a client speaks from — hashed, and only so we can tell whether
   *  two workers share an egress and therefore aren't independent observers. */
  async touchClient(clientId: string, egress: { ipHash?: string | null; asn?: number | null }, atMs: number = Date.now()): Promise<void> {
    await this.db
      .prepare("UPDATE worker_clients SET last_seen_at = ?, egress_ip_hash = COALESCE(?, egress_ip_hash), egress_asn = COALESCE(?, egress_asn) WHERE id = ?")
      .bind(new Date(atMs).toISOString(), egress.ipHash ?? null, egress.asn ?? null, clientId)
      .run();
  }
}
