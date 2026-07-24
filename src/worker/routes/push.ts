import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireAuth } from "../../auth/middleware";
import { PlatformRepo } from "../../storage/d1/platform-repo";

/* eslint-disable @typescript-eslint/no-explicit-any */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;

export function pushRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();
  const plat = (c: any) => new PlatformRepo(c.env.DB);

  // The browser needs the VAPID public key to create a subscription.
  app.get("/api/push/key", (c) => c.json({ key: c.env.VAPID_PUBLIC_KEY ?? null, enabled: !!c.env.VAPID_PUBLIC_KEY }));

  app.post("/api/me/push/subscribe", requireAuth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) return c.json({ error: "invalid subscription" }, 400);
    await plat(c).savePushSub(c.get("user")!.id, { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth });
    return c.json({ ok: true });
  });

  app.post("/api/me/push/unsubscribe", requireAuth, async (c) => {
    const { endpoint } = (await c.req.json().catch(() => ({}))) as { endpoint?: string };
    if (endpoint) await plat(c).deletePushSub(c.get("user")!.id, endpoint);
    return c.json({ ok: true });
  });

  return app;
}
