import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { IntegrationsRepo, type Provider } from "../../storage/d1/integrations-repo";
import { requireAuth } from "../../auth/middleware";
import { generateIcs, parseIcs, type IcsEvent } from "../../integrations/ics";

/* eslint-disable @typescript-eslint/no-explicit-any */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const ir = (c: { env: Env }) => new IntegrationsRepo(c.env.DB);
const PROVIDERS = ["luma", "eventbrite", "meetup", "calendar", "linkedin", "telegram"] as const;
const newToken = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");

/** The signed-in user's upcoming RSVP'd events, as ICS input. */
async function myEvents(env: Env, userId: string): Promise<IcsEvent[]> {
  const res = await env.DB
    .prepare(
      `SELECT e.id, e.title, e.start_utc AS startUtc, e.end_utc AS endUtc, e.venue_name AS venueName, e.url
       FROM rsvps r JOIN events e ON e.id = r.event_id
       WHERE r.user_id = ? AND r.status IN ('going','interested') AND e.start_utc >= ?
       ORDER BY e.start_utc`,
    )
    .bind(userId, new Date(Date.now() - 12 * 3600 * 1000).toISOString())
    .all<any>();
  return (res.results ?? []).map((e) => ({ id: e.id, title: e.title, startUtc: e.startUtc, endUtc: e.endUtc, venueName: e.venueName, url: e.url }));
}
function ics(c: any, body: string) {
  c.header("content-type", "text/calendar; charset=utf-8");
  c.header("cache-control", "no-cache");
  return c.body(body);
}

export function integrationRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  app.get("/api/integrations", requireAuth, async (c) => c.json({ accounts: await ir(c).listAccounts(c.get("user")!.id) }));

  // "People you may know" — imported connections who are already Bay members.
  app.get("/api/integrations/suggestions", requireAuth, async (c) =>
    c.json({ suggestions: await ir(c).suggestionsFromImports(c.get("user")!.id) }),
  );

  // imported items (events copied in, LinkedIn connections, …)
  app.get("/api/integrations/:provider/items", requireAuth, async (c) => {
    const provider = c.req.param("provider") as Provider;
    if (!PROVIDERS.includes(provider as any)) return c.json({ error: "unknown provider" }, 404);
    return c.json({ items: await ir(c).listImported(c.get("user")!.id, provider) });
  });

  app.post("/api/integrations/:provider/connect", requireAuth, async (c) => {
    const provider = c.req.param("provider") as Provider;
    if (!PROVIDERS.includes(provider as any)) return c.json({ error: "unknown provider" }, 404);
    const token = await c.req.json().catch(() => ({}));
    await ir(c).connectAccount(c.get("user")!.id, provider, token);
    return c.json({ ok: true });
  });

  // Import events from an uploaded/linked .ics (Luma/Google/Outlook) or explicit items.
  app.post("/api/integrations/:provider/import", requireAuth, async (c) => {
    const provider = c.req.param("provider") as Provider;
    if (!PROVIDERS.includes(provider as any)) return c.json({ error: "unknown provider" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { ics?: string; items?: any[] };
    let items = body.items ?? [];
    if (body.ics) {
      items = parseIcs(body.ics).map((e) => ({ externalId: e.externalId, kind: "event", payload: e }));
    }
    if (!items.length) return c.json({ error: "nothing to import" }, 400);
    const inserted = await ir(c).importItems(c.get("user")!.id, provider, items);
    return c.json({ ok: true, imported: inserted, total: items.length });
  });

  // ── my agenda / itinerary (JSON) ──────────────────────────────────────────────
  app.get("/api/me/agenda", requireAuth, async (c) => {
    const me = c.get("user")!;
    const res = await c.env.DB
      .prepare(
        `SELECT e.id, e.title, e.start_utc AS startUtc, e.end_utc AS endUtc, e.timezone,
                e.venue_name AS venueName, e.city, e.url, e.image_url AS imageUrl, e.latitude, e.longitude, r.status
           FROM rsvps r JOIN events e ON e.id = r.event_id
          WHERE r.user_id = ? AND r.status IN ('going','interested','went') AND e.start_utc >= ?
          ORDER BY e.start_utc`,
      )
      .bind(me.id, new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .all<any>();
    return c.json({ events: res.results ?? [] });
  });

  // ── calendar feed (plan/schedule) ─────────────────────────────────────────────
  // Direct download (cookie-authed).
  app.get("/api/me/calendar.ics", requireAuth, async (c) => {
    const me = c.get("user")!;
    return ics(c, generateIcs(await myEvents(c.env, me.id), { name: `The Bay — ${me.displayName}` }));
  });

  // A stable, subscribable URL (calendar apps fetch it without cookies).
  app.post("/api/me/calendar/subscribe", requireAuth, async (c) => {
    const token = newToken();
    await c.env.SESSIONS.put(`cal:${token}`, c.get("user")!.id, { expirationTtl: 400 * 24 * 3600 });
    const origin = c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;
    return c.json({ url: `${origin}/api/cal/${token}.ics` });
  });
  app.get("/api/cal/:token", async (c) => {
    const token = c.req.param("token").replace(/\.ics$/, "");
    const userId = await c.env.SESSIONS.get(`cal:${token}`);
    if (!userId) return c.text("not found", 404);
    return ics(c, generateIcs(await myEvents(c.env, userId), { name: "The Bay" }));
  });

  return app;
}
