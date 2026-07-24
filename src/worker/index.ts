/**
 * The Bay — Cloudflare Worker entry.
 *
 * Serves the live API (events + auth + social) from D1/R2/KV/DO, an authenticated
 * ingest endpoint the local scraper pushes into, the new /app SPA, and falls back
 * to the static assets (existing dashboard, embed widget, events.json). The static
 * site keeps working unchanged; everything else is additive.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { CanonicalEvent } from "../core/models/event";
import type { EventFilter } from "../storage/repository";
import { D1Repo } from "../storage/d1/d1-repo";
import { IngestPayloadSchema, GeocodePayloadSchema } from "../../shared/schema";
import type { Env, Vars } from "./env";
import { routeFactories } from "./routes";
import citiesJson from "../../config/cities.json";
import categoriesJson from "../../config/categories.json";

export { GroupRoom } from "../realtime/group-room";

function parseFilter(q: Record<string, string>): EventFilter {
  const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const num = (v?: string) => (v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  const truthy = (v?: string) => v === "1" || v === "true";
  let from = q.from;
  if (!from && !truthy(q.past)) from = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  return {
    from: from || undefined,
    to: q.to || undefined,
    cities: list(q.city),
    categories: list(q.category),
    sources: list(q.source),
    free: truthy(q.free) ? true : undefined,
    minScore: num(q.minScore),
    q: q.q || undefined,
    starred: truthy(q.starred) ? true : undefined,
    includeHidden: truthy(q.includeHidden),
    sort: q.sort === "score" ? "score" : "start",
    limit: num(q.limit),
    offset: num(q.offset),
  };
}

const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

// Security headers applied to EVERY response — including redirects and errors.
const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
};
/** Stamp the hardening headers onto a response (asset responses can have
 *  immutable headers, so fall back to rebuilding it). */
export function harden(res: Response): Response {
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  } catch {
    const r = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
    return r;
  }
}

// Force HTTPS (Safari flags a reachable http:// origin as "not secure").
app.use("*", async (c, next) => {
  const visitor = c.req.header("cf-visitor") || "";
  if (visitor.includes('"scheme":"http"')) {
    const u = new URL(c.req.url);
    u.protocol = "https:";
    return harden(c.redirect(u.toString(), 301));
  }
  await next();
  c.res = harden(c.res);
});

// Open CORS on the API — free, public read API for humans & agents.
app.use("/api/*", cors({ origin: "*" }));

// Defense-in-depth: turn an uncaught DB constraint violation (e.g. an FK to a
// deleted/bogus event or user id that slipped past a handler check) into a clean
// 409 for API callers instead of a raw 500 stack. Non-API errors rethrow.
app.onError((err, c) => {
  const msg = String((err as Error)?.message || err);
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/auth/")) {
    if (/FOREIGN KEY|constraint|UNIQUE/i.test(msg)) return harden(c.json({ error: "conflict" }, 409));
    return harden(c.json({ error: "server_error" }, 500));
  }
  return harden(c.text("server error", 500));
});

// ── events API (public) ───────────────────────────────────────────────────────
app.get("/api/health", (c) => c.json({ ok: true }));
app.get("/api/events", async (c) => c.json(await new D1Repo(c.env.DB).queryEvents(parseFilter(c.req.query()))));
app.get("/api/event/:id", async (c) => {
  const e = await new D1Repo(c.env.DB).getEventById(c.req.param("id"));
  return e ? c.json(e) : c.json({ error: "not found" }, 404);
});
app.get("/api/sources", async (c) => c.json(await new D1Repo(c.env.DB).listSources()));
app.get("/api/cities", (c) => c.json(citiesJson));
app.get("/api/categories", (c) => c.json(categoriesJson));
app.get("/api/runs", async (c) => c.json(await new D1Repo(c.env.DB).listRuns(20)));
app.get("/api/events.json", async (c) => {
  const { events, total } = await new D1Repo(c.env.DB).queryEvents({
    includeHidden: c.req.query("includeHidden") === "1",
    limit: 100_000,
    sort: "start",
  });
  return c.json({ generatedAt: new Date().toISOString(), count: events.length, total, events });
});

// ── admin ingest (bearer-gated) ────────────────────────────────────────────────
app.post("/api/admin/ingest", async (c) => {
  const token = c.env.INGEST_TOKEN;
  if (!token || c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
  const parsed = IngestPayloadSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad payload", issues: parsed.error.issues.slice(0, 5) }, 400);
  const result = await new D1Repo(c.env.DB).upsertEvents(parsed.data.events as CanonicalEvent[]);
  return c.json({ ok: true, ...result });
});

// Backfill event coordinates (from the local geocoder). Bearer-gated.
app.post("/api/admin/geocode", async (c) => {
  const token = c.env.INGEST_TOKEN;
  if (!token || c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
  const parsed = GeocodePayloadSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad payload" }, 400);
  const stmts = parsed.data.items.map((i) =>
    c.env.DB.prepare("UPDATE events SET latitude = ?, longitude = ? WHERE id = ?").bind(i.lat, i.lng, i.id),
  );
  for (let k = 0; k < stmts.length; k += 200) await c.env.DB.batch(stmts.slice(k, k + 200));
  return c.json({ ok: true, updated: parsed.data.items.length });
});

// ── API route modules (single source of truth: src/worker/routes/index.ts) ─────
for (const make of routeFactories) app.route("/", make());

// ── the /app SPA (history-routed) ──────────────────────────────────────────────
// /app → /app/; any /app/* path without a file extension is a client route and
// serves the shell; real asset files (…/assets/x.js) fall through to ASSETS.
app.get("/app", (c) => c.redirect("/app/", 302));
app.get("/app/*", (c) => {
  const url = new URL(c.req.url);
  const seg = url.pathname.split("/").pop() || "";
  if (seg.includes(".")) return c.env.ASSETS.fetch(c.req.raw); // real asset
  return c.env.ASSETS.fetch(new Request(new URL("/app/", url).toString())); // SPA route → shell
});

// ── static assets (dashboard, embed, events.json, /app/ shell + bundles) ───────
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
