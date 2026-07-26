import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { D1Repo } from "../../storage/d1/d1-repo";
import { SocialRepo } from "../../storage/d1/social-repo";
import { PlatformRepo } from "../../storage/d1/platform-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import {
  ProfileUpdateSchema,
  RsvpBodySchema,
  ReviewBodySchema,
  GroupCreateSchema,
  MessageBodySchema,
  HostEventSchema,
} from "../../../shared/schema";
import { ulid } from "ulid";

type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;

const social = (c: { env: Env }) => new SocialRepo(c.env.DB);
const events = (c: { env: Env }) => new D1Repo(c.env.DB);

export function socialRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // ── me / profile ──────────────────────────────────────────────────────────
  app.get("/api/me", optionalAuth, async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ user: null });
    return c.json({ user, points: await social(c).myPoints(user.id) });
  });

  app.patch("/api/me", requireAuth, async (c) => {
    const user = c.get("user")!;
    const parsed = ProfileUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
    try {
      const updated = await social(c).updateProfile(user.id, parsed.data);
      return c.json({ user: updated });
    } catch (e) {
      const msg = String(e);
      if (/UNIQUE/i.test(msg) && /handle/i.test(msg)) return c.json({ error: "handle_taken" }, 409);
      return c.json({ error: "update_failed" }, 500);
    }
  });

  // Avatar upload — raw image body → R2, key stored on the user.
  app.post("/api/me/avatar", requireAuth, async (c) => {
    const user = c.get("user")!;
    const type = c.req.header("content-type") || "image/jpeg";
    if (!type.startsWith("image/")) return c.json({ error: "image required" }, 400);
    const key = `avatars/${user.id}`;
    const buf = await c.req.arrayBuffer();
    if (buf.byteLength > 5_000_000) return c.json({ error: "too large (5MB max)" }, 413);
    await c.env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type } });
    await social(c).updateProfile(user.id, { avatarKey: key });
    return c.json({ ok: true, avatarKey: key });
  });

  // Public profile by handle.
  app.get("/api/u/:handle", optionalAuth, async (c) => {
    const s = social(c);
    const target = await s.getUserByHandle(c.req.param("handle"));
    const me = c.get("user");
    if (!target) return c.json({ error: "not found" }, 404);
    // The social toggle gates PUBLIC discoverability — not friends. You can always
    // see your own profile, and anyone you have a friendship (or pending request)
    // with, even if they never turned social on. Strangers still can't see a
    // social-off profile.
    const rel = me && me.id !== target.id ? await s.friendStatus(me.id, target.id) : null;
    const isSelf = target.id === me?.id;
    if (!target.socialEnabled && !isSelf && !rel) return c.json({ error: "not found" }, 404);
    const { email: _e, ...pub } = target;
    void _e;
    return c.json({ profile: pub, points: await s.myPoints(target.id), friendStatus: rel, isMe: isSelf });
  });

  // ── friends ────────────────────────────────────────────────────────────────
  app.get("/api/friends", requireAuth, async (c) => {
    const s = social(c);
    const me = c.get("user")!;
    return c.json({ friends: await s.listFriends(me.id), pending: await s.pendingRequests(me.id) });
  });
  app.post("/api/friends/:userId/request", requireAuth, async (c) => {
    await social(c).requestFriend(c.get("user")!.id, c.req.param("userId"));
    return c.json({ ok: true });
  });
  app.post("/api/friends/:userId/respond", requireAuth, async (c) => {
    const { accept } = (await c.req.json().catch(() => ({}))) as { accept?: boolean };
    await social(c).respondFriend(c.get("user")!.id, c.req.param("userId"), !!accept);
    return c.json({ ok: true });
  });

  // ── RSVP + friends feed ─────────────────────────────────────────────────────
  app.post("/api/events/:id/rsvp", requireAuth, async (c) => {
    const parsed = RsvpBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid status" }, 400);
    const me = c.get("user")!;
    if (!(await events(c).getEventById(c.req.param("id")))) return c.json({ error: "not found" }, 404);
    // Review-gate: you must review your last attended event before registering for
    // a new one. Applies to going/interested; clearing ('none') or 'went' is exempt.
    if (parsed.data.status === "going" || parsed.data.status === "interested") {
      const platform = new PlatformRepo(c.env.DB);
      if (!(await platform.canRsvp(me.id))) {
        return c.json({ error: "review_required", pending: await platform.openObligations(me.id) }, 403);
      }
    }
    await social(c).setRsvp(me.id, c.req.param("id"), parsed.data.status);
    return c.json({ ok: true, status: parsed.data.status, points: await social(c).myPoints(me.id) });
  });

  app.get("/api/feed/friends", requireAuth, async (c) => {
    const s = social(c);
    const me = c.get("user")!;
    const pairs = await s.friendEventIds(me.id);
    const evs = await events(c).getEventsByIds(pairs.map((p) => p.eventId));
    const byId = new Map(evs.map((e) => [e.id, e]));
    const items = pairs
      .map((p) => ({ event: byId.get(p.eventId), friends: p.friends }))
      .filter((x) => x.event)
      .sort((a, b) => (a.event!.startUtc || "").localeCompare(b.event!.startUtc || ""));
    return c.json({ items });
  });

  // ── full event page ─────────────────────────────────────────────────────────
  app.get("/api/event/:id/full", optionalAuth, async (c) => {
    const id = c.req.param("id");
    const event = await events(c).getEventById(id);
    if (!event) return c.json({ error: "not found" }, 404);
    const s = social(c);
    const me = c.get("user");
    const counts = await c.env.DB
      .prepare("SELECT status, COUNT(*) AS n FROM rsvps WHERE event_id = ? GROUP BY status")
      .bind(id)
      .all<{ status: string; n: number }>();
    return c.json({
      event,
      host: await s.eventHost(id),
      attendees: await s.attendees(id),
      friends: me ? await s.friendsAttending(me.id, id) : [],
      reviews: await s.reviews(id),
      photos: await s.photos(id),
      counts: Object.fromEntries((counts.results ?? []).map((r) => [r.status, r.n])),
      myRsvp: me ? await s.getRsvp(me.id, id) : "none",
      canReview: me ? await s.canReview(me.id, id) : false,
    });
  });

  // ── reviews & photos ─────────────────────────────────────────────────────────
  app.post("/api/events/:id/reviews", requireAuth, async (c) => {
    const id = c.req.param("id");
    const me = c.get("user")!;
    const parsed = ReviewBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid review" }, 400);
    if (!(await social(c).canReview(me.id, id))) return c.json({ error: "must have attended" }, 403);
    // Delegate to PlatformRepo so this legacy plural endpoint ALSO clears the
    // review-gate + awards points, staying consistent with POST /review (singular).
    await new PlatformRepo(c.env.DB).reviewEvent(me.id, id, parsed.data.rating, parsed.data.body);
    return c.json({ ok: true });
  });

  app.post("/api/events/:id/photos", requireAuth, async (c) => {
    const id = c.req.param("id");
    const me = c.get("user")!;
    // Only attendees may post photos to an event (also 404s a bogus id via canReview=false).
    if (!(await social(c).canReview(me.id, id))) return c.json({ error: "must have attended" }, 403);
    const type = c.req.header("content-type") || "image/jpeg";
    if (!type.startsWith("image/")) return c.json({ error: "image required" }, 400);
    const buf = await c.req.arrayBuffer();
    if (buf.byteLength > 8_000_000) return c.json({ error: "too large (8MB max)" }, 413);
    const key = `events/${id}/${ulid()}`;
    await c.env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type } });
    await social(c).addPhoto(me.id, id, key, c.req.query("caption") || undefined);
    return c.json({ ok: true, key });
  });

  // Serve R2 images (avatars + event photos).
  app.get("/api/img/*", async (c) => {
    const key = decodeURIComponent(c.req.path.replace(/^\/api\/img\//, ""));
    const obj = await c.env.PHOTOS.get(key);
    if (!obj) return c.notFound();
    return new Response(obj.body as any, {
      headers: {
        "content-type": obj.httpMetadata?.contentType || "image/jpeg",
        "cache-control": "public, max-age=86400",
      },
    });
  });

  // ── groups & chat ─────────────────────────────────────────────────────────
  app.get("/api/groups", requireAuth, async (c) => c.json({ groups: await social(c).myGroups(c.get("user")!.id) }));

  app.post("/api/groups", requireAuth, async (c) => {
    const parsed = GroupCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "name required" }, 400);
    const id = await social(c).createGroup(c.get("user")!.id, parsed.data.name, parsed.data.eventId);
    return c.json({ ok: true, id });
  });

  app.post("/api/groups/:id/join", requireAuth, async (c) => {
    await social(c).joinGroup(c.get("user")!.id, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/groups/:id", requireAuth, async (c) => {
    const s = social(c);
    const id = c.req.param("id");
    const me = c.get("user")!;
    if (!(await s.isMember(me.id, id))) return c.json({ error: "not a member" }, 403);
    return c.json({ members: await s.groupMembers(id), messages: await s.recentMessages(id) });
  });

  app.post("/api/groups/:id/messages", requireAuth, async (c) => {
    const s = social(c);
    const id = c.req.param("id");
    const me = c.get("user")!;
    if (!(await s.isMember(me.id, id))) return c.json({ error: "not a member" }, 403);
    const parsed = MessageBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "message required" }, 400);
    const saved = await s.addMessage(id, me.id, parsed.data.body);
    // fan out to live sockets via the group's Durable Object
    const msg = { id: saved.id, userId: me.id, author: me.displayName, body: parsed.data.body, createdAt: saved.createdAt };
    const stub = c.env.GROUP_ROOM.get(c.env.GROUP_ROOM.idFromName(id));
    c.executionCtx.waitUntil(
      stub.fetch(new Request("https://do/broadcast", { method: "POST", body: JSON.stringify(msg) }) as any) as any,
    );
    return c.json({ ok: true, message: msg });
  });

  // WebSocket upgrade → the group's Durable Object (member-gated).
  app.get("/api/groups/:id/ws", requireAuth, async (c) => {
    const id = c.req.param("id");
    const me = c.get("user")!;
    if (!(await social(c).isMember(me.id, id))) return c.json({ error: "not a member" }, 403);
    const stub = c.env.GROUP_ROOM.get(c.env.GROUP_ROOM.idFromName(id));
    return stub.fetch(new Request("https://do/ws", c.req.raw as any) as any) as any;
  });

  // ── leaderboard ─────────────────────────────────────────────────────────────
  app.get("/api/leaderboard", optionalAuth, async (c) => {
    const me = c.get("user");
    const scope = c.req.query("scope");
    if (scope === "friends" && me) return c.json({ scope: "friends", rows: await social(c).leaderboard(50, me.id) });
    return c.json({ scope: "global", rows: await social(c).leaderboard(50) });
  });

  // ── hosting ─────────────────────────────────────────────────────────────────
  app.post("/api/host", requireAuth, async (c) => {
    const parsed = HostEventSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid event", issues: parsed.error.issues }, 400);
    const id = await social(c).createHostedEvent(c.get("user")!.id, parsed.data);
    return c.json({ ok: true, id });
  });

  return app;
}
