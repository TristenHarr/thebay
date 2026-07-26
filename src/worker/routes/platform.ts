import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { PlatformRepo } from "../../storage/d1/platform-repo";
import { SocialRepo } from "../../storage/d1/social-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { requireHost } from "../../auth/host";
import { GoalCreateSchema, GoalUpdateSchema, CheckinSchema, EventReviewSchema } from "../../../shared/schema";

type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const plat = (c: { env: Env }) => new PlatformRepo(c.env.DB);

export function platformRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // ── goals ─────────────────────────────────────────────────────────────────
  app.get("/api/goals", requireAuth, async (c) => c.json({ goals: await plat(c).listGoals(c.get("user")!.id) }));

  app.post("/api/goals", requireAuth, async (c) => {
    const parsed = GoalCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid goal", issues: parsed.error.issues }, 400);
    if (parsed.data.kind === "event" && !parsed.data.eventId) return c.json({ error: "event goal needs eventId" }, 400);
    const id = await plat(c).createGoal(c.get("user")!.id, parsed.data);
    return c.json({ ok: true, id });
  });

  app.patch("/api/goals/:id", requireAuth, async (c) => {
    const parsed = GoalUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid" }, 400);
    await plat(c).updateGoal(c.get("user")!.id, c.req.param("id"), parsed.data);
    return c.json({ ok: true });
  });

  // attach a goal to an event (per-event intent)
  app.post("/api/events/:id/goal", requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; visibility?: any };
    if (!body.title) return c.json({ error: "title required" }, 400);
    const id = await plat(c).createGoal(c.get("user")!.id, {
      kind: "event",
      eventId: c.req.param("id"),
      title: body.title,
      visibility: body.visibility,
    });
    return c.json({ ok: true, id });
  });

  // public goals on a profile
  app.get("/api/u/:handle/goals", optionalAuth, async (c) => {
    const target = await new SocialRepo(c.env.DB).getUserByHandle(c.req.param("handle"));
    if (!target || !target.socialEnabled) return c.json({ goals: [] });
    return c.json({ goals: await plat(c).publicGoals(target.id) });
  });

  // ── reviews of people (host / speaker / participant) ────────────────────────
  app.post("/api/users/:userId/review", requireAuth, async (c) => {
    const me = c.get("user")!;
    const subjectId = c.req.param("userId");
    if (subjectId === me.id) return c.json({ error: "you can't review yourself" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { subjectType?: string; rating?: number; body?: string; eventId?: string };
    const type = body.subjectType;
    if (type !== "host" && type !== "speaker" && type !== "participant") return c.json({ error: "subjectType must be host|speaker|participant" }, 400);
    if (!Number.isInteger(body.rating) || body.rating! < 1 || body.rating! > 5) return c.json({ error: "rating must be an integer 1–5" }, 400);
    // Integrity gate: you can only review someone from an event you attended together.
    if (!(await plat(c).canReviewPerson(me.id, subjectId))) return c.json({ error: "you can only review people from events you attended" }, 403);
    await plat(c).addSubjectReview(me.id, type, subjectId, body.rating!, body.body, body.eventId);
    return c.json({ ok: true });
  });

  app.get("/api/u/:handle/reviews", optionalAuth, async (c) => {
    const target = await new SocialRepo(c.env.DB).getUserByHandle(c.req.param("handle"));
    if (!target) return c.json({ reviews: [], rating: { avg: null, count: 0, byRole: {} } });
    const p = plat(c);
    return c.json({ reviews: await p.subjectReviews(target.id), rating: await p.subjectRating(target.id) });
  });

  // ── achievements, streaks & points breakdown ────────────────────────────────
  app.get("/api/me/achievements", requireAuth, async (c) => {
    const me = c.get("user")!.id;
    const p = plat(c);
    return c.json({ achievements: await p.listAchievements(me), streaks: await p.listStreaks(me), points: await p.pointsBreakdown(me) });
  });

  // public achievements on a profile (only if the user shares socially)
  app.get("/api/u/:handle/achievements", optionalAuth, async (c) => {
    const target = await new SocialRepo(c.env.DB).getUserByHandle(c.req.param("handle"));
    if (!target || !target.socialEnabled) return c.json({ achievements: [], streaks: [] });
    const p = plat(c);
    return c.json({ achievements: await p.listAchievements(target.id), streaks: await p.listStreaks(target.id) });
  });

  // ── review-gate ─────────────────────────────────────────────────────────────
  app.get("/api/me/obligations", requireAuth, async (c) => c.json({ pending: await plat(c).openObligations(c.get("user")!.id) }));

  app.post("/api/events/:id/review", requireAuth, async (c) => {
    const parsed = EventReviewSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid review" }, 400);
    const me = c.get("user")!;
    const eventId = c.req.param("id");
    // Attendance gate: you can only review an event you actually attended (RSVP'd
    // 'went'/past-'going' or checked in). Prevents fake reviews + points farming.
    if (!(await new SocialRepo(c.env.DB).canReview(me.id, eventId))) return c.json({ error: "must have attended" }, 403);
    await plat(c).reviewEvent(me.id, eventId, parsed.data.rating, parsed.data.body);
    return c.json({ ok: true });
  });

  // ── QR check-in ─────────────────────────────────────────────────────────────
  // host issues a rotating token (rendered as a QR at the door)
  app.post("/api/events/:id/checkin-token", requireAuth, requireHost(), async (c) => {
    const token = await plat(c).createCheckinToken(c.req.param("id"));
    return c.json({ ok: true, token });
  });

  // host live check-in roster
  app.get("/api/events/:id/checkins", requireAuth, requireHost(), async (c) => {
    const checkins = await plat(c).eventCheckins(c.req.param("id"));
    return c.json({ count: checkins.length, checkins });
  });

  app.post("/api/events/:id/checkin", requireAuth, async (c) => {
    const parsed = CheckinSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "token required" }, 400);
    const result = await plat(c).checkIn(c.get("user")!.id, c.req.param("id"), parsed.data.token);
    const status = result === "ok" || result === "already" ? 200 : result === "expired" ? 410 : 400;
    return c.json({ result }, status);
  });

  return app;
}
