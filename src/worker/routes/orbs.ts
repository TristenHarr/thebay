import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { XpRepo } from "../../storage/d1/xp-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { haversineKm } from "../../core/geofence";
import { orbsForCell, findOrb, epochFor, PICKUP_RADIUS_M, type Orb } from "../../core/xp/orbs";
import { OrbPickupSchema } from "../../../shared/schema";

/**
 * XP orbs — floating collectibles on the map. Orbs are DETERMINISTIC (no spawn
 * table): `GET /api/orbs?cells=` derives the current-epoch orbs for the visible
 * cells and drops the ones you've already grabbed. `POST /api/orbs/pickup` re-derives
 * the orb from its id, verifies you're within PICKUP_RADIUS, and grants its XP once
 * (dedup-keyed per orb per user). Semi-cheatable like the rest — a spoofer can grab
 * them, but each orb pays a user exactly once per epoch.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const CELL_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,9}$/;
const MAX_CELLS = 48;

/** Which of these orb ids the user has already collected (by dedup key). */
async function pickedOf(env: Env, userId: string, orbIds: string[]): Promise<Set<string>> {
  if (!orbIds.length) return new Set();
  const keys = orbIds.map((id) => `orb:${id}:${userId}`);
  const ph = keys.map(() => "?").join(",");
  const r = await env.DB.prepare(`SELECT dedup_key FROM xp_ledger WHERE user_id = ? AND kind = 'orb' AND dedup_key IN (${ph})`).bind(userId, ...keys).all<{ dedup_key: string }>();
  const suffix = `:${userId}`;
  const picked = new Set<string>();
  for (const row of r.results ?? []) picked.add(row.dedup_key.slice(4, -suffix.length)); // strip "orb:" … ":<uid>"
  return picked;
}

export function orbsRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // The orbs currently floating in the visible cells (minus what you've grabbed).
  app.get("/api/orbs", optionalAuth, async (c) => {
    const cells = (c.req.query("cells") || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((x) => CELL_RE.test(x))
      .slice(0, MAX_CELLS);
    const epoch = epochFor(Date.now());
    let orbs: Orb[] = cells.flatMap((cell) => orbsForCell(cell, epoch));
    const me = c.get("user");
    if (me && orbs.length) {
      const picked = await pickedOf(c.env, me.id, orbs.map((o) => o.id));
      orbs = orbs.filter((o) => !picked.has(o.id));
    }
    return c.json({ epoch, orbs });
  });

  // Collect an orb — re-derive it, verify proximity + freshness, grant its XP once.
  app.post("/api/orbs/pickup", requireAuth, async (c) => {
    const parsed = OrbPickupSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad pickup" }, 400);
    const { orbId, lat, lng } = parsed.data;
    const orb = findOrb(orbId);
    if (!orb) return c.json({ ok: false, reason: "no such orb" }, 404);
    if (orb.epoch !== epochFor(Date.now())) return c.json({ ok: false, reason: "faded" });
    const dist = haversineKm(lat, lng, orb.lat, orb.lng) * 1000;
    if (dist > PICKUP_RADIUS_M) return c.json({ ok: false, reason: "too far", dist: Math.round(dist) });
    const uid = c.get("user")!.id;
    const xpRepo = new XpRepo(c.env.DB);
    const granted = await xpRepo.grant(uid, "orb", orb.xp, `orb:${orbId}:${uid}`, { orbId, xp: orb.xp });
    if (!granted) return c.json({ ok: false, reason: "already collected" });
    return c.json({ ok: true, xp: orb.xp, level: await xpRepo.levelInfo(uid) });
  });

  return app;
}
