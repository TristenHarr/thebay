import { Hono } from "hono";
import { z } from "zod";
import type { Env, Vars } from "../env";
import { AttributionRepo } from "../../storage/d1/attribution-repo";
import { SocialRepo } from "../../storage/d1/social-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { EVIDENCE_TIERS } from "../../core/attribution/ledger";

/**
 * Outcomes and attribution — which intros and events actually led somewhere.
 *
 * Every response carries the EVIDENCE TIER alongside the claim, already rendered
 * by the pure ledger, so no client can accidentally print a `platform`
 * co-occurrence as if somebody had asserted causation. Boards are public by
 * default; `PUT /api/me/attribution` is the opt-out, and it removes the member
 * from all of them.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new AttributionRepo(c.env.DB);

const CAUSE_TYPES = ["intro", "event", "group", "community", "mentor"] as const;

const OutcomeSchema = z.object({
  kind: z.enum(["funding", "hire", "cofounder", "customer", "job"]),
  companyId: z.string().max(40).optional(),
  roundId: z.string().max(40).optional(),
  occurredAt: z.string().max(40).optional(),
  visibility: z.enum(["private", "network", "public"]).optional(),
});
const AttributionSchema = z.object({
  causeType: z.enum(CAUSE_TYPES),
  causeId: z.string().min(1).max(80),
  weight: z.number().min(0).max(1).optional(),
  /** Only 'platform' is accepted from a client, and it means "record the
   *  co-occurrence you can prove" — the tier itself is decided by the repo. */
  evidence: z.enum(EVIDENCE_TIERS).optional(),
});

const BOARDS = ["connectors", "events", "communities", "venues", "hosts"] as const;

export function attributionRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // ── outcomes ────────────────────────────────────────────────────────────────
  app.post("/api/outcomes", requireAuth, async (c) => {
    const p = OutcomeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    return c.json({ ok: true, id: await repo(c).recordOutcome(c.get("user")!.id, p.data) });
  });

  app.get("/api/me/outcomes", requireAuth, async (c) => {
    const me = c.get("user")!.id;
    return c.json({ outcomes: await repo(c).outcomesForUser(me, me) });
  });

  /** The opt-out. Public by default is the product decision; this is the exit. */
  app.put("/api/me/attribution", requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { optOut?: boolean };
    await repo(c).setOptOut(c.get("user")!.id, !!body.optOut);
    return c.json({ ok: true, optOut: !!body.optOut });
  });

  app.get("/api/u/:handle/outcomes", optionalAuth, async (c) => {
    const user = await new SocialRepo(c.env.DB).getUserByHandle(c.req.param("handle"));
    if (!user) return c.json({ error: "not found" }, 404);
    return c.json({ outcomes: await repo(c).outcomesForUser(user.id, c.get("user")?.id ?? null) });
  });

  app.get("/api/outcomes/:id", optionalAuth, async (c) => {
    const outcome = await repo(c).outcome(c.req.param("id"), c.get("user")?.id ?? null);
    return outcome ? c.json({ outcome }) : c.json({ error: "not found" }, 404);
  });

  // ── attribution ─────────────────────────────────────────────────────────────
  app.post("/api/outcomes/:id/attributions", requireAuth, async (c) => {
    const p = AttributionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    const { evidence, ...cause } = p.data;
    const r = repo(c);

    // A correlation is machine-derived and must be provable, so it goes through
    // its own path — a client asking for 'platform' is asking us to CHECK that
    // the edge predates the outcome, not to take its word for it. Everything else
    // is a claim by the outcome's owner.
    if (evidence === "platform") {
      const result = await r.recordPlatformCorrelation(c.req.param("id"), cause);
      return c.json({ result }, result === "recorded" || result === "exists" ? 200 : result === "unknown" ? 404 : 409);
    }
    const result = await r.claimAttribution(c.get("user")!.id, c.req.param("id"), cause);
    return c.json({ result }, result === "claimed" ? 200 : result === "unknown" ? 404 : 403);
  });

  app.post("/api/attributions/:id/confirm", requireAuth, async (c) => {
    const result = await repo(c).confirmAttribution(c.get("user")!.id, c.req.param("id"));
    return c.json({ result }, result === "confirmed" ? 200 : result === "unknown" ? 404 : 403);
  });

  // ── boards ──────────────────────────────────────────────────────────────────
  app.get("/api/impact/leaderboard", async (c) => {
    const q = c.req.query("board");
    const board = (BOARDS as readonly string[]).includes(q ?? "") ? (q as (typeof BOARDS)[number]) : "connectors";
    const r = repo(c);
    const rows =
      board === "events" ? await r.eventTrackRecord()
      : board === "communities" ? await r.communityTrackRecord()
      : board === "venues" ? await r.venueBoard()
      : board === "hosts" ? await r.hostBoard()
      : await r.superConnectors();
    return c.json({ board, rows });
  });

  /**
   * E5 — per-cause outcome density, so a ranking elsewhere can consume it without
   * reaching into these tables. Claims, corroborations and correlations are
   * returned as separate counts and never pre-summed into one "impact" score.
   */
  app.get("/api/impact/density", async (c) => {
    const cause = c.req.query("cause") ?? "";
    if (!(CAUSE_TYPES as readonly string[]).includes(cause)) return c.json({ error: "unknown cause type" }, 400);
    const ids = (c.req.query("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
    return c.json({ cause, density: await repo(c).outcomeDensity(cause as (typeof CAUSE_TYPES)[number], ids.length ? ids : undefined) });
  });

  return app;
}
