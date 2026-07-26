import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { requireIngestToken } from "../middleware/bearer";
import { VibeRepo, type VibeCard } from "../../storage/d1/vibe-repo";
import { SocialRepo } from "../../storage/d1/social-repo";
import { PlatformRepo } from "../../storage/d1/platform-repo";
import { enrichVibe, vibeLlm } from "../../ai/vibe-predict";
import { VibeReportSchema, VIBE_AXES, clampAxis, type VibeAxis } from "../../core/vibe";
import { sendPush } from "../../push/webpush";

/**
 * Event vibe profiles — a predicted prior blended with check-in-verified attendee
 * reports (see src/core/vibe.ts for the arithmetic, migrations/0015 for the bounds).
 *
 * Two properties this surface is built to guarantee:
 *
 *  · **It always renders.** GET materialises a deterministic card on demand, so an
 *    event has a vibe the moment it exists — no model, no key, no cron required.
 *  · **It never lies.** Every response carries `source` and `nReports`. A
 *    'predicted' card has been in front of exactly zero attendees, and the client
 *    is given what it needs to say so.
 *
 * Reports are accepted from anyone but only WEIGHTED (and only paid for) when the
 * reporter has a `checkins` row — otherwise both the blend and the points ledger
 * would be farmable from a laptop.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new VibeRepo(c.env.DB);

/** Background work that outlives the response (model enrichment). Null in unit
 *  tests, which keeps them deterministic and offline. */
function bgCtx(c: any): { waitUntil(p: Promise<unknown>): void } | null {
  try { return c.executionCtx ?? null; } catch { return null; }
}

/** Ask the model for a better card behind the response. Best-effort by definition:
 *  the deterministic card is already stored and served. */
async function enrichInBackground(env: Env, eventId: string): Promise<void> {
  try {
    const r = new VibeRepo(env.DB);
    const facts = await r.eventFacts(eventId);
    if (!facts) return;
    const { cfg, opts } = vibeLlm(env as any);
    if (!cfg.openrouterKey && !cfg.env?.AI) return; // nothing to call — don't churn
    const { prediction, prose, model } = await enrichVibe(facts, cfg, opts);
    await r.savePrediction(eventId, prediction, prose, model);
  } catch {
    /* the card is already good; enrichment is a bonus */
  }
}

/** Materialise a card for an event that hasn't got one yet, deterministically. */
async function ensureCard(c: any, eventId: string): Promise<VibeCard | null> {
  const r = repo(c);
  const existing = await r.get(eventId);
  if (existing) return existing;
  const card = await r.recompute(eventId); // null ⇒ no such event
  if (card) bgCtx(c)?.waitUntil(enrichInBackground(c.env, eventId));
  return card;
}

/** ?energyMin=&signalMax=&bestFor=a,b&source=blended,reported — parsed leniently:
 *  a junk filter is ignored, never a 500. */
function parseFilters(q: URLSearchParams) {
  const min: Partial<Record<VibeAxis, number>> = {};
  const max: Partial<Record<VibeAxis, number>> = {};
  for (const a of VIBE_AXES) {
    const lo = clampAxis(q.get(`${a}Min`));
    if (lo != null) min[a] = lo;
    const hi = clampAxis(q.get(`${a}Max`));
    if (hi != null) max[a] = hi;
  }
  const list = (k: string) => (q.get(k) || "").split(",").map((s) => s.trim()).filter(Boolean);
  const limit = Number(q.get("limit"));
  return {
    min, max,
    bestFor: list("bestFor"),
    source: list("source") as any,
    minReports: Number.isFinite(Number(q.get("minReports"))) ? Number(q.get("minReports")) : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
  };
}

export function vibesRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // The card. Public, and self-healing: the first read materialises it.
  app.get("/api/events/:id/vibe", optionalAuth, async (c) => {
    const id = c.req.param("id");
    const vibe = await ensureCard(c, id);
    if (!vibe) return c.json({ error: "no such event" }, 404);
    const me = c.get("user");
    if (!me) return c.json({ vibe, myReport: null, canReport: false });
    const [myReport, canReport] = await Promise.all([repo(c).myReport(id, me.id), repo(c).hasCheckin(id, me.id)]);
    return c.json({ vibe, myReport, canReport });
  });

  // The 6-slider report card. Anyone signed in may submit; only a check-in makes it
  // count. Resubmitting replaces your read (PK (event_id,user_id)) rather than
  // adding a vote, and the ledger's dedup_key makes the award idempotent.
  app.post("/api/events/:id/vibe/report", requireAuth, async (c) => {
    const id = c.req.param("id");
    const parsed = VibeReportSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad vibe report", issues: parsed.error.issues.slice(0, 5) }, 400);
    if (!(await repo(c).eventFacts(id))) return c.json({ error: "no such event" }, 404);

    const uid = c.get("user")!.id;
    const { verified, card } = await repo(c).addReport(id, uid, parsed.data);

    if (verified) {
      try {
        await new SocialRepo(c.env.DB).awardPoints(uid, "vibe_report", `vibe_report:${uid}:${id}`, id);
        await new PlatformRepo(c.env.DB).grantAchievement(uid, "first_vibe", `first_vibe:${uid}`);
      } catch {
        /* points are a bonus, never a reason to lose the report */
      }
    }
    return c.json({ ok: true, verified, vibe: card });
  });

  // Rooms you attended and haven't read yet — the collection loop, driven off the
  // same check-ins the review-gate uses.
  app.get("/api/me/vibe-prompts", requireAuth, async (c) =>
    c.json({ pending: await repo(c).pendingPrompts(c.get("user")!.id) }));

  // Vibe axes as range filters + best_for as tags. Exposed as its own endpoint so
  // search can consume vibes as facets without reaching into the table.
  app.get("/api/vibes", async (c) => {
    const vibes = await repo(c).search(parseFilters(new URL(c.req.url).searchParams));
    return c.json({ vibes, count: vibes.length });
  });

  // Backfill / re-enrich cards with the platform model. Bearer-gated like every
  // other admin endpoint. With no model configured this still runs and writes the
  // deterministic card, which is exactly the point.
  app.post("/api/admin/vibes/enrich", requireIngestToken, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { limit?: number; refresh?: boolean };
    const r = repo(c);
    const { cfg, opts } = vibeLlm(c.env as any);
    const todo = await r.eventsNeedingVibe(body.limit ?? 50, !!body.refresh);
    let enriched = 0;
    let withModel = 0;
    for (const { eventId, facts } of todo) {
      const { prediction, prose, model } = await enrichVibe(facts, cfg, { ...opts, refresh: !!body.refresh });
      await r.savePrediction(eventId, prediction, prose, model);
      enriched++;
      if (model) withModel++;
    }
    return c.json({ ok: true, enriched, withModel, considered: todo.length });
  });

  // Nudge everyone who owes a read on a room they attended. Reuses the existing
  // web-push subscriptions; bodyless, like every other push here.
  app.post("/api/admin/vibes/nudge", requireIngestToken, async (c) => {
    if (!c.env.VAPID_PUBLIC_KEY || !c.env.VAPID_PRIVATE_KEY) return c.json({ error: "push not configured" }, 503);
    const plat = new PlatformRepo(c.env.DB);
    const users = await repo(c).usersOwingReports();
    let sent = 0;
    for (const uid of users) {
      for (const sub of await plat.listPushSubs(uid)) {
        try { if ((await sendPush(sub, c.env)).ok) sent++; } catch { /* a dead endpoint is not an error */ }
      }
    }
    return c.json({ ok: true, users: users.length, sent });
  });

  return app;
}
