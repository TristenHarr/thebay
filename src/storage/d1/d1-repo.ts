import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import type { CanonicalEvent } from "../../core/models/event";
import type { SourceConfig } from "../../core/models/source";
import { mergeEvents, fingerprint } from "../../core/dedup";
import type {
  EventFilter,
  EventFacets,
  EventQueryResult,
  FacetCount,
  Repository,
  RunSummary,
  SourceRunResult,
  StoredSource,
  TagInput,
  UpsertResult,
} from "../repository";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

/** D1-backed Repository. Same interface & semantics as SqliteRepository, but
 *  positional `?` binding (D1 has no named params) and `db.batch([...])` in
 *  place of better-sqlite3's synchronous `.transaction(fn)`. The pure
 *  `mergeEvents` from core lets us do the read-then-merge in JS, then batch. */
export class D1Repo implements Repository {
  constructor(private db: D1Database) {}

  // ── mapping ───────────────────────────────────────────────────────────────
  private static rowToCanonical(r: Row): CanonicalEvent {
    return {
      id: r.id,
      fingerprint: r.fingerprint,
      title: r.title,
      description: r.description ?? null,
      startUtc: r.start_utc,
      endUtc: r.end_utc ?? null,
      timezone: r.timezone,
      venueName: r.venue_name ?? null,
      address: r.address ?? null,
      city: r.city,
      url: r.url,
      organizer: r.organizer ?? null,
      isFree: r.is_free == null ? null : !!r.is_free,
      priceText: r.price_text ?? null,
      imageUrl: r.image_url ?? null,
      latitude: r.latitude ?? null,
      longitude: r.longitude ?? null,
      categories: JSON.parse(r.categories || "[]"),
      interestScore: r.interest_score ?? null,
      interestReason: r.interest_reason ?? null,
      tagSource: (r.tag_source ?? null) as CanonicalEvent["tagSource"],
      contentHash: r.content_hash,
      taggedHash: r.tagged_hash ?? null,
      sources: JSON.parse(r.sources_json || "[]"),
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      starred: !!r.starred,
      hidden: !!r.hidden,
    };
  }

  /** Values in the exact column order of INSERT_COLS below. */
  private static insertValues(e: CanonicalEvent): any[] {
    return [
      e.id, e.fingerprint, e.title, e.description, e.startUtc, e.endUtc, e.timezone,
      e.venueName, e.address, e.city, e.url, e.organizer,
      e.isFree == null ? null : e.isFree ? 1 : 0, e.priceText, e.imageUrl,
      JSON.stringify(e.categories), e.interestScore, e.interestReason, e.tagSource,
      e.contentHash, e.taggedHash, JSON.stringify(e.sources), e.firstSeenAt,
      e.lastSeenAt, e.starred ? 1 : 0, e.hidden ? 1 : 0,
    ];
  }

  // ── events: upsert ────────────────────────────────────────────────────────
  async upsertEvents(events: CanonicalEvent[]): Promise<UpsertResult> {
    if (!events.length) return { inserted: 0, updated: 0 };

    // Collapse intra-batch fingerprint collisions first (D1 batches can't
    // read-after-write mid-batch, so we merge same-fingerprint incomings in JS).
    const byFp = new Map<string, CanonicalEvent>();
    for (const e of events) {
      const prev = byFp.get(e.fingerprint);
      byFp.set(e.fingerprint, prev ? mergeEvents(prev, e) : e);
    }
    const incoming = [...byFp.values()];

    // Fetch existing rows for these fingerprints (chunked IN).
    const existing = new Map<string, CanonicalEvent>();
    const fps = [...byFp.keys()];
    for (const chunk of D1Repo.chunk(fps, 90)) {
      const ph = chunk.map(() => "?").join(",");
      const res = await this.db
        .prepare(`SELECT * FROM events WHERE fingerprint IN (${ph})`)
        .bind(...chunk)
        .all<Row>();
      for (const r of res.results ?? []) {
        existing.set(r.fingerprint, D1Repo.rowToCanonical(r));
      }
    }

    let inserted = 0;
    let updated = 0;
    // Build per-event statement groups, execute in batches (order preserved).
    const groups: D1PreparedStatement[][] = [];
    for (const e of incoming) {
      const prior = existing.get(e.fingerprint);
      const final = prior ? mergeEvents(prior, e) : e;
      if (prior) updated++;
      else inserted++;
      const stmts: D1PreparedStatement[] = [
        prior
          ? this.db.prepare(UPDATE_SQL).bind(...D1Repo.updateBindOrder(final))
          : this.db.prepare(INSERT_SQL).bind(...D1Repo.insertValues(final)),
        this.db.prepare("DELETE FROM event_sources WHERE event_id = ?").bind(final.id),
      ];
      for (const s of final.sources) {
        stmts.push(
          this.db
            .prepare(
              `INSERT OR IGNORE INTO event_sources
               (event_id, source_id, source_type, external_id, url)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(final.id, s.sourceId, s.sourceType, s.externalId ?? null, s.url),
        );
      }
      groups.push(stmts);
    }

    // Pack whole event-groups into batches capped at ~200 statements each.
    let batch: D1PreparedStatement[] = [];
    for (const g of groups) {
      if (batch.length + g.length > 200 && batch.length) {
        await this.db.batch(batch);
        batch = [];
      }
      batch.push(...g);
    }
    if (batch.length) await this.db.batch(batch);

    return { inserted, updated };
  }

  /** UPDATE binds all columns except id, then id last (for WHERE id=?). */
  private static updateBindOrder(e: CanonicalEvent): any[] {
    const v = D1Repo.insertValues(e); // [id, ...rest]
    return [...v.slice(1), v[0]];
  }

  private static *chunk<T>(arr: T[], n: number): Generator<T[]> {
    for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
  }

  // ── events: query ─────────────────────────────────────────────────────────
  private buildWhere(
    filter: EventFilter,
    includeMultiSelect: boolean,
  ): { clause: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];
    if (!filter.includeHidden) clauses.push("hidden = 0");
    if (filter.from) { clauses.push("start_utc >= ?"); params.push(filter.from); }
    if (filter.to) { clauses.push("start_utc <= ?"); params.push(filter.to); }
    if (filter.free) clauses.push("is_free = 1");
    if (typeof filter.minScore === "number" && filter.minScore > 0) {
      clauses.push("interest_score >= ?"); params.push(filter.minScore);
    }
    if (filter.starred) clauses.push("starred = 1");
    if (filter.q && filter.q.trim()) {
      for (const t of filter.q.trim().toLowerCase().split(/\s+/).slice(0, 8)) {
        clauses.push(
          "(lower(title) LIKE ? OR lower(coalesce(description,'')) LIKE ? OR lower(coalesce(organizer,'')) LIKE ? OR lower(coalesce(venue_name,'')) LIKE ?)",
        );
        const like = `%${t}%`;
        params.push(like, like, like, like);
      }
    }
    if (includeMultiSelect) {
      if (filter.cities?.length) {
        clauses.push(`city IN (${filter.cities.map(() => "?").join(",")})`);
        params.push(...filter.cities);
      }
      if (filter.sources?.length) {
        const ph = filter.sources.map(() => "?").join(",");
        clauses.push(`id IN (SELECT event_id FROM event_sources WHERE source_id IN (${ph}))`);
        params.push(...filter.sources);
      }
      if (filter.categories?.length) {
        const ph = filter.categories.map(() => "?").join(",");
        clauses.push(`EXISTS (SELECT 1 FROM json_each(events.categories) WHERE value IN (${ph}))`);
        params.push(...filter.categories);
      }
    }
    return { clause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  async queryEvents(filter: EventFilter): Promise<EventQueryResult> {
    const { clause, params } = this.buildWhere(filter, true);
    const order =
      filter.sort === "score"
        ? "ORDER BY (interest_score IS NULL), interest_score DESC, start_utc ASC"
        : "ORDER BY start_utc ASC";
    const limit = Math.min(Math.max(filter.limit ?? 500, 1), 100_000);
    const offset = Math.max(filter.offset ?? 0, 0);

    const rowsRes = await this.db
      .prepare(`SELECT * FROM events ${clause} ${order} LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all<Row>();
    const countRes = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM events ${clause}`)
      .bind(...params)
      .first<{ n: number }>();

    return {
      events: (rowsRes.results ?? []).map(D1Repo.rowToCanonical),
      total: countRes?.n ?? 0,
      facets: await this.computeFacets(filter),
    };
  }

  private async computeFacets(filter: EventFilter): Promise<EventFacets> {
    const { clause, params } = this.buildWhere(filter, false);
    const cities = await this.db
      .prepare(`SELECT city AS value, COUNT(*) AS count FROM events ${clause} GROUP BY city ORDER BY count DESC`)
      .bind(...params)
      .all<FacetCount>();
    const categories = await this.db
      .prepare(
        `SELECT je.value AS value, COUNT(*) AS count
         FROM events, json_each(events.categories) je ${clause}
         GROUP BY je.value ORDER BY count DESC`,
      )
      .bind(...params)
      .all<FacetCount>();
    const idClause = clause ? `WHERE event_id IN (SELECT id FROM events ${clause})` : "";
    const sources = await this.db
      .prepare(
        `SELECT source_id AS value, COUNT(DISTINCT event_id) AS count
         FROM event_sources ${idClause} GROUP BY source_id ORDER BY count DESC`,
      )
      .bind(...params)
      .all<FacetCount>();
    return {
      cities: cities.results ?? [],
      categories: categories.results ?? [],
      sources: sources.results ?? [],
    };
  }

  async getEventById(id: string): Promise<CanonicalEvent | null> {
    const row = await this.db.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<Row>();
    return row ? D1Repo.rowToCanonical(row) : null;
  }

  async getEventsByIds(ids: string[]): Promise<CanonicalEvent[]> {
    if (!ids.length) return [];
    const out: CanonicalEvent[] = [];
    for (const chunk of D1Repo.chunk(ids, 90)) {
      const ph = chunk.map(() => "?").join(",");
      const res = await this.db.prepare(`SELECT * FROM events WHERE id IN (${ph})`).bind(...chunk).all<Row>();
      for (const r of res.results ?? []) out.push(D1Repo.rowToCanonical(r));
    }
    return out;
  }

  async setEventFlags(
    id: string,
    flags: { starred?: boolean; hidden?: boolean },
  ): Promise<CanonicalEvent | null> {
    const sets: string[] = [];
    const params: any[] = [];
    if (typeof flags.starred === "boolean") { sets.push("starred = ?"); params.push(flags.starred ? 1 : 0); }
    if (typeof flags.hidden === "boolean") { sets.push("hidden = ?"); params.push(flags.hidden ? 1 : 0); }
    if (sets.length) {
      await this.db.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`).bind(...params, id).run();
    }
    return this.getEventById(id);
  }

  async eventsNeedingTags(limit = 500): Promise<CanonicalEvent[]> {
    const now = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const res = await this.db
      .prepare(
        `SELECT * FROM events
         WHERE hidden = 0 AND start_utc >= ?
           AND (tag_source IS NULL OR tagged_hash IS NULL OR tagged_hash != content_hash)
         ORDER BY start_utc ASC LIMIT ?`,
      )
      .bind(now, limit)
      .all<Row>();
    return (res.results ?? []).map(D1Repo.rowToCanonical);
  }

  /**
   * Re-tag every stored event with the given tagger, REPLACING categories (not
   * unioning like the ingest merge does). Needed to correct tags across the whole
   * catalog after the tagger changes — e.g. the substring→word-boundary fix that
   * had "email"/"chair" false-tagged as software.
   */
  async retagAll(tagger: import("../../ai/tagger").Tagger): Promise<{ retagged: number }> {
    const rows = (await this.db.prepare("SELECT id, title, description, organizer FROM events").all<Row>()).results ?? [];
    if (!rows.length) return { retagged: 0 };
    const results = await tagger.tag(rows.map((r) => ({ id: r.id, title: r.title, description: r.description ?? null, organizer: r.organizer ?? null })));
    await this.applyTags(
      results.map((r) => ({ id: r.id, categories: r.categories, interestScore: r.interestScore, interestReason: r.reason, tagSource: tagger.name })),
    );
    return { retagged: results.length };
  }

  async applyTags(tags: TagInput[]): Promise<void> {
    if (!tags.length) return;
    const stmts = tags.map((t) =>
      this.db
        .prepare(
          `UPDATE events SET categories=?, interest_score=?, interest_reason=?,
           tag_source=?, tagged_hash=content_hash WHERE id=?`,
        )
        .bind(JSON.stringify(t.categories), t.interestScore, t.interestReason, t.tagSource, t.id),
    );
    for (const c of D1Repo.chunk(stmts, 200)) await this.db.batch(c);
  }

  async countEvents(): Promise<number> {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    return r?.n ?? 0;
  }

  async syncSources(sources: SourceConfig[]): Promise<void> {
    if (!sources.length) return;
    const stmts = sources.map((s) =>
      this.db
        .prepare(
          `INSERT INTO sources (id, type, enabled, params_json) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET type=excluded.type, enabled=excluded.enabled, params_json=excluded.params_json`,
        )
        .bind(s.id, s.type, s.enabled ? 1 : 0, JSON.stringify(s.params ?? {})),
    );
    for (const c of D1Repo.chunk(stmts, 200)) await this.db.batch(c);
  }

  async listSources(): Promise<StoredSource[]> {
    const res = await this.db
      .prepare("SELECT id, type, enabled, last_run_at, last_status FROM sources ORDER BY id")
      .all<Row>();
    return (res.results ?? []).map((r) => ({
      id: r.id,
      type: r.type,
      enabled: !!r.enabled,
      lastRunAt: r.last_run_at ?? null,
      lastStatus: r.last_status ?? null,
    }));
  }

  async startRun(trigger: string): Promise<string> {
    const id = ulid();
    await this.db
      .prepare("INSERT INTO runs (id, started_at, trigger) VALUES (?, ?, ?)")
      .bind(id, new Date().toISOString(), trigger)
      .run();
    return id;
  }

  async recordSourceResult(runId: string, r: SourceRunResult): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR REPLACE INTO run_source_results
           (run_id, source_id, status, raw_count, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(runId, r.sourceId, r.status, r.rawCount ?? null, r.error ?? null, r.durationMs ?? null),
      this.db
        .prepare("UPDATE sources SET last_run_at = ?, last_status = ? WHERE id = ?")
        .bind(new Date().toISOString(), r.status, r.sourceId),
    ]);
  }

  async finishRun(
    runId: string,
    counts: { okSources: number; failedSources: number; eventsNew: number; eventsUpdated: number },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE runs SET finished_at=?, ok_sources=?, failed_sources=?, events_new=?, events_updated=? WHERE id=?`,
      )
      .bind(new Date().toISOString(), counts.okSources, counts.failedSources, counts.eventsNew, counts.eventsUpdated, runId)
      .run();
  }

  /**
   * Record a completed scrape run in one shot (used by /api/admin/scrape-report,
   * which the local `push` calls after ingesting). Gives production the run history
   * it otherwise never sees — ingest carries only events, not run metadata.
   */
  async recordRun(r: {
    startedAt?: string;
    finishedAt?: string;
    trigger?: string;
    eventsNew: number;
    eventsUpdated: number;
    sources?: Array<{ sourceId: string; status: string; rawCount?: number; error?: string; durationMs?: number }>;
  }): Promise<string> {
    const id = ulid();
    const now = new Date().toISOString();
    const sources = r.sources ?? [];
    const okSources = sources.filter((s) => s.status === "ok").length;
    const failedSources = sources.filter((s) => s.status !== "ok").length;
    await this.db
      .prepare(
        `INSERT INTO runs (id, started_at, finished_at, trigger, ok_sources, failed_sources, events_new, events_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, r.startedAt ?? now, r.finishedAt ?? now, r.trigger ?? "scrape", okSources, failedSources, r.eventsNew, r.eventsUpdated)
      .run();
    if (sources.length) {
      await this.db.batch(
        sources.map((s) =>
          this.db
            .prepare(`INSERT OR REPLACE INTO run_source_results (run_id, source_id, status, raw_count, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(id, s.sourceId, s.status, s.rawCount ?? null, s.error ?? null, s.durationMs ?? null),
        ),
      );
    }
    return id;
  }

  /**
   * Operational health of the catalog: when it last scraped, how much it got, and
   * whether it's gone stale (missed its daily window). `now`/`staleHours` are
   * injectable for deterministic tests. Backs GET /api/scrape-status.
   */
  async scrapeStatus(opts?: { now?: Date; staleHours?: number }): Promise<{
    lastRunAt: string | null;
    ageHours: number | null;
    stale: boolean;
    totalEvents: number;
    upcomingEvents: number;
    lastRun: (RunSummary & { sources: SourceRunResult[] }) | null;
  }> {
    const now = opts?.now ?? new Date();
    const staleHours = opts?.staleHours ?? 26;
    const last = (await this.listRuns(1))[0] ?? null;
    const totals = await this.db
      .prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN start_utc >= ? THEN 1 ELSE 0 END) AS upcoming FROM events")
      .bind(now.toISOString())
      .first<Row>();
    const ageMs = last ? now.getTime() - new Date(last.startedAt).getTime() : Infinity;
    const ageHours = Number.isFinite(ageMs) ? Math.round((ageMs / 3.6e6) * 10) / 10 : null;
    return {
      lastRunAt: last?.startedAt ?? null,
      ageHours,
      stale: !last || ageMs > staleHours * 3.6e6,
      totalEvents: Number(totals?.total ?? 0),
      upcomingEvents: Number(totals?.upcoming ?? 0),
      lastRun: last ? { ...last, sources: last.sourceResults ?? [] } : null,
    };
  }

  /**
   * Re-resolve every event's city + fingerprint against the current alias set and
   * dedup in place. Needed whenever cities.json changes: the fingerprint embeds the
   * resolved city, so a newly-matchable event (e.g. an old "unknown" Santa Cruz row)
   * would otherwise get a fresh fingerprint on the next scrape and be re-inserted as
   * a duplicate. Collisions merge into the OLDEST row (which owns any RSVPs/reviews);
   * dependents are moved with UPDATE OR IGNORE so nothing user-generated is lost.
   * Idempotent.
   */
  async renormalizeCities(
    resolveCityId: (e: { city: string | null; address: string | null; venueName: string | null }) => string,
  ): Promise<{ scanned: number; updated: number; merged: number }> {
    const rows = (await this.db
      .prepare("SELECT id, fingerprint, title, start_utc, timezone, city, address, venue_name, first_seen_at FROM events")
      .all<Row>()).results ?? [];

    type Rec = { id: string; oldFp: string; oldCity: string; newCity: string; newFp: string; firstSeen: string };
    const recs: Rec[] = rows.map((r) => {
      const newCity = resolveCityId({ city: r.city ?? null, address: r.address ?? null, venueName: r.venue_name ?? null });
      return {
        id: r.id,
        oldFp: r.fingerprint,
        oldCity: r.city,
        newCity,
        newFp: fingerprint({ title: r.title, startUtc: r.start_utc, timezone: r.timezone, city: newCity }),
        firstSeen: r.first_seen_at ?? "",
      };
    });

    // Group by the NEW fingerprint so post-resolution collisions merge into one row.
    const groups = new Map<string, Rec[]>();
    for (const rec of recs) {
      const g = groups.get(rec.newFp);
      if (g) g.push(rec);
      else groups.set(rec.newFp, [rec]);
    }

    // Every table that FK-references events(id); event_sources last so its rows ride along.
    const FK_TABLES = [
      "rsvps", "reviews", "event_photos", "points_ledger", "goals", "review_obligations",
      "subject_reviews", "checkin_tokens", "checkins", "media", "groups", "event_sources",
    ];
    let updated = 0;
    let merged = 0;

    for (const grp of groups.values()) {
      grp.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen) || a.id.localeCompare(b.id));
      const canon = grp[0];
      if (!canon) continue;
      for (const dup of grp.slice(1)) {
        for (const t of FK_TABLES) {
          // OR IGNORE drops a dependent that already exists on the canonical (a
          // duplicate interaction); it then cascade-deletes with the dup row.
          await this.db.prepare(`UPDATE OR IGNORE ${t} SET event_id = ? WHERE event_id = ?`).bind(canon.id, dup.id).run();
        }
        await this.db.prepare("DELETE FROM events WHERE id = ?").bind(dup.id).run();
        merged++;
      }
      if (canon.newCity !== canon.oldCity || canon.newFp !== canon.oldFp) {
        await this.db.prepare("UPDATE events SET city = ?, fingerprint = ? WHERE id = ?").bind(canon.newCity, canon.newFp, canon.id).run();
        updated++;
      }
    }
    return { scanned: rows.length, updated, merged };
  }

  /**
   * Delete events we can confidently place OUTSIDE the region (another US state or
   * country) — Eventbrite/location-search leakage. Only touches city='unknown' rows
   * (anything that matched a Bay alias is kept), and only those the caller's
   * predicate flags, so online / ambiguous events are never dropped. FK CASCADE
   * cleans up the (essentially nonexistent) dependents of scraped noise.
   */
  async pruneOutOfRegion(isOut: (address: string | null) => boolean): Promise<{ scanned: number; removed: number }> {
    const rows = (await this.db.prepare("SELECT id, address FROM events WHERE city = 'unknown'").all<Row>()).results ?? [];
    const toDelete = rows.filter((r) => isOut(r.address ?? null)).map((r) => r.id as string);
    for (let i = 0; i < toDelete.length; i += 100) {
      const chunk = toDelete.slice(i, i + 100);
      await this.db.prepare(`DELETE FROM events WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).run();
    }
    return { scanned: rows.length, removed: toDelete.length };
  }

  async listRuns(limit = 20): Promise<RunSummary[]> {
    const runs = await this.db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
      .bind(limit)
      .all<Row>();
    const out: RunSummary[] = [];
    for (const r of runs.results ?? []) {
      const sr = await this.db
        .prepare("SELECT * FROM run_source_results WHERE run_id = ?")
        .bind(r.id)
        .all<Row>();
      out.push({
        id: r.id,
        startedAt: r.started_at,
        finishedAt: r.finished_at ?? null,
        trigger: r.trigger,
        okSources: r.ok_sources,
        failedSources: r.failed_sources,
        eventsNew: r.events_new,
        eventsUpdated: r.events_updated,
        sourceResults: (sr.results ?? []).map((x) => ({
          sourceId: x.source_id,
          status: x.status,
          rawCount: x.raw_count ?? undefined,
          error: x.error ?? null,
          durationMs: x.duration_ms ?? undefined,
        })),
      });
    }
    return out;
  }

  close(): void {
    /* D1 needs no teardown */
  }
}

const INSERT_SQL = `INSERT INTO events (
  id, fingerprint, title, description, start_utc, end_utc, timezone, venue_name,
  address, city, url, organizer, is_free, price_text, image_url, categories,
  interest_score, interest_reason, tag_source, content_hash, tagged_hash,
  sources_json, first_seen_at, last_seen_at, starred, hidden
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPDATE_SQL = `UPDATE events SET
  fingerprint=?, title=?, description=?, start_utc=?, end_utc=?, timezone=?, venue_name=?,
  address=?, city=?, url=?, organizer=?, is_free=?, price_text=?, image_url=?, categories=?,
  interest_score=?, interest_reason=?, tag_source=?, content_hash=?, tagged_hash=?,
  sources_json=?, first_seen_at=?, last_seen_at=?, starred=?, hidden=?
  WHERE id=?`;
