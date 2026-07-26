/**
 * SearchRepo — the only place that talks to `tag_vocab`, `event_tags` and
 * `events_fts`.
 *
 * Three jobs, all thin:
 *   1. **Read the taxonomy.** It's a table now, so search can offer facets the
 *      Worker was never redeployed to know about.
 *   2. **Write tags with write-through.** `events.categories` is still read by
 *      /api/events, the static dashboard and the news classifier, so every tag
 *      write rebuilds that JSON column from the `topic:` facet in the SAME batch.
 *      Machine tags ('keyword' | 'llm') are replaced wholesale; human tags
 *      ('host' | 'crowd') are never touched by a re-enrich.
 *   3. **Retrieve.** Structured filters + FTS5 produce a bounded candidate pool;
 *      four rank lists are built over that pool and fused by the pure RRF in
 *      `core/search/rank`. The repo does no AI: the vector list is passed in, so
 *      a missing Vectorize binding is simply an absent argument.
 *
 * D1 caps a statement at 100 bound parameters, so every list is capped and every
 * fan-out chunked at 90 (tests/helpers/d1.ts enforces the real limit).
 */
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { CanonicalEvent } from "../../core/models/event";
import { D1Repo } from "./d1-repo";
import { fuse, byRecency, byQuality, type FusionWeights, type RankLists } from "../../core/search/rank";
import { toMatchQuery } from "../../core/search/fts";
import { groupByFacet, type TagAssignment, type TagSourceKind, type TagVocabEntry } from "../../core/search/vocab";

export type { TagAssignment, TagSourceKind };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

/** Title matters ~8x more than body text — a talk *called* "Robotics" beats one
 *  that mentions robotics in paragraph four. */
const BM25_TITLE_WEIGHT = 8.0;
const BM25_BODY_WEIGHT = 1.0;

/** How many rows the rank lists are built over. Fusion only re-orders; it cannot
 *  find what the candidate query didn't return, so this is the real recall knob. */
const DEFAULT_POOL = 400;
const MAX_POOL = 1000;

/** Caps that keep any single statement under D1's 100-parameter ceiling. */
const MAX_LIST_FILTER = 20;
const CHUNK = 90;

/** The FTS `body` column, rebuilt from an `events` row aliased `e`. Must stay
 *  identical to the trigger definitions in migrations/0014_search.sql. */
const FTS_BODY_SQL = `trim(
  coalesce(e.description, '') || ' ' ||
  coalesce(e.organizer, '')   || ' ' ||
  coalesce(e.venue_name, '')  || ' ' ||
  coalesce((SELECT group_concat(tv.label, ' ')
              FROM event_tags et JOIN tag_vocab tv ON tv.id = et.tag_id
             WHERE et.event_id = e.id), '')
)`;

/** Rebuild `events.categories` from the topic facet. `substr(tag_id, 7)` strips
 *  the `topic:` prefix, so the legacy column keeps its exact legacy values. */
const CATEGORIES_WRITETHROUGH_SQL = `(
  SELECT coalesce(json_group_array(substr(et.tag_id, 7)), '[]')
    FROM event_tags et
   WHERE et.event_id = events.id AND et.tag_id LIKE 'topic:%'
)`;

/** One event's enrichment result, ready to persist. */
export interface EnrichmentWrite {
  id: string;
  tags: TagAssignment[];
  interestScore?: number | null;
  interestReason?: string | null;
  /** Mirrors events.tag_source: which engine produced the topical read. */
  tagSource?: "ai" | "keyword" | null;
  /** When set, `tagged_hash` is advanced to it so the event stops being a candidate. */
  contentHash?: string | null;
}

export interface SearchFilterInput {
  free?: boolean;
  tags?: string[];
  near?: string;
  cities?: string[];
  sources?: string[];
  from?: string;
  to?: string;
  includeHidden?: boolean;
  minScore?: number;
}

/**
 * `relevance` fuses every retriever — the smart default. The other two are
 * *explicit user intent* ("show me what's next", "show me the best") and must
 * therefore be honoured exactly, not blended: a date-sorted list that isn't
 * quite in date order reads as a bug, however good the ranking behind it.
 */
export type SearchSort = "relevance" | "soonest" | "interesting";

export interface SearchParams {
  /** Raw words for BM25. Absent/blank ⇒ no FTS leg (browse, not search). */
  text?: string | null;
  filters?: SearchFilterInput;
  /** Ids from the vector index, best first. Absent ⇒ the vector leg is skipped. */
  vectorIds?: string[];
  weights?: FusionWeights;
  sort?: SearchSort;
  limit?: number;
  offset?: number;
  poolSize?: number;
  now?: Date;
}

export interface TagFacetCount {
  value: string;
  facet: string;
  label: string;
  emoji: string | null;
  color: string | null;
  count: number;
}
export interface FacetCount {
  value: string;
  count: number;
}

export interface SearchResult {
  events: CanonicalEvent[];
  total: number;
  facets: { tags: TagFacetCount[]; cities: FacetCount[]; sources: FacetCount[] };
  ranked: Array<{ id: string; score: number }>;
  /** Which retrievers actually contributed — surfaced so a degraded search is
   *  observable rather than mysteriously worse. */
  used: { fts: boolean; vector: boolean };
}

export interface EnrichCandidate {
  id: string;
  title: string;
  description: string | null;
  organizer: string | null;
  venueName: string | null;
  city: string;
  startUtc: string;
  isFree: boolean | null;
  priceText: string | null;
  contentHash: string;
}

export class SearchRepo {
  constructor(private db: D1Database) {}

  private static *chunk<T>(arr: T[], n: number): Generator<T[]> {
    for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
  }

  private async runBatch(stmts: D1PreparedStatement[]): Promise<void> {
    for (const c of SearchRepo.chunk(stmts, 200)) if (c.length) await this.db.batch(c);
  }

  // ── taxonomy ──────────────────────────────────────────────────────────────

  /** The live vocabulary. Active-only by default — that's what search may use. */
  async listVocab(opts: { includeInactive?: boolean } = {}): Promise<TagVocabEntry[]> {
    const sql = opts.includeInactive
      ? "SELECT * FROM tag_vocab ORDER BY facet, id"
      : "SELECT * FROM tag_vocab WHERE status = 'active' ORDER BY facet, id";
    const res = await this.db.prepare(sql).all<Row>();
    return (res.results ?? []).map((r) => ({
      id: r.id,
      facet: r.facet,
      label: r.label,
      keywords: safeJsonArray(r.keywords_json),
      emoji: r.emoji ?? null,
      color: r.color ?? null,
      status: r.status,
    }));
  }

  /** Add or update a vocabulary row. This is the "a new tag is a row, not a
   *  redeploy" promise made good. */
  async upsertVocab(entries: TagVocabEntry[]): Promise<{ upserted: number }> {
    if (!entries.length) return { upserted: 0 };
    const now = new Date().toISOString();
    await this.runBatch(
      entries.map((t) =>
        this.db
          .prepare(
            `INSERT INTO tag_vocab (id, facet, label, keywords_json, emoji, color, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               facet=excluded.facet, label=excluded.label, keywords_json=excluded.keywords_json,
               emoji=excluded.emoji, color=excluded.color, status=excluded.status`,
          )
          .bind(
            t.id,
            t.facet,
            t.label,
            JSON.stringify(t.keywords ?? []),
            t.emoji ?? null,
            t.color ?? null,
            t.status ?? "active",
            now,
          ),
      ),
    );
    return { upserted: entries.length };
  }

  // ── tag writes (with legacy write-through) ────────────────────────────────

  /**
   * Persist enrichment for a batch of events: replace their MACHINE tags, keep
   * their human tags, and rebuild `events.categories` from the topic facet in the
   * same batch so the legacy readers never observe a torn state.
   */
  async applyEnrichment(writes: EnrichmentWrite[]): Promise<{ events: number; tags: number }> {
    if (!writes.length) return { events: 0, tags: 0 };
    const now = new Date().toISOString();
    const stmts: D1PreparedStatement[] = [];
    let tagCount = 0;

    for (const w of writes) {
      // Human-supplied tags outlive every re-enrich — a host's own label is data,
      // not a guess to be recomputed.
      stmts.push(
        this.db
          .prepare("DELETE FROM event_tags WHERE event_id = ? AND source IN ('keyword','llm')")
          .bind(w.id),
      );
      for (const t of dedupeTags(w.tags)) {
        tagCount++;
        stmts.push(
          this.db
            .prepare(
              `INSERT INTO event_tags (event_id, tag_id, confidence, source, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(event_id, tag_id) DO UPDATE SET
                 confidence = max(confidence, excluded.confidence)`,
            )
            .bind(w.id, t.tagId, clamp01(t.confidence), t.source, now),
        );
      }
      stmts.push(
        this.db
          .prepare(
            `UPDATE events SET
               categories      = ${CATEGORIES_WRITETHROUGH_SQL},
               interest_score  = coalesce(?, interest_score),
               interest_reason = coalesce(?, interest_reason),
               tag_source      = coalesce(?, tag_source),
               tagged_hash     = coalesce(?, tagged_hash)
             WHERE id = ?`,
          )
          .bind(
            w.interestScore ?? null,
            w.interestReason ?? null,
            w.tagSource ?? null,
            w.contentHash ?? null,
            w.id,
          ),
      );
    }
    await this.runBatch(stmts);
    return { events: writes.length, tags: tagCount };
  }

  /** Attach human tags (a host labelling their own event, or the crowd). Additive:
   *  it never removes what the machine found, and it write-throughs categories. */
  async addTags(eventId: string, tags: TagAssignment[]): Promise<{ added: number }> {
    const list = dedupeTags(tags);
    if (!list.length) return { added: 0 };
    const now = new Date().toISOString();
    const stmts = list.map((t) =>
      this.db
        .prepare(
          `INSERT INTO event_tags (event_id, tag_id, confidence, source, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(event_id, tag_id) DO UPDATE SET
             confidence = max(confidence, excluded.confidence), source = excluded.source`,
        )
        .bind(eventId, t.tagId, clamp01(t.confidence), t.source, now),
    );
    stmts.push(
      this.db.prepare(`UPDATE events SET categories = ${CATEGORIES_WRITETHROUGH_SQL} WHERE id = ?`).bind(eventId),
    );
    await this.runBatch(stmts);
    return { added: list.length };
  }

  async tagsFor(eventIds: string[]): Promise<Map<string, TagAssignment[]>> {
    const out = new Map<string, TagAssignment[]>();
    for (const c of SearchRepo.chunk(eventIds, CHUNK)) {
      if (!c.length) continue;
      const res = await this.db
        .prepare(
          `SELECT event_id, tag_id, confidence, source FROM event_tags
            WHERE event_id IN (${c.map(() => "?").join(",")}) ORDER BY confidence DESC, tag_id`,
        )
        .bind(...c)
        .all<Row>();
      for (const r of res.results ?? []) {
        const list = out.get(r.event_id) ?? [];
        list.push({ tagId: r.tag_id, confidence: r.confidence, source: r.source });
        out.set(r.event_id, list);
      }
    }
    return out;
  }

  // ── bounded, resumable work queues ────────────────────────────────────────

  /**
   * The next slice of events that need (re)tagging, keyed by an id cursor so the
   * job is resumable and can never load the whole table into Worker memory — the
   * flaw in `D1Repo.retagAll`, which does `SELECT *` over every event.
   */
  async eventsNeedingEnrichment(
    limit = 50,
    cursor = "",
    force = false,
  ): Promise<EnrichCandidate[]> {
    const stale = force
      ? ""
      : `AND (tag_source IS NULL OR tagged_hash IS NULL OR tagged_hash != content_hash
              OR NOT EXISTS (SELECT 1 FROM event_tags et WHERE et.event_id = events.id))`;
    const res = await this.db
      .prepare(
        `SELECT id, title, description, organizer, venue_name, city, start_utc, is_free, price_text, content_hash
           FROM events
          WHERE hidden = 0 AND id > ? ${stale}
          ORDER BY id ASC LIMIT ?`,
      )
      .bind(cursor, Math.min(Math.max(limit, 1), 500))
      .all<Row>();
    return (res.results ?? []).map(rowToCandidate);
  }

  /** Events whose embedding is missing or stale — the `embedded_hash` mirror of
   *  the existing `tagged_hash` pattern. */
  async eventsNeedingEmbedding(limit = 50, cursor = ""): Promise<EnrichCandidate[]> {
    const res = await this.db
      .prepare(
        `SELECT id, title, description, organizer, venue_name, city, start_utc, is_free, price_text, content_hash
           FROM events
          WHERE hidden = 0 AND id > ?
            AND (embedded_hash IS NULL OR embedded_hash != content_hash)
          ORDER BY id ASC LIMIT ?`,
      )
      .bind(cursor, Math.min(Math.max(limit, 1), 500))
      .all<Row>();
    return (res.results ?? []).map(rowToCandidate);
  }

  async markEmbedded(pairs: Array<{ id: string; hash: string }>): Promise<void> {
    if (!pairs.length) return;
    await this.runBatch(
      pairs.map((p) => this.db.prepare("UPDATE events SET embedded_hash = ? WHERE id = ?").bind(p.hash, p.id)),
    );
  }

  /**
   * Repair the full-text index. Triggers keep it in sync for every normal write,
   * so this exists for the backfill of rows that predate the migration and as a
   * belt-and-braces rebuild. Bounded + cursor-based like every admin job here.
   */
  async reindex(opts: { limit?: number; cursor?: string; force?: boolean } = {}): Promise<{
    indexed: number;
    nextCursor: string | null;
  }> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const cursor = opts.cursor ?? "";
    const missing = opts.force ? "" : "AND NOT EXISTS (SELECT 1 FROM events_fts f WHERE f.event_id = e.id)";
    const res = await this.db
      .prepare(`SELECT e.id FROM events e WHERE e.id > ? ${missing} ORDER BY e.id ASC LIMIT ?`)
      .bind(cursor, limit)
      .all<Row>();
    const ids = (res.results ?? []).map((r) => r.id as string);
    if (!ids.length) return { indexed: 0, nextCursor: null };

    const stmts: D1PreparedStatement[] = [];
    for (const id of ids) {
      stmts.push(this.db.prepare("DELETE FROM events_fts WHERE event_id = ?").bind(id));
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO events_fts (event_id, title, body)
             SELECT e.id, e.title, ${FTS_BODY_SQL} FROM events e WHERE e.id = ?`,
          )
          .bind(id),
      );
    }
    await this.runBatch(stmts);
    return { indexed: ids.length, nextCursor: ids[ids.length - 1] ?? null };
  }

  async indexHealth(): Promise<{ events: number; indexed: number; tagged: number; embedded: number }> {
    const one = async (sql: string) => Number((await this.db.prepare(sql).first<Row>())?.n ?? 0);
    return {
      events: await one("SELECT COUNT(*) AS n FROM events"),
      indexed: await one("SELECT COUNT(*) AS n FROM events_fts"),
      tagged: await one("SELECT COUNT(DISTINCT event_id) AS n FROM event_tags"),
      embedded: await one("SELECT COUNT(*) AS n FROM events WHERE embedded_hash IS NOT NULL"),
    };
  }

  // ── retrieval ─────────────────────────────────────────────────────────────

  /**
   * Build the FROM + WHERE that defines the candidate set.
   *
   * `multiSelect` toggles the facet filters the user ticked (tags / cities /
   * sources). Facet COUNTS are computed with it off, so ticking "Hardware" doesn't
   * make every other topic's count collapse to zero and strand the user.
   */
  private scope(
    filters: SearchFilterInput,
    match: string | null,
    multiSelect: boolean,
  ): { from: string; where: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];
    const from = match ? "events_fts JOIN events e ON e.id = events_fts.event_id" : "events e";
    if (match) {
      clauses.push("events_fts MATCH ?");
      params.push(match);
    }
    if (!filters.includeHidden) clauses.push("e.hidden = 0");
    if (filters.from) { clauses.push("e.start_utc >= ?"); params.push(filters.from); }
    if (filters.to) { clauses.push("e.start_utc <= ?"); params.push(filters.to); }
    if (filters.free) clauses.push("e.is_free = 1");
    if (typeof filters.minScore === "number" && filters.minScore > 0) {
      clauses.push("e.interest_score >= ?");
      params.push(filters.minScore);
    }
    if (filters.near) {
      const like = `%${filters.near.toLowerCase()}%`;
      clauses.push(
        "(lower(e.city) LIKE ? OR lower(coalesce(e.venue_name,'')) LIKE ? OR lower(coalesce(e.address,'')) LIKE ?)",
      );
      params.push(like, like, like);
    }
    if (multiSelect) {
      const cities = (filters.cities ?? []).slice(0, MAX_LIST_FILTER);
      if (cities.length) {
        clauses.push(`e.city IN (${cities.map(() => "?").join(",")})`);
        params.push(...cities);
      }
      const sources = (filters.sources ?? []).slice(0, MAX_LIST_FILTER);
      if (sources.length) {
        clauses.push(
          `EXISTS (SELECT 1 FROM event_sources es WHERE es.event_id = e.id AND es.source_id IN (${sources
            .map(() => "?")
            .join(",")}))`,
        );
        params.push(...sources);
      }
      // OR within a facet, AND across facets: "hardware or software, AND free".
      for (const [, ids] of groupByFacet((filters.tags ?? []).slice(0, MAX_LIST_FILTER))) {
        clauses.push(
          `EXISTS (SELECT 1 FROM event_tags et WHERE et.event_id = e.id AND et.tag_id IN (${ids
            .map(() => "?")
            .join(",")}))`,
        );
        params.push(...ids);
      }
    }
    return { from, where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const filters = params.filters ?? {};
    const match = toMatchQuery(params.text);
    const pool = Math.min(Math.max(params.poolSize ?? DEFAULT_POOL, 1), MAX_POOL);
    const limit = Math.min(Math.max(params.limit ?? 24, 1), 200);
    const offset = Math.max(params.offset ?? 0, 0);
    const now = (params.now ?? new Date()).getTime();

    const s = this.scope(filters, match, true);
    const order = match
      ? `ORDER BY bm25(events_fts, ${BM25_TITLE_WEIGHT}, ${BM25_BODY_WEIGHT}) ASC`
      : "ORDER BY e.start_utc ASC";
    const rows =
      (
        await this.db
          .prepare(
            `SELECT e.id, e.start_utc, e.interest_score FROM ${s.from} ${s.where} ${order} LIMIT ?`,
          )
          .bind(...s.params, pool)
          .all<Row>()
      ).results ?? [];

    const total = Number(
      (await this.db.prepare(`SELECT COUNT(*) AS n FROM ${s.from} ${s.where}`).bind(...s.params).first<Row>())?.n ?? 0,
    );

    const candidates = rows.map((r) => ({
      id: r.id as string,
      startUtc: r.start_utc as string,
      interestScore: (r.interest_score ?? null) as number | null,
    }));
    const inPool = new Set(candidates.map((c) => c.id));

    // The vector index is global; it must never widen the filtered set, only
    // re-order inside it. (It also may not exist at all — hence the empty default.)
    const vector = (params.vectorIds ?? []).filter((id) => inPool.has(id));
    const sort = params.sort ?? "relevance";
    const lists: RankLists =
      sort === "soonest"
        ? { recency: byRecency(candidates, now) }
        : sort === "interesting"
        ? { quality: byQuality(candidates) }
        : {
            bm25: match ? candidates.map((c) => c.id) : undefined,
            vector: vector.length ? vector : undefined,
            recency: byRecency(candidates, now),
            quality: byQuality(candidates),
          };
    const ranked = fuse(lists, params.weights);
    const page = ranked.slice(offset, offset + limit);

    const events = await this.hydrate(page.map((r) => r.id));
    return {
      events,
      total,
      facets: await this.facets(filters, match),
      ranked: ranked.map((r) => ({ id: r.id, score: r.score })),
      used: { fts: !!match, vector: vector.length > 0 },
    };
  }

  /** Fetch full events and restore the fused order (SQL `IN` returns rowid order). */
  private async hydrate(ids: string[]): Promise<CanonicalEvent[]> {
    if (!ids.length) return [];
    const events = await new D1Repo(this.db).getEventsByIds(ids);
    const byId = new Map(events.map((e) => [e.id, e]));
    return ids.map((id) => byId.get(id)).filter((e): e is CanonicalEvent => !!e);
  }

  private async facets(
    filters: SearchFilterInput,
    match: string | null,
  ): Promise<SearchResult["facets"]> {
    // Counts ignore the user's own facet selections so the panel stays navigable.
    const s = this.scope(filters, match, false);
    const scopeSql = `SELECT e.id FROM ${s.from} ${s.where}`;

    const tags = await this.db
      .prepare(
        `SELECT tv.id AS value, tv.facet, tv.label, tv.emoji, tv.color, COUNT(*) AS count
           FROM event_tags et JOIN tag_vocab tv ON tv.id = et.tag_id
          WHERE tv.status = 'active' AND et.event_id IN (${scopeSql})
          GROUP BY tv.id ORDER BY count DESC, tv.id LIMIT 80`,
      )
      .bind(...s.params)
      .all<Row>();

    const cities = await this.db
      .prepare(
        `SELECT e.city AS value, COUNT(*) AS count FROM ${s.from} ${s.where}
          GROUP BY e.city ORDER BY count DESC LIMIT 60`,
      )
      .bind(...s.params)
      .all<Row>();

    const sources = await this.db
      .prepare(
        `SELECT es.source_id AS value, COUNT(DISTINCT es.event_id) AS count
           FROM event_sources es WHERE es.event_id IN (${scopeSql})
          GROUP BY es.source_id ORDER BY count DESC LIMIT 60`,
      )
      .bind(...s.params)
      .all<Row>();

    return {
      tags: (tags.results ?? []).map((r) => ({
        value: r.value,
        facet: r.facet,
        label: r.label,
        emoji: r.emoji ?? null,
        color: r.color ?? null,
        count: Number(r.count),
      })),
      cities: (cities.results ?? []).map((r) => ({ value: r.value, count: Number(r.count) })),
      sources: (sources.results ?? []).map((r) => ({ value: r.value, count: Number(r.count) })),
    };
  }
}

function rowToCandidate(r: Row): EnrichCandidate {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    organizer: r.organizer ?? null,
    venueName: r.venue_name ?? null,
    city: r.city,
    startUtc: r.start_utc,
    isFree: r.is_free == null ? null : !!r.is_free,
    priceText: r.price_text ?? null,
    contentHash: r.content_hash,
  };
}

function safeJsonArray(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1);

/** One row per (event, tag) — the PK enforces it, but colliding binds inside a
 *  single batch would still throw, so collapse them first (best confidence wins). */
function dedupeTags(tags: TagAssignment[]): TagAssignment[] {
  const best = new Map<string, TagAssignment>();
  for (const t of tags) {
    if (!t?.tagId) continue;
    const prev = best.get(t.tagId);
    if (!prev || t.confidence > prev.confidence) best.set(t.tagId, t);
  }
  return [...best.values()];
}
