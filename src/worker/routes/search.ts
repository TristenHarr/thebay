import { Hono } from "hono";
import { z } from "zod";
import type { Env, Vars } from "../env";
import { SearchRepo, type SearchFilterInput, type SearchSort } from "../../storage/d1/search-repo";
import { understandQuery, WINDOWS } from "../../core/search/understand";
import { windowRange } from "../../core/search/window";
import { enrichEvents, embedAndUpsert, vectorCandidates } from "../../ai/enrich";
import { MAX_QUERY_TAGS, type TagVocabEntry } from "../../core/search/vocab";

/**
 * Hybrid event search: FTS5 + vector, RRF-fused, with natural-language query
 * understanding — plus the bounded admin jobs that keep the indexes fed.
 *
 * The whole surface is designed to degrade in layers rather than fail:
 *
 *   no OPENROUTER_API_KEY → deterministic query parsing (regex + tag vocabulary)
 *   no VECTORIZE / no AI  → FTS5 + recency + quality only
 *   no FTS match at all   → structured filters, browse ordering
 *
 * Every one of those is a *worse* search, never a broken one, and the response
 * says which path ran (`query.source`, `used`) so a degradation is visible.
 *
 * Routes are thin by house rule: parse → understand → repo → json. Ranking lives
 * in `core/search/rank`, parsing in `core/search/parse`, SQL in `SearchRepo`.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;

const repo = (c: { env: Env }) => new SearchRepo(c.env.DB);

/** Admin jobs are bearer-gated with INGEST_TOKEN, same as /api/admin/ingest. */
const authed = (c: { env: Env; req: { header(n: string): string | undefined } }) => {
  const token = c.env.INGEST_TOKEN;
  return !!token && c.req.header("authorization") === `Bearer ${token}`;
};

const str = (max: number) => z.string().max(max);
const strList = (max: number) => z.array(z.string().max(120)).max(max);

const SearchBody = z.object({
  q: str(400).optional(),
  filters: z
    .object({
      free: z.boolean().optional(),
      tags: strList(MAX_QUERY_TAGS).optional(),
      near: str(60).optional(),
      cities: strList(20).optional(),
      sources: strList(20).optional(),
      window: z.enum(WINDOWS).optional(),
      from: str(40).optional(),
      to: str(40).optional(),
      minScore: z.number().min(0).max(100).optional(),
      includeHidden: z.boolean().optional(),
    })
    .optional(),
  sort: z.enum(["relevance", "soonest", "interesting"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(5000).optional(),
  /** false ⇒ skip the model and parse deterministically (cheap, and what tests use). */
  understand: z.boolean().optional(),
  /** false ⇒ skip the vector leg even when Vectorize is bound. */
  semantic: z.boolean().optional(),
});
type SearchBodyT = z.infer<typeof SearchBody>;

const VocabBody = z.object({
  tags: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+:[a-z0-9+.-]+$/, "tag ids are 'facet:slug'"),
        facet: z.string().min(1).max(32),
        label: z.string().min(1).max(80),
        keywords: z.array(z.string().max(60)).max(200).optional(),
        emoji: z.string().max(8).nullish(),
        color: z.string().max(16).nullish(),
        status: z.enum(["active", "proposed", "retired"]).optional(),
      }),
    )
    .min(1)
    .max(200),
});

/** Query-string form of the JSON body, so `curl '/api/search?q=…'` works for
 *  humans and agents. Same handler, same semantics. */
function bodyFromQuery(q: Record<string, string>): SearchBodyT {
  const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const num = (v?: string) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const bool = (v?: string) => (v == null || v === "" ? undefined : v === "1" || v === "true");
  const win = WINDOWS.find((w) => w === q.window);
  return SearchBody.parse({
    q: q.q || undefined,
    filters: {
      free: bool(q.free),
      // `tag=` mirrors the singular `city=`/`source=` of /api/events; `tags=` reads
      // more naturally for a multi-value param. Accept both.
      tags: list(q.tags ?? q.tag)?.slice(0, MAX_QUERY_TAGS),
      near: q.near || undefined,
      cities: list(q.city)?.slice(0, 20),
      sources: list(q.source)?.slice(0, 20),
      window: win,
      from: q.from || undefined,
      to: q.to || undefined,
      minScore: num(q.minScore),
    },
    sort: (["relevance", "soonest", "interesting"] as const).find((s) => s === q.sort),
    limit: num(q.limit),
    offset: num(q.offset),
    understand: bool(q.understand),
    semantic: bool(q.semantic),
  });
}

async function runSearch(c: any, body: SearchBodyT) {
  const env: Env = c.env;
  const r = repo(c);
  const vocab: TagVocabEntry[] = await r.listVocab();
  const raw = (body.q ?? "").trim();
  const asked = body.filters ?? {};

  const understood = await understandQuery(raw, vocab, {
    // `understand: false` (and a missing key) both land on the deterministic parser.
    model:
      body.understand === false
        ? {}
        : { openrouterKey: env.OPENROUTER_API_KEY ?? null, model: env.OPENROUTER_MODEL_FAST ?? null, env },
    cache: env.SESSIONS ?? null, // json-llm namespaces its keys under `llm:`
    budget: env.LLM_DAILY_BUDGET_USD
      ? { kv: env.SESSIONS, dailyUsd: Number(env.LLM_DAILY_BUDGET_USD) || 0 }
      : null,
  });

  // An explicit UI selection always beats an inferred one — the chips the user can
  // see must be the chips that are applied.
  const window = asked.window ?? understood.filters.window;
  const range = windowRange(window);
  const explicitTags = asked.tags?.length ? asked.tags : null;
  const inferredTags = explicitTags ? [] : understood.filters.tags;
  const inferredNear = asked.near ? null : understood.filters.near;

  const filters: SearchFilterInput = {
    free: asked.free ?? understood.filters.free,
    tags: explicitTags ?? inferredTags,
    near: asked.near ?? understood.filters.near,
    cities: asked.cities,
    sources: asked.sources,
    from: asked.from ?? range.from,
    to: asked.to ?? range.to,
    minScore: asked.minScore,
    includeHidden: asked.includeHidden,
  };

  // The vector leg is pure upside: absent bindings ⇒ [] ⇒ RRF simply has one
  // fewer list. Search never waits on a binding that isn't there.
  const vectorIds =
    body.semantic === false ? [] : await vectorCandidates(understood.semanticQuery || raw, env, { topK: 50 });

  const limit = body.limit ?? 24;
  const offset = body.offset ?? 0;
  const run = (f: SearchFilterInput) =>
    r.search({ text: raw, filters: f, vectorIds, sort: (body.sort ?? "relevance") as SearchSort, limit, offset });

  let applied = filters;
  let result = await run(applied);

  // A GUESS MUST NEVER STRAND THE USER. Tags and a place read out of the query
  // are inferences, and an inference that matches nothing is worth less than the
  // results it hid — the catalog is also only as tagged as the last enrich run.
  // So: if inferring emptied the page, drop the inferences and answer the words.
  // Filters the user actually chose are never relaxed.
  const relaxable = inferredTags.length > 0 || !!inferredNear;
  const relaxed = result.total === 0 && relaxable;
  if (relaxed) {
    applied = { ...filters, tags: [], near: asked.near ?? undefined };
    result = await run(applied);
  }

  return {
    query: {
      raw,
      source: understood.source,
      intent: understood.intent,
      semanticQuery: understood.semanticQuery,
      filters: { ...understood.filters, window },
      applied,
      /** True when an inferred tag/place was dropped because it matched nothing. */
      relaxed,
    },
    events: result.events,
    total: result.total,
    facets: result.facets,
    used: result.used,
    limit,
    offset,
    nextOffset: offset + result.events.length < result.ranked.length ? offset + result.events.length : null,
  };
}

export function searchRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // ── public search ─────────────────────────────────────────────────────────
  app.post("/api/search", async (c) => {
    const parsed = SearchBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.issues.slice(0, 5) }, 400);
    return c.json(await runSearch(c, parsed.data));
  });

  app.get("/api/search", async (c) => {
    try {
      return c.json(await runSearch(c, bodyFromQuery(c.req.query())));
    } catch {
      return c.json({ error: "bad request" }, 400);
    }
  });

  /** The live vocabulary, grouped by facet — this is what lets the UI render
   *  filter chips for tags the Worker was never redeployed to know about. */
  app.get("/api/search/tags", async (c) => {
    const vocab = await repo(c).listVocab();
    const facets: Record<string, TagVocabEntry[]> = {};
    for (const t of vocab) (facets[t.facet] ??= []).push(t);
    return c.json({ tags: vocab, facets });
  });

  /** Index health: how much of the catalog is searchable / tagged / embedded. */
  app.get("/api/search/status", async (c) => c.json(await repo(c).indexHealth()));

  // ── admin: bounded, resumable jobs (bearer-gated with INGEST_TOKEN) ────────

  /**
   * Enrich a bounded slice of the catalog and advance a cursor. This replaces
   * `POST /api/admin/retag`'s unbounded `SELECT *` over every event: call it in a
   * loop with the returned `nextCursor` until `scanned` is 0.
   *
   *   POST /api/admin/enrich?limit=50&cursor=<lastId>&force=1&llm=0
   */
  app.post("/api/admin/enrich", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const env = c.env;
    const r = repo(c);
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
    const cursor = c.req.query("cursor") ?? "";
    const force = c.req.query("force") === "1";
    const useLlm = c.req.query("llm") !== "0";

    const vocab = await r.listVocab();
    const candidates = await r.eventsNeedingEnrichment(limit, cursor, force);
    if (!candidates.length) return c.json({ ok: true, scanned: 0, enriched: 0, tags: 0, embedded: 0, nextCursor: null });

    const enriched = await enrichEvents(candidates, vocab, {
      useLlm,
      model: { openrouterKey: env.OPENROUTER_API_KEY ?? null, model: env.OPENROUTER_MODEL_FAST ?? null, env },
      cache: env.SESSIONS ?? null,
      budget: env.LLM_DAILY_BUDGET_USD ? { kv: env.SESSIONS, dailyUsd: Number(env.LLM_DAILY_BUDGET_USD) || 0 } : null,
    });
    const written = await r.applyEnrichment(
      enriched.map((e) => ({
        id: e.id,
        tags: e.tags,
        interestScore: e.interestScore,
        interestReason: e.interestReason,
        tagSource: e.tagSource,
        contentHash: e.contentHash,
      })),
    );

    // Embeddings ride along on the same slice. No-op without VECTORIZE + AI.
    const stored = await embedAndUpsert(candidates, env);
    if (stored.length) await r.markEmbedded(stored);

    return c.json({
      ok: true,
      scanned: candidates.length,
      enriched: written.events,
      tags: written.tags,
      embedded: stored.length,
      nextCursor: candidates[candidates.length - 1]?.id ?? null,
    });
  });

  /** Backfill/repair the FTS index. Triggers keep it in sync for live writes; this
   *  is for rows that predate the migration. Bounded + resumable. */
  app.post("/api/admin/reindex", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const out = await repo(c).reindex({
      limit: Number(c.req.query("limit")) || 200,
      cursor: c.req.query("cursor") ?? "",
      force: c.req.query("force") === "1",
    });
    return c.json({ ok: true, ...out, health: await repo(c).indexHealth() });
  });

  /** Add or edit vocabulary. The whole point of A1: a new tag is a row, not a
   *  deploy. Bearer-gated because the taxonomy shapes what everyone can find. */
  app.post("/api/admin/tags", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const parsed = VocabBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload", issues: parsed.error.issues.slice(0, 5) }, 400);
    const out = await repo(c).upsertVocab(
      parsed.data.tags.map((t) => ({
        id: t.id,
        facet: t.facet,
        label: t.label,
        keywords: t.keywords ?? [],
        emoji: t.emoji ?? null,
        color: t.color ?? null,
        status: t.status ?? "active",
      })),
    );
    return c.json({ ok: true, ...out });
  });

  return app;
}
