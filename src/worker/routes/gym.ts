import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { GymRepo, type AwardResult } from "../../storage/d1/gym-repo";
import { PlatformRepo } from "../../storage/d1/platform-repo";
import { SocialRepo } from "../../storage/d1/social-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { requireHost } from "../../auth/host";
import { mintSecret, hashSecret, timingSafeEqualHex } from "../../core/net/invite";
import { checkPresence, doorUrl, DOOR_ROTATE_MS, DOOR_TTL_MS, type PresenceCheck } from "../../core/gym/presence";
import { flatAllocation, parseBounties } from "../../core/gym/policy";
import { canonicalOrigin } from "../origin";
import { inBay } from "../../core/geo";
import { haversineKm } from "../../core/geofence";
import { GymPolicySchema, GymAwardSchema, GymAwardBulkSchema, GymRevokeSchema, PresenceClaimSchema, FixSchema } from "../../../shared/schema";

/**
 * Gyms — hosts as gym leaders.
 *
 * A host opens a gym on their own event, publishes its terms, and awards XP to people who
 * verifiably showed up. Every hard guarantee lives below this file: the economy in
 * `src/core/gym/budget.ts`, the rules in `policy.ts`, the door policy in `presence.ts`, and
 * the invariants that are properties of a row in `migrations/0028_gyms.sql`. What is here
 * is HTTP: guards, parsing, and turning a result union into a status code.
 *
 * The one thing worth reading carefully is the presence claim. It is the only route in the
 * app that mints the base the whole XP economy rests on, so it checks a hashed secret in
 * constant time, a geofence, the event's own time window, and an atomic use ceiling — and
 * it refuses in a specific, explainable way for each.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const g = (c: { env: Env }) => new GymRepo(c.env.DB);

/** Result → HTTP. 409 for "the rules said no", 403 for "not you", never a 500. */
const AWARD_STATUS: Record<AwardResult, 200 | 403 | 409> = {
  ok: 200,
  self: 403,
  not_present: 409,
  not_armed: 409,
  already_settled: 409,
  over_budget: 409,
  over_cap: 409,
  duplicate: 409,
  outside_window: 409,
  no_budget: 409,
};

/** What a failed scan is told. Specific on purpose: "you're too far" and "that code was
 *  already used up" send someone to different places. */
const PRESENCE_MESSAGE: Record<PresenceCheck, string> = {
  ok: "Checked in.",
  expired: "That code has rotated — scan the one on screen now.",
  revoked: "That code has rotated — scan the one on screen now.",
  exhausted: "That code is used up. Ask the host to show a fresh one.",
  too_far: "You need to be at the venue to check in here.",
  out_of_region: "Door check-in only works in the Bay Area.",
  self: "You're hosting this one — you can't check yourself in.",
  too_early: "Doors aren't open yet.",
  too_late: "This event's door has closed.",
};
const PRESENCE_STATUS: Record<PresenceCheck, 200 | 403 | 409 | 410> = {
  ok: 200,
  expired: 410,
  revoked: 410,
  exhausted: 409,
  too_far: 403,
  out_of_region: 403,
  self: 403,
  too_early: 409,
  too_late: 410,
};

const distanceM = (aLat: number, aLng: number, bLat: number, bLng: number) => haversineKm(aLat, aLng, bLat, bLng) * 1000;

export function gymRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // ── reading a gym ───────────────────────────────────────────────────────────
  /**
   * The attendee view, and the host's own dashboard payload when it's them.
   *
   * An attendee sees the TERMS of an armed gym — that's the promise they came for — but
   * never the budget or the roster. A draft gym is invisible to everyone but its host,
   * because unpublished terms are not a promise yet.
   */
  app.get("/api/events/:id/gym", optionalAuth, async (c) => {
    const eventId = c.req.param("id");
    const repo = g(c);
    const gym = await repo.gym(eventId);
    if (!gym) return c.json({ gym: null });

    const me = c.get("user");
    const isHost = !!me && gym.hostId === me.id;
    if (!isHost && gym.status === "draft") return c.json({ gym: null });

    const attendees = await repo.verifiedAttendees(eventId);
    const terms = {
      status: gym.status,
      mode: gym.mode,
      flatXp: gym.flatXp,
      bounties: gym.bounties,
      attendees,
      armedAt: gym.armedAt,
      settledAt: gym.settledAt,
    };
    if (!isHost) {
      // What a flat gym is currently on track to pay each person, so the promise is
      // legible before the event rather than a number the host quotes.
      const alloc = gym.mode === "flat" ? flatAllocation(gym.flatXp, attendees, gym.budget) : null;
      return c.json({ gym: terms, projected: alloc, mine: me ? await repo.presence(me.id, eventId).then((p) => !!p) : false });
    }
    return c.json({
      gym: { ...terms, budget: gym.budget, spent: gym.spent, recipientCap: gym.recipientCap },
      budget: await repo.syncBudget(eventId).catch(() => null),
      roster: await repo.roster(eventId),
      awards: await repo.awards(eventId),
      isHost: true,
    });
  });

  /** Every gym this host runs, plus the events they could open one on. */
  app.get("/api/gyms/hosted", requireAuth, async (c) => {
    const me = c.get("user")!.id;
    const events = await new SocialRepo(c.env.DB).hostedEvents(me, { limit: 50 });
    const repo = g(c);
    const rows = [];
    for (const e of events) {
      const gym = await repo.gym(String(e.id));
      rows.push({ event: e, gym: gym ? { status: gym.status, mode: gym.mode, budget: gym.budget, spent: gym.spent } : null });
    }
    return c.json({ hosted: rows });
  });

  app.get("/api/me/gym-awards", requireAuth, async (c) => c.json({ awards: await g(c).received(c.get("user")!.id) }));

  // ── declaring the terms ─────────────────────────────────────────────────────
  app.put("/api/events/:id/gym", requireAuth, requireHost(), async (c) => {
    const p = GymPolicySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid policy", detail: p.error.flatten() }, 400);
    const eventId = c.req.param("id");
    try {
      // `parseBounties` normalises what the client sent (slugified keys, clamped prices)
      // so the stored spec is already the canonical one the reader will parse back.
      const gym = await g(c).upsertDraft(eventId, c.get("user")!.id, {
        mode: p.data.mode,
        flatXp: p.data.flatXp,
        bounties: parseBounties(p.data.bounties),
      });
      return c.json({ ok: true, gym });
    } catch {
      // The terms-frozen trigger. An armed gym's rules are published and cannot move.
      return c.json({ error: "gym terms are frozen once the gym is armed" }, 409);
    }
  });

  app.post("/api/events/:id/gym/arm", requireAuth, requireHost(), async (c) => {
    const eventId = c.req.param("id");
    const repo = g(c);
    await repo.syncBudget(eventId).catch(() => undefined);
    if (!(await repo.arm(eventId))) return c.json({ error: "not a draft gym" }, 409);
    return c.json({ ok: true, gym: await repo.gym(eventId) });
  });

  app.post("/api/events/:id/gym/settle", requireAuth, requireHost(), async (c) => {
    if (!(await g(c).settle(c.req.param("id")))) return c.json({ error: "not an armed gym" }, 409);
    return c.json({ ok: true });
  });

  app.get("/api/events/:id/gym/roster", requireAuth, requireHost(), async (c) => {
    const eventId = c.req.param("id");
    const repo = g(c);
    return c.json({ roster: await repo.roster(eventId), budget: await repo.syncBudget(eventId).catch(() => null) });
  });

  // ── awarding ────────────────────────────────────────────────────────────────
  app.post("/api/events/:id/gym/awards", requireAuth, requireHost(), async (c) => {
    const p = GymAwardSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid award" }, 400);
    const eventId = c.req.param("id");
    const hostId = c.get("user")!.id;
    const repo = g(c);

    const gym = await repo.gym(eventId);
    if (!gym) return c.json({ error: "no gym" }, 404);
    const xp = resolveXp(p.data, gym.flatXp, gym.bounties);
    if (xp <= 0) return c.json({ error: "nothing to award" }, 400);

    const r = await repo.award({ eventId, hostId, userId: p.data.userId, bountyKey: p.data.bountyKey, xp, note: p.data.note });
    const after = await repo.gym(eventId);
    return c.json(
      { result: r.result, awardId: r.awardId, cap: r.cap, budget: after?.budget ?? 0, spent: after?.spent ?? 0 },
      AWARD_STATUS[r.result],
    );
  });

  /**
   * "Flat to everyone who showed up", in one call.
   *
   * Each award is attempted independently and its verdict returned, rather than failing the
   * batch: with per-recipient caps and dwell multipliers in play, a partial success is the
   * NORMAL outcome (the person who stayed ten minutes has a lower ceiling than the person
   * who stayed two hours), and a host needs to see which is which.
   */
  app.post("/api/events/:id/gym/awards/bulk", requireAuth, requireHost(), async (c) => {
    const p = GymAwardBulkSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid batch (max 80)" }, 400);
    const eventId = c.req.param("id");
    const hostId = c.get("user")!.id;
    const repo = g(c);

    const gym = await repo.gym(eventId);
    if (!gym) return c.json({ error: "no gym" }, 404);

    const results: Array<{ userId: string; result: AwardResult; xp: number }> = [];
    for (const a of p.data.awards) {
      const xp = resolveXp(a, gym.flatXp, gym.bounties);
      if (xp <= 0) {
        results.push({ userId: a.userId, result: "no_budget", xp: 0 });
        continue;
      }
      const r = await repo.award({ eventId, hostId, userId: a.userId, bountyKey: a.bountyKey, xp, note: a.note });
      results.push({ userId: a.userId, result: r.result, xp: r.result === "ok" ? xp : 0 });
    }
    const after = await repo.gym(eventId);
    return c.json({
      results,
      granted: results.filter((r) => r.result === "ok").length,
      budget: after?.budget ?? 0,
      spent: after?.spent ?? 0,
    });
  });

  app.delete("/api/events/:id/gym/awards/:awardId", requireAuth, requireHost(), async (c) => {
    const p = GymRevokeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "a reason is required" }, 400);
    try {
      const ok = await g(c).revokeAward(c.req.param("id"), c.req.param("awardId"), p.data.reason);
      return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
    } catch {
      // The settled-immutable triggers.
      return c.json({ error: "this gym is settled" }, 409);
    }
  });

  // ── the door ────────────────────────────────────────────────────────────────
  /**
   * Mint the code going on screen. Returns the secret EXACTLY ONCE — only its SHA-256 is
   * stored, so a database read cannot manufacture attendance.
   */
  app.post("/api/events/:id/door", requireAuth, requireHost(), async (c) => {
    const p = FixSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "a location is required to open the door" }, 400);
    if (!inBay(p.data.lat, p.data.lng)) return c.json({ error: "door check-in only works in the Bay Area" }, 403);

    const eventId = c.req.param("id");
    const secret = mintSecret();
    const { codeId, expiresAt } = await g(c).mintDoorCode(eventId, c.get("user")!.id, p.data, await hashSecret(secret));
    return c.json({
      codeId,
      expiresAt,
      url: doorUrl(canonicalOrigin(c.env), eventId, codeId, secret),
      rotateMs: DOOR_ROTATE_MS,
      ttlMs: DOOR_TTL_MS,
    });
  });

  /**
   * Claim presence. THE route that mints the economy's base.
   *
   * Order of operations matters: policy first (pure, cheap, explains itself), then the
   * atomic use claim, then the write. `claimDoorUse` is what actually enforces the ceiling
   * — the `exhausted` check above it is a courtesy, because two concurrent scans can both
   * pass any check that only reads.
   */
  app.post("/api/events/:id/presence", requireAuth, async (c) => {
    const p = PresenceClaimSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid claim" }, 400);

    const eventId = c.req.param("id");
    const me = c.get("user")!.id;
    const repo = g(c);

    const code = await repo.doorCode(p.data.codeId);
    // Wrong event, unknown code, or a bad secret are all one answer. Distinguishing them
    // would confirm which door codes exist to somebody guessing.
    if (!code || code.event_id !== eventId) return c.json({ result: "expired", message: PRESENCE_MESSAGE.expired }, 410);
    if (!timingSafeEqualHex(await hashSecret(p.data.secret), code.secret_hash)) {
      return c.json({ result: "expired", message: PRESENCE_MESSAGE.expired }, 410);
    }

    const ev = await repo.window(eventId);
    if (!ev) return c.json({ error: "no such event" }, 404);

    const verdict = checkPresence(
      { hostId: code.host_id, lat: code.lat, lng: code.lng, expiresAt: code.expires_at, revokedAt: code.revoked_at, uses: code.uses, maxUses: code.max_uses },
      { id: me, lat: p.data.lat, lng: p.data.lng },
      ev,
      Date.now(),
      inBay,
      distanceM,
    );
    if (verdict !== "ok") return c.json({ result: verdict, message: PRESENCE_MESSAGE[verdict] }, PRESENCE_STATUS[verdict]);

    // A re-scan by someone already present extends their dwell and must NOT consume a use
    // — otherwise a 20-use code is spent by four people scanning five times each.
    const already = await repo.presence(me, eventId);
    if (!already && !(await repo.claimDoorUse(p.data.codeId))) {
      return c.json({ result: "exhausted", message: PRESENCE_MESSAGE.exhausted }, 409);
    }

    await repo.recordPresence(me, eventId, p.data.codeId, { lat: p.data.lat, lng: p.data.lng });
    // The hardened door grants the same social credit as the old one, or it would silently
    // regress the review-gate, the attend streak and `points.checkin`.
    await new PlatformRepo(c.env.DB).completeCheckin(me, eventId);
    await repo.syncBudget(eventId).catch(() => undefined);

    const p2 = await repo.presence(me, eventId);
    return c.json({ result: "ok", message: PRESENCE_MESSAGE.ok, firstAt: p2?.first_at, lastAt: p2?.last_at, scans: p2?.scans });
  });

  return app;
}

/** A bounty award defaults to its declared price; anything else must state one. */
function resolveXp(a: { xp?: number; bountyKey?: string }, flatXp: number, bounties: Array<{ key: string; xp: number }>): number {
  if (a.bountyKey) {
    const b = bounties.find((x) => x.key === a.bountyKey);
    return Math.floor(a.xp ?? b?.xp ?? 0);
  }
  return Math.floor(a.xp ?? flatXp ?? 0);
}
