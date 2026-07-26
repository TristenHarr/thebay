import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { CatchesRepo } from "../../storage/d1/catches-repo";
import { XpRepo } from "../../storage/d1/xp-repo";
import { requireAuth } from "../../auth/middleware";
import { CatchScanSchema } from "../../../shared/schema";

/**
 * Catches — the founder Pokédex. "The catches are other people." Show your rotating
 * catch QR (`/token`), someone scans it (`/scan`) → they add you to their collection
 * with a snapshot of your derived stats + rarity, and earn rarity-scaled XP. You
 * catch each founder once. `/api/catches` is your collection; `/api/me/stats` is your
 * own card (scout yourself).
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new CatchesRepo(c.env.DB);

export function catchesRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // Mint MY rotating catch QR (revokes the previous one).
  app.post("/api/catches/token", requireAuth, async (c) => c.json({ token: await repo(c).mintToken(c.get("user")!.id) }));

  // Scan someone's catch QR → catch them.
  app.post("/api/catches/scan", requireAuth, async (c) => {
    const parsed = CatchScanSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad scan" }, 400);
    const res = await repo(c).capture(c.get("user")!.id, parsed.data.token);
    if (res.status !== "ok") return c.json({ ok: false, reason: res.status }, res.status === "invalid" ? 404 : 200);
    const level = await new XpRepo(c.env.DB).levelInfo(c.get("user")!.id);
    return c.json({ ok: true, caught: res.caught, xp: res.xp, level });
  });

  // My Pokédex — everyone I've caught.
  app.get("/api/catches", requireAuth, async (c) => c.json({ pokedex: await repo(c).pokedex(c.get("user")!.id) }));

  // My own founder card (derived stats).
  app.get("/api/me/stats", requireAuth, async (c) => c.json({ stats: await repo(c).statsFor(c.get("user")!.id) }));

  return app;
}
