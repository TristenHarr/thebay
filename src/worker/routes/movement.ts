import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { MovementRepo } from "../../storage/d1/movement-repo";
import { XpRepo } from "../../storage/d1/xp-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { requireAdmin } from "../../auth/admin";
import { inBay } from "../../core/geo";
import { MovementPingSchema } from "../../../shared/schema";

/**
 * Mobbing — live movement → Experience. A ping is Bay-GPS-gated, server-measures the
 * distance from your last point (never trusts the client), awards capped XP, and
 * records speed + a flag for teleports (semi-cheatable by design; the tracker sees
 * cheaters). Your recent pings are your fading trail; recent PUBLIC pings are the
 * anonymized "living map". The admin tracker is the who's-earning-what view.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new MovementRepo(c.env.DB);
const CELL_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,9}$/;
const MAX_CELLS = 64;
const TRAIL_HOURS = 3;
const LIVE_SECONDS = 60;

export function movementRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // A movement ping — signed in + physically in the Bay. Returns the segment result
  // and your (possibly new) level so the client can celebrate a level-up.
  app.post("/api/movement/ping", requireAuth, async (c) => {
    const parsed = MovementPingSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad ping" }, 400);
    const { lat, lng, scope } = parsed.data;
    if (!inBay(lat, lng)) return c.json({ error: "you must be in the Bay to mob" }, 403);
    const uid = c.get("user")!.id;
    const res = await repo(c).ping(uid, lat, lng, scope);
    const level = await new XpRepo(c.env.DB).levelInfo(uid);
    return c.json({ ...res, level });
  });

  // Your own fading breadcrumb trail (last few hours).
  app.get("/api/movement/trail", requireAuth, async (c) => {
    const since = new Date(Date.now() - TRAIL_HOURS * 3_600_000).toISOString();
    return c.json({ trail: await repo(c).trail(c.get("user")!.id, since) });
  });

  // The living map: anonymized recent PUBLIC dots in the visible cells (poll-based;
  // a per-cell presence DO is a later optimization). Open — the ambient life is public.
  app.get("/api/movement/live", optionalAuth, async (c) => {
    const cells = (c.req.query("cells") || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((x) => CELL_RE.test(x))
      .slice(0, MAX_CELLS);
    const since = new Date(Date.now() - LIVE_SECONDS * 1000).toISOString();
    return c.json({ dots: cells.length ? await repo(c).liveDots(cells, since) : [] });
  });

  // Admin movement tracker — who's earning movement XP, how far, how fast, how flagged.
  app.get("/api/admin/movement", requireAdmin, async (c) => {
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    return c.json({ rows: await repo(c).tracker(since, 200) });
  });

  return app;
}
