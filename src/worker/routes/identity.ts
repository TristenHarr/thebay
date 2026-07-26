import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { IdentityRepo } from "../../storage/d1/identity-repo";
import { SocialRepo } from "../../storage/d1/social-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { requireHost } from "../../auth/host";
import { BADGE_CHECK_MESSAGE } from "../../core/gym/badge";
import { bestAffinity, underrepresented, FOUNDER_TYPES } from "../../core/types/chart";
import { classifyArchetype } from "../../core/vibe";
import { FounderIdentitySchema, FounderVouchSchema, GymBadgeMintSchema, GymBadgeAwardSchema } from "../../../shared/schema";

/**
 * Founder types, vouches, cards and host-minted badges — the Pokémon layer.
 *
 * The one rule worth restating at the route boundary: **none of this pays**. No handler here
 * writes to `xp_ledger` or `points_ledger`, and none reads a type to decide an amount. Types
 * steer discovery and decorate a card; that is all. `tests/founder-types.test.ts` greps the
 * economy to keep it that way, because "just a small bonus for verified investors" is exactly
 * the change that would turn the least checkable claim on the platform into money.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new IdentityRepo(c.env.DB);

export function identityRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // ── the chart ───────────────────────────────────────────────────────────────
  /** Served from the TABLE, not the module, so a tenth type needs no client deploy. */
  app.get("/api/founder-types", optionalAuth, async (c) => c.json({ types: await repo(c).types() }));

  // ── what you are ────────────────────────────────────────────────────────────
  app.get("/api/me/identity", requireAuth, async (c) => c.json(await repo(c).identity(c.get("user")!.id)));

  app.put("/api/me/identity", requireAuth, async (c) => {
    const p = FounderIdentitySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid", detail: p.error.flatten() }, 400);
    try {
      await repo(c).declare(c.get("user")!.id, p.data.typeId, p.data.type2Id ?? null);
    } catch {
      // The foreign key to `founder_types` is what makes the vocabulary closed.
      return c.json({ error: "no such type" }, 400);
    }
    return c.json({ ok: true, identity: await repo(c).identity(c.get("user")!.id) });
  });

  /**
   * Vouch for somebody's type.
   *
   * Deliberately grants nothing. If this ever starts paying, re-read migrations/0031's header:
   * the most damaging lie available here is "I'm an investor", and a paid vouch is a market
   * for it.
   */
  app.post("/api/users/:userId/vouch", requireAuth, async (c) => {
    const p = FounderVouchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    const target = c.req.param("userId");
    const me = c.get("user")!.id;
    if (target === me) return c.json({ error: "you can't vouch for yourself" }, 403);
    const ok = await repo(c).vouch(target, me, p.data.typeId, p.data.eventId ?? null);
    return c.json({ ok, already: !ok });
  });

  // ── the card ────────────────────────────────────────────────────────────────
  app.get("/api/me/card", requireAuth, async (c) => {
    const card = await repo(c).card(c.get("user")!.id);
    return card ? c.json({ card }) : c.json({ error: "not found" }, 404);
  });

  /**
   * Somebody else's card.
   *
   * Gated on `social_enabled` exactly as `/api/u/:handle` is — a card is a public profile in a
   * game costume, and it must not become the way to read one of somebody who opted out.
   */
  app.get("/api/u/:handle/card", optionalAuth, async (c) => {
    const social = new SocialRepo(c.env.DB);
    const target = await social.getUserByHandle(c.req.param("handle"));
    if (!target) return c.json({ error: "not found" }, 404);
    const me = c.get("user");
    if (!target.socialEnabled && me?.id !== target.id) return c.json({ error: "not found" }, 404);
    const card = await repo(c).card(target.id);
    return card ? c.json({ card }) : c.json({ error: "not found" }, 404);
  });

  // ── "is this room mine?" ────────────────────────────────────────────────────
  /**
   * The matchup, for one event.
   *
   * The archetype comes from the same classifier the vibe predictor uses, and the crowd mixes
   * behind `bestAffinity` are that predictor's own — so "your kind of room" is grounded in the
   * catalog rather than in a designer's hunch.
   */
  app.get("/api/events/:id/affinity", requireAuth, async (c) => {
    const eventId = c.req.param("id");
    const ev = await c.env.DB.prepare("SELECT title, description FROM events WHERE id = ?").bind(eventId).first<Record<string, any>>();
    if (!ev) return c.json({ error: "not found" }, 404);

    // `null` for a listing that matches no archetype — common, and honest. `bestAffinity`
    // shrugs (0.5) rather than inventing a read.
    const archetype = classifyArchetype({ title: ev.title ?? "", description: ev.description ?? null });
    const ident = await repo(c).identity(c.get("user")!.id);
    const mine = [ident.typeId, ident.type2Id].filter((x): x is string => !!x);
    return c.json({
      archetype,
      declared: mine.length > 0,
      ...bestAffinity(mine, archetype ?? ""),
      // What the room is short of — the half of a crowd mix that actually helps somebody
      // decide how to spend an evening.
      missing: archetype ? underrepresented(archetype).map((t) => ({ id: t.id, label: t.label, emoji: t.emoji })) : [],
    });
  });

  // ── host-minted badges ──────────────────────────────────────────────────────
  app.get("/api/events/:id/gym/badges", optionalAuth, async (c) => c.json({ badges: await repo(c).eventBadges(c.req.param("id")) }));

  app.post("/api/events/:id/gym/badges", requireAuth, requireHost(), async (c) => {
    const p = GymBadgeMintSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid badge" }, 400);
    const r = await repo(c).mintBadge(c.req.param("id"), c.get("user")!.id, p.data);
    if (r.result !== "ok") {
      const message = r.result === "duplicate" ? "You already have a badge with that name at this event." : BADGE_CHECK_MESSAGE[r.result];
      return c.json({ error: message, result: r.result }, 409);
    }
    return c.json({ ok: true, badgeId: r.badgeId });
  });

  app.post("/api/events/:id/gym/badges/:badgeId/award", requireAuth, requireHost(), async (c) => {
    const p = GymBadgeAwardSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    // A badge is a ceremony, not a payment — no budget check, because there is nothing to
    // spend. That is the whole reason `gym_badges` has no `xp` column.
    const granted = await repo(c).awardBadge(p.data.userId, c.req.param("badgeId"));
    return c.json({ ok: true, granted, already: !granted });
  });

  return app;
}

/** Exported for the nav/tests to reason about the closed set without importing the DB. */
export const KNOWN_TYPE_IDS = FOUNDER_TYPES.map((t) => t.id);
