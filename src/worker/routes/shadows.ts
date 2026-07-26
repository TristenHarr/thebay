import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { ShadowsRepo } from "../../storage/d1/shadows-repo";
import { SocialRepo } from "../../storage/d1/social-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { inBay } from "../../core/geo";
import { ShadowPostSchema, ShadowReactSchema } from "../../../shared/schema";

/**
 * Shadows — the ephemeral, location-sharded live board (see migrations/0011,
 * src/storage/d1/shadows-repo, src/core/geohash). Reads are cheap and public:
 * a bounded set of fine cells for a zoomed-in viewport, or a coarse edge-cached
 * heat aggregate for the whole-Bay view. Writes are signed-in, Bay-GPS-gated, and
 * 1-per-account (a new shadow replaces your old). Realtime fan-out to the per-cell
 * Durable Object + AI moderation are layered on in later stages; this is the
 * durable HTTP surface they build on.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new ShadowsRepo(c.env.DB);

const MAX_CELLS = 64; // bounds the zoomed-in fan-out (one query/WS per visible cell)
const HEAT_MIN_P = 1;
const HEAT_MAX_P = 7;
const CELL_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,9}$/; // base32 geohash alphabet

export function shadowsRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // Live read: active shadows for a bounded set of fine cells (a zoomed-in viewport).
  app.get("/api/shadows", optionalAuth, async (c) => {
    const raw = (c.req.query("cells") || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const cells = [...new Set(raw)].filter((x) => CELL_RE.test(x)).slice(0, MAX_CELLS);
    const shadows = cells.length ? await repo(c).activeInCells(cells) : [];
    return c.json({ shadows });
  });

  // Zoomed-out heat: one cheap grouped count, short-TTL edge-cached — the whole-Bay
  // view never fans out per shadow, so it scales no matter how many cells are live.
  app.get("/api/shadows/heat", async (c) => {
    const p = Math.min(HEAT_MAX_P, Math.max(HEAT_MIN_P, Math.trunc(Number(c.req.query("precision")) || 4)));
    const cells = await repo(c).heat(p);
    c.header("Cache-Control", "public, max-age=10");
    return c.json({ precision: p, cells });
  });

  // The shadow you currently hold (drives the composer's "replace your shadow?").
  app.get("/api/shadows/mine", requireAuth, async (c) => c.json({ active: await repo(c).activeByAuthor(c.get("user")!.id) }));

  // Cast a shadow — signed in AND physically in the Bay (GPS gate). Replaces your
  // previous shadow (1-per-account, handled in the repo).
  app.post("/api/shadows", requireAuth, async (c) => {
    const parsed = ShadowPostSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad shadow", issues: parsed.error.issues.slice(0, 5) }, 400);
    const s = parsed.data;
    if (!inBay(s.lat, s.lng)) return c.json({ error: "you must be in the Bay to cast a shadow" }, 403);
    if (s.kind === "connection" && s.connectionUserId) {
      const who = await new SocialRepo(c.env.DB).getUserById(s.connectionUserId);
      if (!who) return c.json({ error: "that person isn't on the Bay" }, 400);
    }
    const res = await repo(c).post(c.get("user")!.id, { ...s, body: s.body?.trim() || null });
    return c.json({ ok: true, ...res });
  });

  // React (toggle on/off) — from the curated palette (validated in the schema).
  app.post("/api/shadows/:id/react", requireAuth, async (c) => {
    const parsed = ShadowReactSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad reaction" }, 400);
    const uid = c.get("user")!.id;
    try {
      if (parsed.data.on) await repo(c).react(c.req.param("id"), uid, parsed.data.emoji);
      else await repo(c).unreact(c.req.param("id"), uid, parsed.data.emoji);
    } catch {
      return c.json({ error: "no such shadow" }, 409); // FK: reacted to a gone shadow
    }
    return c.json({ ok: true });
  });

  // Report → hide pending re-audit (a moderator/self-audit restores or blocks it).
  app.post("/api/shadows/:id/report", requireAuth, async (c) => {
    await repo(c).report(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Delete your own shadow (no-op for anyone else).
  app.delete("/api/shadows/:id", requireAuth, async (c) => c.json({ ok: true, deleted: await repo(c).deleteOwn(c.req.param("id"), c.get("user")!.id) }));

  return app;
}
