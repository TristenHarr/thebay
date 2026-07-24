import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { MediaRepo } from "../../storage/d1/media-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { suggestEventForMedia, type FenceEvent } from "../../core/geofence";
import { ulid } from "ulid";

/* eslint-disable @typescript-eslint/no-explicit-any */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const mr = (c: { env: Env }) => new MediaRepo(c.env.DB);

/** The user's RSVP'd events that have coordinates (for geo/time suggestion). */
async function fenceEvents(env: Env, userId: string): Promise<FenceEvent[]> {
  const res = await env.DB
    .prepare(
      `SELECT e.id, e.start_utc AS startUtc, e.end_utc AS endUtc, e.latitude, e.longitude
       FROM rsvps r JOIN events e ON e.id = r.event_id
       WHERE r.user_id = ? AND r.status IN ('going','went','interested') AND e.latitude IS NOT NULL`,
    )
    .bind(userId)
    .all<any>();
  return res.results ?? [];
}

export function mediaRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // Upload a photo (→ R2 + CDN) or video (→ Cloudflare Stream when configured).
  // Query: kind, eventId?, lat?, lng?, takenAt?, caption?
  app.post("/api/media", requireAuth, async (c) => {
    const me = c.get("user")!;
    const q = c.req.query();
    const kind = q.kind === "video" ? "video" : "photo";
    const type = c.req.header("content-type") || (kind === "video" ? "video/mp4" : "image/jpeg");
    const lat = q.lat ? Number(q.lat) : undefined;
    const lng = q.lng ? Number(q.lng) : undefined;

    if (kind === "video") {
      // Cloudflare Stream direct upload — requires STREAM_TOKEN + CF_ACCOUNT_ID.
      if (!c.env.STREAM_TOKEN || !c.env.CF_ACCOUNT_ID) return c.json({ error: "video not configured" }, 503);
      const buf = await c.req.arrayBuffer();
      if (buf.byteLength > 200_000_000) return c.json({ error: "too large" }, 413);
      const up = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/stream`, {
        method: "POST",
        headers: { authorization: `Bearer ${c.env.STREAM_TOKEN}`, "content-type": type },
        body: buf,
      });
      const j = (await up.json().catch(() => ({}))) as any;
      const streamId = j?.result?.uid;
      if (!streamId) return c.json({ error: "stream upload failed" }, 502);
      const id = await mr(c).addMedia(me.id, { eventId: q.eventId, kind: "video", streamId, lat, lng, takenAt: q.takenAt, caption: q.caption });
      return c.json({ ok: true, id, streamId });
    }

    // Photo → R2 (served via /api/img/*, cached on the CDN).
    if (!type.startsWith("image/")) return c.json({ error: "image required" }, 400);
    const buf = await c.req.arrayBuffer();
    if (buf.byteLength > 12_000_000) return c.json({ error: "too large" }, 413);
    const key = `media/${me.id}/${ulid()}`;
    await c.env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type } });
    const id = await mr(c).addMedia(me.id, { eventId: q.eventId, kind: "photo", r2Key: key, imageId: key, lat, lng, takenAt: q.takenAt, caption: q.caption });

    // Offer a geo/time-fenced event suggestion when the photo isn't already attached.
    let suggestion: string | null = null;
    if (!q.eventId && lat != null && lng != null && q.takenAt) {
      suggestion = suggestEventForMedia(await fenceEvents(c.env, me.id), { lat, lng, takenAt: q.takenAt })?.id ?? null;
    }
    return c.json({ ok: true, id, key, suggestion });
  });

  app.patch("/api/media/:id", requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { eventId?: string; caption?: string };
    await mr(c).setMediaMeta(c.get("user")!.id, c.req.param("id"), body);
    return c.json({ ok: true });
  });
  app.post("/api/media/:id/tag", requireAuth, async (c) => {
    const mediaId = c.req.param("id");
    const { userId } = (await c.req.json().catch(() => ({}))) as { userId?: string };
    if (!userId) return c.json({ error: "userId required" }, 400);
    // Only the media's owner may tag people in it (no tagging in others' media).
    if (!(await mr(c).isOwner(c.get("user")!.id, mediaId))) return c.json({ error: "not your media" }, 403);
    await mr(c).tagUser(mediaId, userId);
    return c.json({ ok: true });
  });

  app.get("/api/me/media", requireAuth, async (c) => c.json({ media: await mr(c).listUserMedia(c.get("user")!.id) }));
  app.get("/api/events/:id/media", optionalAuth, async (c) => c.json({ media: await mr(c).listEventMedia(c.req.param("id")) }));

  return app;
}
