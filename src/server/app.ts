import { Hono } from "hono";
import type { EventFilter, Repository } from "../storage";
import { loadCities, loadCategories } from "../config/load";
import { runScrape } from "../pipeline/pipeline";
import { logger } from "../util/logger";

function parseFilter(q: Record<string, string>): EventFilter {
  const list = (v?: string) =>
    v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const num = (v?: string) =>
    v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined;
  const truthy = (v?: string) => v === "1" || v === "true";

  let from = q.from;
  // Default to "upcoming": hide events that already started (with a 6h grace),
  // unless the caller explicitly asks for past events.
  if (!from && !truthy(q.past)) {
    from = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  }

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

export function createApp(repo: Repository): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/events", async (c) => {
    const result = await repo.queryEvents(parseFilter(c.req.query()));
    return c.json(result);
  });

  app.get("/api/event/:id", async (c) => {
    const e = await repo.getEventById(c.req.param("id"));
    return e ? c.json(e) : c.json({ error: "not found" }, 404);
  });

  app.patch("/api/events/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const flags: { starred?: boolean; hidden?: boolean } = {};
    if (typeof body.starred === "boolean") flags.starred = body.starred;
    if (typeof body.hidden === "boolean") flags.hidden = body.hidden;
    const e = await repo.setEventFlags(c.req.param("id"), flags);
    return e ? c.json(e) : c.json({ error: "not found" }, 404);
  });

  // Full JSON export of ALL events (past + future). Downloadable.
  app.get("/api/events.json", async (c) => {
    const includeHidden = c.req.query("includeHidden") === "1";
    const { events, total } = await repo.queryEvents({
      includeHidden,
      limit: 100_000,
      sort: "start",
    });
    c.header("content-disposition", 'attachment; filename="eventers-events.json"');
    return c.json({
      generatedAt: new Date().toISOString(),
      count: events.length,
      total,
      events,
    });
  });

  app.get("/api/sources", async (c) => c.json(await repo.listSources()));
  app.get("/api/cities", (c) => c.json(loadCities()));
  app.get("/api/categories", (c) => c.json(loadCategories()));
  app.get("/api/runs", async (c) => c.json(await repo.listRuns(20)));

  app.post("/api/scrape", async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const sourceIds = Array.isArray(body.sources)
      ? (body.sources as string[])
      : undefined;
    // Fire-and-forget; the UI polls /api/runs for progress.
    runScrape({ trigger: "manual", repo, sourceIds }).catch((err) =>
      logger.error({ err: err?.message ?? String(err) }, "api scrape failed"),
    );
    return c.json({ started: true });
  });

  return app;
}
