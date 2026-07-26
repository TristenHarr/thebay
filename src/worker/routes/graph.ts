import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { GraphRepo } from "../../storage/d1/graph-repo";
import { GraphProjection, MAX_EDGES, MAX_NODES } from "../../storage/d1/graph-projection";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { GRAPH_EDGE_KINDS, nodeId, type GraphEdgeKind } from "../../core/graph/types";
import { describeEdge, explainPath } from "../../core/graph/explain";
import { directReasons, findPath } from "../../core/graph/path";
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
const proj = (c: { env: Env }) => new GraphProjection(c.env.DB);

/** `?include=checkin,rsvp` — unknown kinds are dropped rather than 400'd, so an old client
 *  asking for a retired edge kind degrades instead of breaking. */
function parseKinds(raw?: string): GraphEdgeKind[] | undefined {
  if (!raw) return undefined;
  const want = raw.split(",").map((s) => s.trim());
  const ok = want.filter((k): k is GraphEdgeKind => (GRAPH_EDGE_KINDS as readonly string[]).includes(k));
  return ok.length ? ok : undefined;
}

/** Clamp a client-supplied limit to the server's ceiling. The cap is ours, not theirs. */
function clampInt(raw: string | undefined, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : max;
}

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
  // The missing read. `PUT /api/match/prefs` shipped without one, so the form couldn't
  // repopulate and `interests_json` was written by a live screen and consumed by nothing.
  app.get("/api/me/match-prefs", requireAuth, async (c) => c.json({ prefs: await g(c).matchPrefs(c.get("user")!.id) }));
  app.get("/api/match/deck", requireAuth, async (c) => c.json({ deck: await g(c).deck(c.get("user")!.id) }));
  app.post("/api/match/:targetId", requireAuth, async (c) => {
    const p = MatchActionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid action" }, 400);
    return c.json(await g(c).act(c.get("user")!.id, c.req.param("targetId"), p.data.action));
  });

  // ── network graph (interactive founder graph) ─────────────────────────────────
  app.get("/api/network/graph", requireAuth, async (c) => c.json(await g(c).networkGraph(c.get("user")!.id)));

  // ── the typed, evidenced projection ──────────────────────────────────────────
  /**
   * The multi-entity graph: users AND the events they were at, every edge carrying the row it
   * came from. Additive — `/api/network/graph` above keeps its legacy shape for the existing
   * canvas renderer, and now delegates here so there is one implementation of visibility.
   */
  app.get("/api/graph", requireAuth, async (c) => {
    const q = c.req.query();
    const r = await proj(c).ego({
      viewerId: c.get("user")!.id,
      hops: q.hops === "1" ? 1 : 2,
      include: parseKinds(q.include),
      collapse: q.collapse === "1",
      maxNodes: clampInt(q.maxNodes, MAX_NODES),
      maxEdges: clampInt(q.maxEdges, MAX_EDGES),
    });
    return c.json(r);
  });

  /**
   * The same graph, ready to draw over the real Bay: only the parts with coordinates.
   *
   * Users are absent by construction — they have no coordinates in this database and must not
   * be given any, because every candidate source (`shadows.lat/lng`, `place_reports.lat/lng`,
   * `network_invites.lat/lng`, `media.lat/lng`) is a GPS attestation of where a body was. So
   * the nodes are events and the arcs mean "N people you know were at both", which is a better
   * map anyway: it shows how the Bay's scenes interlock.
   *
   * Arc GEOMETRY is built on the client — a sampled polyline is ~20× the payload of two
   * endpoints and the bend is viewport-dependent.
   */
  app.get("/api/graph/geo", requireAuth, async (c) => {
    const q = c.req.query();
    const r = await proj(c).ego({
      viewerId: c.get("user")!.id,
      hops: q.hops === "1" ? 1 : 2,
      // Collapsed, because a user↔user arc between two VENUES is the thing worth drawing.
      collapse: true,
      maxNodes: clampInt(q.maxNodes, MAX_NODES),
      maxEdges: clampInt(q.maxEdges, MAX_EDGES),
    });

    // Keep only what can actually be placed, and say how much that dropped.
    const placeable = new Map(r.nodes.filter((n) => n.lat != null && n.lng != null).map((n) => [n.id, n]));
    const noCoords = r.nodes.length - placeable.size;
    const edges = r.edges.filter((e) => placeable.has(e.a) && placeable.has(e.b));
    return c.json({
      nodes: [...placeable.values()],
      edges,
      omitted: { ...r.omitted, noCoords: r.omitted.noCoords + noCoords, edges: r.omitted.edges + (r.edges.length - edges.length) },
    });
  });

  /**
   * "Why am I connected to this person?" — the shortest EVIDENCED path, rendered as one
   * sentence per hop.
   *
   * The search runs over the already-filtered projection, so an invisible person cannot appear
   * as a waypoint. `exhausted` distinguishes "not connected" from "the hub was too big to
   * search", which are different answers and deserve different copy.
   */
  app.get("/api/graph/path/:targetId", requireAuth, async (c) => {
    const me = c.get("user")!.id;
    const target = c.req.param("targetId");
    const r = await proj(c).ego({ viewerId: me, hops: 2 });
    const nodes = new Map(r.nodes.map((n) => [n.id, n]));
    const from = nodeId("user", me);
    const to = target.includes(":") ? target : nodeId("user", target);
    if (!nodes.has(to)) return c.json({ path: null, reasons: [], why: [], exhausted: false, visible: false });

    const found = findPath(from, to, r.edges);
    const reasons = directReasons(from, to, r.edges);
    return c.json({
      path: found.path,
      exhausted: found.exhausted,
      visible: true,
      /** Every distinct direct reason — richer than any single path. */
      reasons: reasons.map((e) => describeEdge(e, nodes)),
      /** The path itself, as sentences. */
      why: found.path ? explainPath(found.path, nodes) : [],
      nodes: found.path ? found.path.nodes.map((id) => nodes.get(id)).filter(Boolean) : [],
    });
  });

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
  app.get("/api/communities/:id", optionalAuth, async (c) => {
    const id = c.req.param("id");
    const community = await g(c).community(id);
    if (!community) return c.json({ error: "not found" }, 404);
    const q = c.req.query("metric");
    const metric = q === "intros" ? "intros" : q === "nps" ? "nps" : "points";
    return c.json({ community, members: await g(c).communityMembers(id), metric, rankings: await g(c).communityRankings(id, metric) });
  });
  app.get("/api/rankings", optionalAuth, async (c) => {
    const q = c.req.query("metric");
    const metric = q === "intros" ? "intros" : q === "nps" ? "nps" : "points";
    return c.json({ metric, rows: await g(c).rankings(metric) });
  });

  return app;
}
