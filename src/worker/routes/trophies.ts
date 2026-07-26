import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { TrophyRepo } from "../../storage/d1/trophy-repo";
import { requireAuth } from "../../auth/middleware";

/**
 * Trophies — the read surface for the whole catalog, earned and locked alike.
 *
 * The client used to carry its own `{icon, title, desc}` table, which is how it came
 * to promise three trophies no server code granted and to render two it did as a bare
 * 🏅. Now the catalog ships from `src/core/trophies/catalog.ts` and the client renders
 * whatever it is told, so the two cannot disagree.
 *
 * GET **reconciles**, deliberately. `TrophyRepo.sync` is idempotent (`dedup_key`
 * UNIQUE on both the award and the XP row), so making the read path grant means a
 * trophy appears the moment you look — no cron to fall behind, no backfill job to
 * forget, and no "why didn't I get it" support thread. The cost is one extra write on
 * the first read after you earn something, and zero writes on every read after that.
 * `justUnlocked` is what that reconcile produced, so the client can celebrate it.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new TrophyRepo(c.env.DB);

export function trophyRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  app.get("/api/trophies", requireAuth, async (c) => {
    const uid = c.get("user")!.id;
    const r = repo(c);
    const { granted } = await r.sync(uid);
    return c.json({ ...(await r.view(uid)), justUnlocked: granted });
  });

  // Explicit reconcile, for right after an action that should have earned something.
  app.post("/api/trophies/sync", requireAuth, async (c) => c.json(await repo(c).sync(c.get("user")!.id)));

  return app;
}
