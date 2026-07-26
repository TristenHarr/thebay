import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { CrawlsRepo } from "../../storage/d1/crawls-repo";
import { XpRepo } from "../../storage/d1/xp-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { CrawlCreateSchema, CrawlCheckpointSchema } from "../../../shared/schema";

/**
 * Founder crawls — plan a named route through the city, share it, and mob it
 * together. Reaching each stop is sequential + GPS-verified (waypoint XP); finishing
 * the route pays a bonus. The planned, competitive half of "trails".
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new CrawlsRepo(c.env.DB);

export function crawlsRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  app.get("/api/crawls", optionalAuth, async (c) => c.json({ crawls: await repo(c).list(50) }));

  app.get("/api/crawls/:id", optionalAuth, async (c) => {
    const detail = await repo(c).get(c.req.param("id"));
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/crawls", requireAuth, async (c) => {
    const parsed = CrawlCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad crawl", issues: parsed.error.issues.slice(0, 5) }, 400);
    return c.json({ ok: true, id: await repo(c).create(c.get("user")!.id, parsed.data) });
  });

  app.post("/api/crawls/:id/join", requireAuth, async (c) => {
    await repo(c).join(c.get("user")!.id, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/crawls/:id/checkpoint", requireAuth, async (c) => {
    const parsed = CrawlCheckpointSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad checkpoint" }, 400);
    const uid = c.get("user")!.id;
    const res = await repo(c).checkpoint(uid, c.req.param("id"), parsed.data.stopIdx, parsed.data.lat, parsed.data.lng);
    if (res.status !== "ok") return c.json({ ok: false, ...res });
    return c.json({ ok: true, ...res, level: await new XpRepo(c.env.DB).levelInfo(uid) });
  });

  return app;
}
