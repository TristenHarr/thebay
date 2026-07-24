import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { GraphRepo } from "../../storage/d1/graph-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import {
  IntroRequestSchema,
  MentorProfileSchema,
  MentorRequestSchema,
  MatchPrefsSchema,
  MatchActionSchema,
  CommunityCreateSchema,
} from "../../../shared/schema";

type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const g = (c: { env: Env }) => new GraphRepo(c.env.DB);

export function graphRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // ── intros ──────────────────────────────────────────────────────────────────
  app.post("/api/intros", requireAuth, async (c) => {
    const p = IntroRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    return c.json({ ok: true, id: await g(c).createIntroRequest(c.get("user")!.id, p.data) });
  });
  app.get("/api/intros", requireAuth, async (c) => {
    const me = c.get("user")!.id;
    return c.json({ mine: await g(c).myIntroRequests(me), inbox: await g(c).connectorInbox(me), incoming: await g(c).incomingForwards(me) });
  });
  app.post("/api/intros/:reqId/forward", requireAuth, async (c) => {
    const forwardId = await g(c).forwardIntro(c.get("user")!.id, c.req.param("reqId"));
    if (!forwardId) return c.json({ error: "not eligible to forward this intro" }, 403);
    return c.json({ ok: true, forwardId });
  });
  app.post("/api/intros/forward/:fwdId/accept", requireAuth, async (c) => {
    const result = await g(c).acceptIntro(c.get("user")!.id, c.req.param("fwdId"));
    return c.json({ result }, result === "connected" ? 200 : 403);
  });

  // ── mentors (incl. peer / co-mentoring — an accepted request connects both ways) ─
  app.get("/api/mentors", optionalAuth, async (c) => c.json({ mentors: await g(c).listMentors(c.req.query("topic") || undefined) }));
  app.put("/api/mentors/me", requireAuth, async (c) => {
    const p = MentorProfileSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    await g(c).setMentorProfile(c.get("user")!.id, p.data);
    return c.json({ ok: true });
  });
  app.get("/api/mentors/inbox", requireAuth, async (c) => c.json({ requests: await g(c).mentorInbox(c.get("user")!.id) }));
  app.post("/api/mentors/:mentorId/request", requireAuth, async (c) => {
    const p = MentorRequestSchema.safeParse({ mentorId: c.req.param("mentorId"), ...(await c.req.json().catch(() => ({}))) });
    if (!p.success) return c.json({ error: "invalid" }, 400);
    return c.json({ ok: true, id: await g(c).requestMentor(c.get("user")!.id, p.data.mentorId, p.data.message) });
  });
  app.post("/api/mentor-requests/:id/respond", requireAuth, async (c) => {
    const { accept } = (await c.req.json().catch(() => ({}))) as { accept?: boolean };
    await g(c).respondMentorRequest(c.get("user")!.id, c.req.param("id"), !!accept);
    return c.json({ ok: true });
  });

  // ── matching ─────────────────────────────────────────────────────────────────
  app.put("/api/match/prefs", requireAuth, async (c) => {
    const p = MatchPrefsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid" }, 400);
    await g(c).setMatchPrefs(c.get("user")!.id, p.data);
    return c.json({ ok: true });
  });
  app.get("/api/match/deck", requireAuth, async (c) => c.json({ deck: await g(c).deck(c.get("user")!.id) }));
  app.post("/api/match/:targetId", requireAuth, async (c) => {
    const p = MatchActionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid action" }, 400);
    return c.json(await g(c).act(c.get("user")!.id, c.req.param("targetId"), p.data.action));
  });

  // ── network graph (interactive founder graph) ─────────────────────────────────
  app.get("/api/network/graph", requireAuth, async (c) => c.json(await g(c).networkGraph(c.get("user")!.id)));

  // ── communities + rankings ────────────────────────────────────────────────────
  app.get("/api/communities", requireAuth, async (c) => c.json({ communities: await g(c).myCommunities(c.get("user")!.id) }));
  app.post("/api/communities", requireAuth, async (c) => {
    const p = CommunityCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "name required" }, 400);
    return c.json({ ok: true, id: await g(c).createCommunity(c.get("user")!.id, p.data.name, p.data.kind) });
  });
  app.post("/api/communities/:id/join", requireAuth, async (c) => {
    await g(c).joinCommunity(c.get("user")!.id, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/api/communities/:id", optionalAuth, async (c) => c.json({ members: await g(c).communityMembers(c.req.param("id")) }));
  app.get("/api/rankings", optionalAuth, async (c) => {
    const q = c.req.query("metric");
    const metric = q === "intros" ? "intros" : q === "nps" ? "nps" : "points";
    return c.json({ metric, rows: await g(c).rankings(metric) });
  });

  return app;
}
