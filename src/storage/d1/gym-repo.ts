import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import { XpRepo } from "./xp-repo";
import { gymBudget, recipientCap, type Budget, type HostStanding } from "../../core/gym/budget";
import { creditedMinutes, dwellMultiplier } from "../../core/gym/dwell";
import { canArm, canAward, canSettle, parseBounties, serializeBounties, type BountySpec, type GymFacts, type GymMode } from "../../core/gym/policy";
import { DOOR_MAX_USES, DOOR_TTL_MS } from "../../core/gym/presence";
import type { EventWindow } from "../../core/gym/window";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();
const changes = (r: any): number => r?.meta?.changes ?? r?.changes ?? 0;

/** 30 days, in ms — the rolling window `HOST_WINDOW_CAP` applies over. */
const WINDOW_MS = 30 * 86_400_000;

export interface Gym extends GymFacts {
  eventId: string;
  hostId: string | null;
  /** Snapshotted per-recipient ceiling. Frozen at arm time by the terms trigger, so it
   *  cannot be raised mid-event. Tighter than `gym_awards.xp`'s schema CHECK. */
  recipientCap: number;
  armedAt: string | null;
  settledAt: string | null;
  createdAt: string;
}

export interface GymAward {
  id: string;
  eventId: string;
  userId: string;
  hostId: string | null;
  bountyKey: string;
  xp: number;
  note: string | null;
  awardedAt: string;
  displayName?: string;
  handle?: string;
}

export interface RosterRow {
  userId: string;
  displayName: string;
  handle: string;
  firstAt: string;
  lastAt: string;
  scans: number;
  /** Minutes credited after the floor and the event-length cap. */
  dwellMinutes: number;
  /** 0..1 — what that dwell is worth. */
  dwellMultiplier: number;
  /** XP this host has already given this person at THIS gym. */
  awarded: number;
  /** How many times this host has EVER paid this person, across all gyms. */
  priorAwards: number;
  /** The most this host may still give them here, dwell and halving applied. */
  remainingCap: number;
}

export type AwardResult =
  | "ok"
  | "over_budget"
  | "not_present"
  | "not_armed"
  | "already_settled"
  | "over_cap"
  | "self"
  | "duplicate"
  | "outside_window"
  | "no_budget";

const toGym = (r: Row): Gym => ({
  eventId: r.event_id,
  hostId: r.host_id ?? null,
  mode: r.mode as GymMode,
  flatXp: Number(r.flat_xp ?? 0),
  bounties: parseBounties(r.bounties_json),
  budget: Number(r.budget ?? 0),
  spent: Number(r.spent ?? 0),
  recipientCap: Number(r.recipient_cap ?? 0),
  status: r.status,
  armedAt: r.armed_at ?? null,
  settledAt: r.settled_at ?? null,
  createdAt: r.created_at,
});

const toAward = (r: Row): GymAward => ({
  id: r.id,
  eventId: r.event_id,
  userId: r.user_id,
  hostId: r.host_id ?? null,
  bountyKey: r.bounty_key ?? "",
  xp: Number(r.xp),
  note: r.note ?? null,
  awardedAt: r.awarded_at,
  ...(r.display_name ? { displayName: r.display_name, handle: r.handle } : {}),
});

/**
 * Gyms — the host-as-mint machinery (migrations/0028).
 *
 * Thin where it can be, because the interesting parts are deliberately elsewhere: the
 * economy is pure in `src/core/gym/budget.ts`, the rules and state machine in `policy.ts`,
 * the door policy in `presence.ts`, and every invariant that is a property of a row is in
 * the schema itself.
 *
 * Two things CANNOT leave this class:
 *
 *  · **`claimDoorUse`** — the use ceiling is a property of one atomic UPDATE. A
 *    SELECT-then-UPDATE would let two phones filming the same screen both observe an
 *    unspent code and both proceed. `NetworkRepo.claimInvite`'s guarantee, counted to N.
 *  · **the award/void ordering in `revokeAward`** — the compensating ledger row must be
 *    written BEFORE the award row is removed, so a half-completed revoke leaves an award
 *    with no XP (recoverable) rather than minted XP with no provenance (not).
 */
export class GymRepo {
  constructor(private db: D1Database) {}

  // ── the gym ─────────────────────────────────────────────────────────────────
  async gym(eventId: string): Promise<Gym | null> {
    const r = await this.db.prepare("SELECT * FROM event_gyms WHERE event_id = ?").bind(eventId).first<Row>();
    return r ? toGym(r) : null;
  }

  /** The event's time window — what `policy.ts` and `presence.ts` judge timestamps against. */
  async window(eventId: string): Promise<EventWindow | null> {
    const r = await this.db.prepare("SELECT start_utc, end_utc FROM events WHERE id = ?").bind(eventId).first<Row>();
    return r ? { startUtc: r.start_utc, endUtc: r.end_utc ?? null } : null;
  }

  /**
   * Create or edit the draft. Terms are frozen by trigger once armed, so this is
   * write-once-then-read-only from the host's point of view — the UPDATE simply throws
   * after arming, which is the correct answer.
   */
  async upsertDraft(
    eventId: string,
    hostId: string,
    p: { mode: GymMode; flatXp: number; bounties: BountySpec[] },
    atIso: string = nowIso(),
  ): Promise<Gym> {
    await this.db
      .prepare(
        `INSERT INTO event_gyms (event_id, host_id, mode, flat_xp, bounties_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?)
         ON CONFLICT(event_id) DO UPDATE SET
           mode = excluded.mode, flat_xp = excluded.flat_xp, bounties_json = excluded.bounties_json`,
      )
      .bind(eventId, hostId, p.mode, Math.max(0, Math.floor(p.flatXp || 0)), serializeBounties(p.bounties), atIso)
      .run();
    await this.syncBudget(eventId, atIso).catch(() => undefined); // a fresh gym has no attendees yet
    return (await this.gym(eventId))!;
  }

  /** draft → armed. Guarded UPDATE, so two concurrent arms produce one winner. */
  async arm(eventId: string, atIso: string = nowIso()): Promise<boolean> {
    const res = await this.db
      .prepare("UPDATE event_gyms SET status = 'armed', armed_at = ? WHERE event_id = ? AND status = 'draft'")
      .bind(atIso, eventId)
      .run();
    return changes(res) === 1;
  }

  /** armed → settled. Closes the ledger; the triggers make it immutable from here. */
  async settle(eventId: string, atIso: string = nowIso()): Promise<boolean> {
    const res = await this.db
      .prepare("UPDATE event_gyms SET status = 'settled', settled_at = ? WHERE event_id = ? AND status = 'armed'")
      .bind(atIso, eventId)
      .run();
    return changes(res) === 1;
  }

  async verifiedAttendees(eventId: string): Promise<number> {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM event_presence WHERE event_id = ?").bind(eventId).first<Row>();
    return Number(r?.n ?? 0);
  }

  /**
   * Everything `standingMultiplier` needs, in one query.
   *
   * `nps` is the same expression `GraphRepo.rankings` uses — %5★ − %≤3★ over reviews of
   * events this person hosted. It is duplicated in two places already; consolidating all
   * three is worth doing, but not inside this change.
   */
  async hostStanding(hostId: string, atMs: number = Date.now()): Promise<HostStanding> {
    const since = new Date(atMs - WINDOW_MS).toISOString();
    const r = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM event_gyms WHERE host_id = ? AND status = 'settled')                    AS settled_gyms,
           (SELECT COALESCE(SUM(xp),0) FROM gym_awards WHERE host_id = ? AND awarded_at >= ?)            AS minted,
           (SELECT COUNT(*) FROM reviews r JOIN events e ON e.id = r.event_id WHERE e.host_user_id = ?)  AS review_count,
           (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                   ELSE ROUND(100.0 * (SUM(CASE WHEN r.rating = 5 THEN 1 ELSE 0 END)
                                     - SUM(CASE WHEN r.rating <= 3 THEN 1 ELSE 0 END)) / COUNT(*)) END
              FROM reviews r JOIN events e ON e.id = r.event_id WHERE e.host_user_id = ?)                AS nps,
           (SELECT banned_at FROM users WHERE id = ?)                                                    AS banned_at`,
      )
      .bind(hostId, hostId, since, hostId, hostId, hostId)
      .first<Row>();
    return {
      settledGyms: Number(r?.settled_gyms ?? 0),
      nps: r?.nps == null ? null : Number(r.nps),
      reviewCount: Number(r?.review_count ?? 0),
      mintedInWindow: Number(r?.minted ?? 0),
      quarantined: !!r?.banned_at,
    };
  }

  /**
   * Recompute `budget` from verified presence and host standing.
   *
   * THROWS if the new budget would fall below what is already spent — that is the schema's
   * `CHECK (spent <= budget)` doing its job, and it is the correct outcome: it forces the
   * operator through `revokeAward` first rather than silently leaving minted XP unbacked.
   */
  async syncBudget(eventId: string, atIso: string = nowIso()): Promise<Budget> {
    const gym = await this.gym(eventId);
    if (!gym) return { budget: 0, recipientCap: recipientCap(0), reasons: ["no gym"] };
    const standing = gym.hostId ? await this.hostStanding(gym.hostId, Date.parse(atIso) || Date.now()) : { settledGyms: 0, nps: null, reviewCount: 0, mintedInWindow: 0, quarantined: true };
    const b = gymBudget(await this.verifiedAttendees(eventId), standing);
    await this.db
      .prepare("UPDATE event_gyms SET budget = ?, recipient_cap = ?, budget_synced_at = ? WHERE event_id = ?")
      .bind(b.budget, Math.max(1, b.recipientCap), atIso, eventId)
      .run();
    return b;
  }

  // ── the door ────────────────────────────────────────────────────────────────
  /**
   * Mint the code about to go on screen, revoking whatever was on screen before it.
   *
   * The revoke IS the rotation: the QR changes every `DOOR_ROTATE_MS` and the previous
   * frame must stop working the instant it leaves the display, or a photograph of it stays
   * live for the whole TTL.
   */
  async mintDoorCode(
    eventId: string,
    hostId: string,
    at: { lat: number; lng: number },
    secretHash: string,
    ttlMs: number = DOOR_TTL_MS,
    maxUses: number = DOOR_MAX_USES,
    atMs: number = Date.now(),
  ): Promise<{ codeId: string; expiresAt: string }> {
    const ts = new Date(atMs).toISOString();
    await this.db
      .prepare("UPDATE door_codes SET revoked_at = ? WHERE event_id = ? AND revoked_at IS NULL")
      .bind(ts, eventId)
      .run();

    const codeId = ulid();
    const expiresAt = new Date(atMs + ttlMs).toISOString();
    await this.db
      .prepare(
        `INSERT INTO door_codes (id, event_id, host_id, secret_hash, lat, lng, expires_at, max_uses, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(codeId, eventId, hostId, secretHash, at.lat, at.lng, expiresAt, maxUses, ts)
      .run();
    return { codeId, expiresAt };
  }

  async doorCode(codeId: string): Promise<Row | null> {
    return await this.db.prepare("SELECT * FROM door_codes WHERE id = ?").bind(codeId).first<Row>();
  }

  /**
   * Consume one use of a door code, or lose the race.
   *
   * This is the ceiling guarantee for the whole economy, and it is one statement on
   * purpose:
   *
   *   UPDATE door_codes SET uses = uses + 1
   *    WHERE id = ? AND uses < max_uses AND revoked_at IS NULL AND expires_at > ?
   *
   * A SELECT-then-UPDATE would let two simultaneous scans of the same screen both observe
   * spare capacity and both proceed. Here the database picks the winners and the loser sees
   * `changes === 0`.
   */
  async claimDoorUse(codeId: string, atMs: number = Date.now()): Promise<boolean> {
    const res = await this.db
      .prepare(
        `UPDATE door_codes SET uses = uses + 1
          WHERE id = ? AND uses < max_uses AND revoked_at IS NULL AND expires_at > ?`,
      )
      .bind(codeId, new Date(atMs).toISOString())
      .run();
    return changes(res) === 1;
  }

  /**
   * Write (or extend) the presence record.
   *
   * The first scan sets `first_at`; every later scan advances `last_at` and bumps `scans`.
   * That is the whole dwell mechanism: the only way to raise your own multiplier is to
   * still be inside the geofence when the code rotates. `MAX(last_at, ?)` rather than a
   * plain assignment so an out-of-order request can never shorten a stay.
   */
  async recordPresence(
    userId: string,
    eventId: string,
    codeId: string | null,
    at: { lat: number; lng: number },
    atIso: string = nowIso(),
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO event_presence (user_id, event_id, code_id, lat, lng, first_at, last_at, scans)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(user_id, event_id) DO UPDATE SET
           last_at = MAX(event_presence.last_at, excluded.last_at),
           scans   = event_presence.scans + 1,
           lat     = excluded.lat,
           lng     = excluded.lng`,
      )
      .bind(userId, eventId, codeId, at.lat, at.lng, atIso, atIso)
      .run();
  }

  async presence(userId: string, eventId: string): Promise<Row | null> {
    return await this.db.prepare("SELECT * FROM event_presence WHERE user_id = ? AND event_id = ?").bind(userId, eventId).first<Row>();
  }

  // ── awards ──────────────────────────────────────────────────────────────────
  /** How many times this host has EVER paid this person. Drives the halving. */
  async priorAwards(hostId: string, userId: string): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS n FROM gym_awards WHERE host_id = ? AND user_id = ?")
      .bind(hostId, userId)
      .first<Row>();
    return Number(r?.n ?? 0);
  }

  /**
   * The cap for one recipient at this gym: the halving ladder, scaled by how long they
   * actually stayed, and never above the gym's snapshotted `recipient_cap`.
   */
  async capFor(gym: Gym, userId: string, ev: EventWindow | null): Promise<number> {
    if (!gym.hostId) return 0;
    const p = await this.presence(userId, gym.eventId);
    if (!p) return 0;
    const minutes = creditedMinutes(p.first_at, p.last_at, ev ?? undefined);
    const ladder = recipientCap(await this.priorAwards(gym.hostId, userId));
    return Math.floor(Math.min(ladder, gym.recipientCap) * dwellMultiplier(minutes));
  }

  /**
   * Award XP, and mint it into the ledger.
   *
   * Pre-checks exist only to return a friendly, specific reason. The GUARANTEES are the
   * schema's — so the constraint errors are caught and mapped rather than allowed to
   * surface as a 500, and `tests/gym-schema.test.ts` proves each one holds without any of
   * this code.
   */
  async award(
    a: { eventId: string; hostId: string; userId: string; bountyKey?: string; xp: number; badgeId?: string; note?: string },
    atIso: string = nowIso(),
  ): Promise<{ result: AwardResult; awardId?: string; cap?: number }> {
    const gym = await this.gym(a.eventId);
    if (!gym) return { result: "not_armed" };
    if (a.userId === a.hostId) return { result: "self" };

    const ev = await this.window(a.eventId);
    // Pass the gate's verdict through rather than collapsing it: "this gym is closed" and
    // "publish your terms first" need different copy, and a host shown the wrong one will
    // go looking for a button that isn't the problem.
    const gate = canAward(gym, ev ?? { startUtc: "", endUtc: null }, Date.parse(atIso) || Date.now());
    if (gate !== "ok") {
      const map: Record<Exclude<typeof gate, "ok">, AwardResult> = {
        too_early: "outside_window",
        too_late: "outside_window",
        no_budget: "no_budget",
        already_settled: "already_settled",
        not_armed: "not_armed",
        not_draft: "not_armed",
        empty_policy: "not_armed",
      };
      return { result: map[gate] };
    }

    const cap = await this.capFor(gym, a.userId, ev);
    const xp = Math.floor(a.xp);
    if (cap <= 0) return { result: "not_present", cap };
    if (xp > cap) return { result: "over_cap", cap };
    if (xp > gym.budget - gym.spent) return { result: "over_budget", cap };

    const awardId = ulid();
    try {
      await this.db
        .prepare(
          `INSERT INTO gym_awards (id, event_id, user_id, host_id, bounty_key, xp, badge_id, note, awarded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(awardId, a.eventId, a.userId, a.hostId, a.bountyKey ?? "", xp, a.badgeId ?? null, a.note ?? null, atIso)
        .run();
    } catch (e) {
      return { result: classifyAwardError(e), cap };
    }

    // kind='gym' as a single bucket, so `XpRepo.breakdown` shows one "Gym" row and
    // `?metric=gym` is a real leaderboard for free. The detail lives in meta_json.
    await new XpRepo(this.db).grant(a.userId, "gym", xp, `gym:${awardId}`, {
      awardId,
      eventId: a.eventId,
      hostId: a.hostId,
      bountyKey: a.bountyKey ?? "",
    });
    return { result: "ok", awardId, cap };
  }

  /**
   * Undo an award: a compensating NEGATIVE ledger row, then the award row.
   *
   * Order is the invariant. `xp_ledger` is append-only, so reversal is never a delete —
   * and writing the void FIRST means a half-finished revoke leaves an award row standing
   * with its XP already netted out (visible, recoverable) rather than minted XP with no
   * provenance (invisible, not).
   */
  async revokeAward(eventId: string, awardId: string, reason: string): Promise<boolean> {
    const r = await this.db.prepare("SELECT * FROM gym_awards WHERE id = ? AND event_id = ?").bind(awardId, eventId).first<Row>();
    if (!r) return false;

    await new XpRepo(this.db).grant(r.user_id, "gym", -Number(r.xp), `gym:void:${awardId}`, { awardId, eventId, reason, voided: true });
    const res = await this.db.prepare("DELETE FROM gym_awards WHERE id = ? AND event_id = ?").bind(awardId, eventId).run();
    return changes(res) === 1;
  }

  async awards(eventId: string): Promise<GymAward[]> {
    const r = await this.db
      .prepare(
        `SELECT a.*, u.display_name, u.handle FROM gym_awards a JOIN users u ON u.id = a.user_id
          WHERE a.event_id = ? ORDER BY a.awarded_at DESC`,
      )
      .bind(eventId)
      .all<Row>();
    return (r.results ?? []).map(toAward);
  }

  async received(userId: string, limit = 50): Promise<Array<GymAward & { eventTitle: string }>> {
    const r = await this.db
      .prepare(
        `SELECT a.*, e.title AS event_title FROM gym_awards a JOIN events e ON e.id = a.event_id
          WHERE a.user_id = ? ORDER BY a.awarded_at DESC LIMIT ?`,
      )
      .bind(userId, Math.max(1, Math.min(200, limit)))
      .all<Row>();
    return (r.results ?? []).map((x) => ({ ...toAward(x), eventTitle: x.event_title }));
  }

  /**
   * The host's roster: every verified attendee, how long they stayed, what they've been
   * given, and what they may still be given. One query plus the pure maths — this is the
   * whole data shape the gym dashboard renders.
   */
  async roster(eventId: string): Promise<RosterRow[]> {
    const gym = await this.gym(eventId);
    const ev = await this.window(eventId);
    const hostId = gym?.hostId ?? "";
    const r = await this.db
      .prepare(
        `SELECT p.user_id, p.first_at, p.last_at, p.scans, u.display_name, u.handle,
                COALESCE((SELECT SUM(xp) FROM gym_awards a WHERE a.event_id = p.event_id AND a.user_id = p.user_id), 0) AS awarded,
                COALESCE((SELECT COUNT(*) FROM gym_awards a WHERE a.host_id = ? AND a.user_id = p.user_id), 0)         AS prior
           FROM event_presence p JOIN users u ON u.id = p.user_id
          WHERE p.event_id = ?
          ORDER BY p.first_at ASC`,
      )
      .bind(hostId, eventId)
      .all<Row>();

    const snapCap = gym?.recipientCap ?? 0;
    return (r.results ?? []).map((x) => {
      const minutes = creditedMinutes(x.first_at, x.last_at, ev ?? undefined);
      const mult = dwellMultiplier(minutes);
      const awarded = Number(x.awarded);
      const prior = Number(x.prior);
      // `prior` counts awards already made, including the ones at this gym, so the ladder
      // is already stepped down for a repeat recipient here.
      const ceiling = Math.floor(Math.min(recipientCap(prior), snapCap) * mult);
      return {
        userId: x.user_id,
        displayName: x.display_name,
        handle: x.handle,
        firstAt: x.first_at,
        lastAt: x.last_at,
        scans: Number(x.scans),
        dwellMinutes: Math.round(minutes),
        dwellMultiplier: mult,
        awarded,
        priorAwards: prior,
        remainingCap: Math.max(0, ceiling),
      };
    });
  }

  /**
   * Reconciliation: Σ `gym_awards.xp` against Σ `xp_ledger` where kind='gym', per event.
   * Any non-zero delta is a bookkeeping bug — a grant that fired without an award row, or
   * an award whose ledger row never landed. Cheap enough to run on the cron.
   */
  async audit(eventId?: string): Promise<Array<{ eventId: string; awarded: number; ledger: number; delta: number }>> {
    const r = await this.db
      .prepare(
        `SELECT a.event_id,
                SUM(a.xp) AS awarded,
                COALESCE((SELECT SUM(x.xp) FROM xp_ledger x
                           WHERE x.kind = 'gym'
                             AND json_extract(x.meta_json, '$.eventId') = a.event_id), 0) AS ledger
           FROM gym_awards a
          ${eventId ? "WHERE a.event_id = ?" : ""}
          GROUP BY a.event_id`,
      )
      .bind(...(eventId ? [eventId] : []))
      .all<Row>();
    return (r.results ?? []).map((x) => ({
      eventId: x.event_id,
      awarded: Number(x.awarded),
      ledger: Number(x.ledger),
      delta: Number(x.ledger) - Number(x.awarded),
    }));
  }
}

/**
 * Map a database constraint error onto an `AwardResult`.
 *
 * Matched on substrings because the wording differs between D1 and better-sqlite3, and a
 * mis-detected error here would surface as a 500 for a case the schema handled correctly —
 * which is the single likeliest real bug in this feature.
 */
function classifyAwardError(e: unknown): AwardResult {
  const m = String((e as Error)?.message ?? e).toUpperCase();
  if (m.includes("FOREIGN KEY")) return "not_present";
  if (m.includes("UNIQUE")) return "duplicate";
  if (m.includes("NOT ARMED") || m.includes("SETTLED")) return "not_armed";
  if (m.includes("CHECK")) return "over_budget";
  throw e as Error; // genuinely unexpected — do not swallow it
}
