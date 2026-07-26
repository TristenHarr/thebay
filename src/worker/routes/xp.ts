import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { XpRepo } from "../../storage/d1/xp-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";

/**
 * Experience (XP) — the game's leveling track (see src/core/xp/levels + xp-repo).
 * Separate from social `points`: XP is earned by playing (movement, orbs, catches,
 * crawls — added in later stages) and drives your level + the movement leaderboard.
 * This is the read surface the level bar + leaderboard render from.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new XpRepo(c.env.DB);

export function xpRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // Your Experience: level, progress within it, and where the XP came from.
  app.get("/api/me/xp", requireAuth, async (c) => {
    const uid = c.get("user")!.id;
    const info = await repo(c).levelInfo(uid);
    return c.json({ ...info, breakdown: await repo(c).breakdown(uid) });
  });

  // The XP leaderboard — total XP by default, or a single kind (e.g. ?metric=movement).
  app.get("/api/xp/leaderboard", optionalAuth, async (c) => {
    const metric = c.req.query("metric") || "xp";
    return c.json({ metric, rows: await repo(c).leaderboard(metric, 50) });
  });

  return app;
}
