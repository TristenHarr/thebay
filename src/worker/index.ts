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
import { D1Repo } from "../storage/d1/d1-repo";
import { GraphRepo } from "../storage/d1/graph-repo";
import { ShadowsRepo } from "../storage/d1/shadows-repo";
import { IngestPayloadSchema, GeocodePayloadSchema, ScrapeReportSchema } from "../../shared/schema";
import type { Env, Vars } from "./env";
import type { ScheduledController, ExecutionContext } from "@cloudflare/workers-types";
import { routeFactories } from "./routes";
import { requireIngestToken } from "./middleware/bearer";
import { harden } from "./security";
import { apexRedirectUrl } from "./origin";
import citiesJson from "../../config/cities.json";
import { makeCityResolver } from "../core/normalize/normalize";
import { looksOutOfRegion } from "../core/normalize/region";
import { UNKNOWN_CITY } from "../core/models/source";
import categoriesJson from "../../config/categories.json";
import { KeywordTagger } from "../ai/keyword-tagger";
import { enrichSlice } from "./routes/search";
import { parseFilter } from "./event-filter";
import { RankRepo } from "../storage/d1/rank-repo";
import { rankTick } from "../core/rank/train";
import { ScrapeNetRepo } from "../storage/d1/scrape-net-repo";
import { recipeHost } from "../core/scrape/host";
import { seedFoundingMembers, refreshRobots } from "./net-tick";
import sourcesJson from "../../config/sources.json";

export { GroupRoom } from "../realtime/group-room";
export { ShadowCell } from "../realtime/shadow-cell";

const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

// Security headers live in ./security so thebay.news applies the identical set.
export { SECURITY_HEADERS } from "./security";
export { harden };

// Force HTTPS (Safari flags a reachable http:// origin as "not secure").
app.use("*", async (c, next) => {
  // www.thebay.events → thebay.events. A custom domain covers only the exact
  // hostname, so without this the www. form fails to connect entirely.
  const apex = apexRedirectUrl(c.req.url);
  if (apex) return harden(c.redirect(apex, 301));

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
// Public scrape health: when it last ran, how much it got, and whether it's stale.
app.get("/api/scrape-status", async (c) => c.json(await new D1Repo(c.env.DB).scrapeStatus()));
app.get("/api/events.json", async (c) => {
  const { events, total } = await new D1Repo(c.env.DB).queryEvents({
    includeHidden: c.req.query("includeHidden") === "1",
    limit: 100_000,
    sort: "start",
  });
  return c.json({ generatedAt: new Date().toISOString(), count: events.length, total, events });
});

// ── admin ingest (bearer-gated) ────────────────────────────────────────────────
app.post("/api/admin/ingest", requireIngestToken, async (c) => {
  const parsed = IngestPayloadSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad payload", issues: parsed.error.issues.slice(0, 5) }, 400);
  const result = await new D1Repo(c.env.DB).upsertEvents(parsed.data.events as CanonicalEvent[]);
  return c.json({ ok: true, ...result });
});

// Record a scrape run (the local push calls this after ingesting) so production
// gets the run history + freshness that plain event-ingest can't convey. Bearer-gated.
app.post("/api/admin/scrape-report", requireIngestToken, async (c) => {
  const parsed = ScrapeReportSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "bad report", issues: parsed.error.issues.slice(0, 5) }, 400);
  return c.json({ ok: true, runId: await new D1Repo(c.env.DB).recordRun(parsed.data) });
});

// Re-resolve every event's city + fingerprint against the current cities.json and
// dedup in place. Run after the alias set changes so newly-matchable events don't
// re-insert as duplicates on the next scrape. Bearer-gated.
app.post("/api/admin/renormalize", requireIngestToken, async (c) => {
  const resolve = makeCityResolver(citiesJson as any);
  const result = await new D1Repo(c.env.DB).renormalizeCities((e) => resolve(e.city, e.address, e.venueName)?.id ?? UNKNOWN_CITY);
  return c.json({ ok: true, ...result });
});

// Drop confidently out-of-region events (other US states / countries) that leaked
// in via location search. Bearer-gated. Precision-first — see looksOutOfRegion.
app.post("/api/admin/prune-out-of-region", requireIngestToken, async (c) => {
  return c.json({ ok: true, ...(await new D1Repo(c.env.DB).pruneOutOfRegion(looksOutOfRegion)) });
});

// Re-tag the whole catalog (REPLACING categories) with the current keyword tagger.
// Run after the tagger changes — ingest's merge unions categories, so it can add a
// tag but never remove a stale one. Bearer-gated.
app.post("/api/admin/retag", requireIngestToken, async (c) => {
  return c.json({ ok: true, ...(await new D1Repo(c.env.DB).retagAll(new KeywordTagger(categoriesJson as any))) });
});

// Run warm-intros autopilot on demand (same work the cron does). Bearer-gated so
// only the operator can trigger it; the scheduled handler runs it automatically.
app.post("/api/admin/run-autopilot", requireIngestToken, async (c) => {
  return c.json({ ok: true, ...(await new GraphRepo(c.env.DB).runIntroAutopilot()) });
});

// Backfill event coordinates (from the local geocoder). Bearer-gated.
app.post("/api/admin/geocode", requireIngestToken, async (c) => {
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
/**
 * The handshake's short link. Every frame of the animated in-person code encodes
 * `https://thebay.events/j#s=…&t=…&c=…`, kept short so the QR stays low-density enough for a
 * phone camera to read at 400ms per frame.
 *
 * A 302 with no fragment of its own preserves the original fragment, so a stranger whose stock
 * camera app catches ONE frame still lands on the scanner with that frame in hand. One frame is
 * never enough to get in (the server wants four consecutive), but it is enough to get started.
 */
app.get("/j", (c) => c.redirect("/app/handshake", 302));
app.get("/app", (c) => c.redirect("/app/", 302));
app.get("/app/*", (c) => {
  const url = new URL(c.req.url);
  const seg = url.pathname.split("/").pop() || "";
  if (seg.includes(".")) return c.env.ASSETS.fetch(c.req.raw); // real asset
  return c.env.ASSETS.fetch(new Request(new URL("/app/", url).toString())); // SPA route → shell
});

// ── static assets (dashboard, embed, events.json, /app/ shell + bundles) ───────
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// The Worker's fetch handler is the Hono app; the scheduled (cron) handler drives
// warm-intros autopilot so opted-in connectors' intros go out without a manual tap.
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(new GraphRepo(env.DB).runIntroAutopilot());
    ctx.waitUntil(sweepExpiredShadows(env)); // GC shadows past their 24h + their media
    ctx.waitUntil(enrichTick(env)); // tag + embed the next slice of freshly-scraped events
    ctx.waitUntil(rankLearnTick(env)); // label yesterday's impressions, retrain, maybe promote
    ctx.waitUntil(scrapeNetTick(env)); // seed recipes, plan this window's jobs, reclaim dead leases
  },
};

/**
 * Cron slice of the scrape network: keep the work queue true.
 *
 * All three steps are idempotent, which is what makes running them on every 15-minute
 * tick correct rather than wasteful. `seedRecipes` is `INSERT OR IGNORE` on
 * (source_id, version) — it exists so a fresh deployment bootstraps itself from
 * config/sources.json without anyone remembering to run a script, and it never clobbers
 * a live edit or resurrects a retired source. `plan` is `INSERT OR IGNORE` on
 * (recipe_id, window_start), so ticking four times an hour inside a six-hour window
 * creates nothing after the first. `expireLeases` reclaims work from clients that went
 * away — a closed laptop must not hold a source hostage.
 *
 * Errors are swallowed like every other tick's: a throw here would take the autopilot,
 * the shadow sweep, enrichment and the ranking loop down with it, and a skipped round
 * costs nothing the next tick doesn't recover.
 */
async function scrapeNetTick(env: Env): Promise<void> {
  try {
    const net = new ScrapeNetRepo(env.DB);
    // Without this the network can never admit its first member: only trusted/core may vouch,
    // and `network_members` starts empty. Config founds it; humans grow it from there.
    await seedFoundingMembers(env);
    await net.seedRecipes(sourcesJson as any, recipeHost);
    // Ask each host how it wants to be crawled, before crawling it.
    await refreshRobots(env);
    // The scrapers' release cycle: proposals enter shadow, shadows get judged, winners go
    // live. No deploy, no migration, and every decision logged in `recipe_audits`.
    // Idempotent like the rest — `auditVerdict` returns `keep` until the evidence is real,
    // so running this every 15 minutes simply means a candidate is promoted promptly on the
    // pass where it finally qualifies rather than up to a day later.
    await net.promoteProposals();
    await net.auditShadows();
    await net.plan();
    await net.expireLeases();
  } catch {
    /* best-effort — the queue is re-derived from scratch on the next tick */
  }
}

/**
 * Cron slice of the ranking learning loop: label settled impressions, retrain each
 * surface, and promote only what beat the incumbent on a held-out slice.
 *
 * Runs on the same 15-minute tick as everything else, which is far more often than the
 * model can meaningfully change — and that is fine, because it is idempotent and cheap:
 * with too little data it returns "waiting for data" without writing anything, and with
 * enough data the promotion gate rejects a candidate that isn't better. The frequency
 * buys freshness of LABELS (which arrive continuously) rather than of weights.
 *
 * Errors are swallowed for the same reason the other ticks swallow theirs: a throw here
 * would take the autopilot, the shadow sweep and enrichment down with it, and a missed
 * training round costs nothing that the next tick doesn't recover.
 */
async function rankLearnTick(env: Env): Promise<void> {
  try {
    const repo = new RankRepo(env.DB);
    await rankTick(repo);
    await repo.gc(); // retention is enforced by the same tick that creates the data
  } catch {
    /* best-effort — impressions stay unlabelled and the next tick picks them up */
  }
}

/**
 * Cron slice of tag/embed enrichment. Deliberately small: the scraper pushes in
 * bursts, and one bounded slice per 15-minute tick drains a burst over a couple of
 * hours while staying inside the Worker's CPU budget and the LLM spend guard. The
 * work is idempotent on `content_hash`, so a tick that overlaps the previous one
 * re-reads nothing.
 *
 * Shares `enrichSlice` with POST /api/admin/enrich — the operator's manual runs and
 * the cron cannot diverge. Failures are swallowed: enrichment is catch-up work, and
 * a throw here would take the autopilot and shadow sweep down with it.
 */
async function enrichTick(env: Env): Promise<void> {
  try {
    await enrichSlice(env, { limit: 50 });
  } catch {
    /* best-effort — untagged events stay candidates and the next tick retries */
  }
}

/** Cron backstop: hard-delete shadows past their 24h and delete their R2 media.
 *  (Per-cell Durable Object alarms handle the *live* fade; this reaps the storage.) */
async function sweepExpiredShadows(env: Env): Promise<void> {
  try {
    const { mediaKeys } = await new ShadowsRepo(env.DB).deleteExpired();
    for (const key of mediaKeys) {
      try {
        await env.PHOTOS.delete(key);
      } catch {
        /* best-effort — the D1 row is already gone, so it no longer surfaces */
      }
    }
  } catch {
    /* the shadows table may not exist yet (pre-migration) — safe no-op */
  }
}
