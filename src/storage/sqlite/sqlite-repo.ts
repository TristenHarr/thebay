import { ulid } from "ulid";
import type { CanonicalEvent } from "../../core/models/event";
import type { SourceConfig } from "../../core/models/source";
import { mergeEvents } from "../../core/dedup";
import { openDb, type Db } from "./db";
import { migrate } from "./migrations";
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

function rowToCanonical(r: Row): CanonicalEvent {
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
    isFree: r.is_free === null || r.is_free === undefined ? null : !!r.is_free,
    priceText: r.price_text ?? null,
    imageUrl: r.image_url ?? null,
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

function toBind(e: CanonicalEvent): Row {
  return {
    id: e.id,
    fingerprint: e.fingerprint,
    title: e.title,
    description: e.description,
    startUtc: e.startUtc,
    endUtc: e.endUtc,
    timezone: e.timezone,
    venueName: e.venueName,
    address: e.address,
    city: e.city,
    url: e.url,
    organizer: e.organizer,
    isFree: e.isFree === null ? null : e.isFree ? 1 : 0,
    priceText: e.priceText,
    imageUrl: e.imageUrl,
    categories: JSON.stringify(e.categories),
    interestScore: e.interestScore,
    interestReason: e.interestReason,
    tagSource: e.tagSource,
    contentHash: e.contentHash,
    taggedHash: e.taggedHash,
    sourcesJson: JSON.stringify(e.sources),
    firstSeenAt: e.firstSeenAt,
    lastSeenAt: e.lastSeenAt,
    starred: e.starred ? 1 : 0,
    hidden: e.hidden ? 1 : 0,
  };
}

const INSERT_SQL = `INSERT INTO events (
  id, fingerprint, title, description, start_utc, end_utc, timezone, venue_name,
  address, city, url, organizer, is_free, price_text, image_url, categories,
  interest_score, interest_reason, tag_source, content_hash, tagged_hash,
  sources_json, first_seen_at, last_seen_at, starred, hidden
) VALUES (
  @id, @fingerprint, @title, @description, @startUtc, @endUtc, @timezone, @venueName,
  @address, @city, @url, @organizer, @isFree, @priceText, @imageUrl, @categories,
  @interestScore, @interestReason, @tagSource, @contentHash, @taggedHash,
  @sourcesJson, @firstSeenAt, @lastSeenAt, @starred, @hidden
)`;

const UPDATE_SQL = `UPDATE events SET
  title=@title, description=@description, start_utc=@startUtc, end_utc=@endUtc,
  timezone=@timezone, venue_name=@venueName, address=@address, city=@city, url=@url,
  organizer=@organizer, is_free=@isFree, price_text=@priceText, image_url=@imageUrl,
  categories=@categories, interest_score=@interestScore, interest_reason=@interestReason,
  tag_source=@tagSource, content_hash=@contentHash, tagged_hash=@taggedHash,
  sources_json=@sourcesJson, first_seen_at=@firstSeenAt, last_seen_at=@lastSeenAt,
  starred=@starred, hidden=@hidden
  WHERE id=@id`;

function inClause(col: string, values: string[], params: any[]): string {
  const placeholders = values.map(() => "?").join(",");
  params.push(...values);
  return `${col} IN (${placeholders})`;
}

export class SqliteRepository implements Repository {
  private db: Db;

  constructor(path?: string) {
    this.db = openDb(path);
    migrate(this.db);
  }

  async upsertEvents(events: CanonicalEvent[]): Promise<UpsertResult> {
    const findByFp = this.db.prepare(
      "SELECT * FROM events WHERE fingerprint = ?",
    );
    const insert = this.db.prepare(INSERT_SQL);
    const update = this.db.prepare(UPDATE_SQL);
    const delSources = this.db.prepare(
      "DELETE FROM event_sources WHERE event_id = ?",
    );
    const insSource = this.db.prepare(
      `INSERT OR IGNORE INTO event_sources
       (event_id, source_id, source_type, external_id, url)
       VALUES (?, ?, ?, ?, ?)`,
    );

    const writeSources = (e: CanonicalEvent) => {
      delSources.run(e.id);
      for (const s of e.sources) {
        insSource.run(e.id, s.sourceId, s.sourceType, s.externalId ?? null, s.url);
      }
    };

    let inserted = 0;
    let updated = 0;
    const tx = this.db.transaction((batch: CanonicalEvent[]) => {
      for (const incoming of batch) {
        const existingRow = findByFp.get(incoming.fingerprint) as Row | undefined;
        if (!existingRow) {
          insert.run(toBind(incoming));
          writeSources(incoming);
          inserted++;
        } else {
          const merged = mergeEvents(rowToCanonical(existingRow), incoming);
          update.run(toBind(merged));
          writeSources(merged);
          updated++;
        }
      }
    });
    tx(events);
    return { inserted, updated };
  }

  private buildWhere(
    filter: EventFilter,
    opts: { includeMultiSelect: boolean },
  ): { clause: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];

    if (!filter.includeHidden) clauses.push("hidden = 0");
    if (filter.from) {
      clauses.push("start_utc >= ?");
      params.push(filter.from);
    }
    if (filter.to) {
      clauses.push("start_utc <= ?");
      params.push(filter.to);
    }
    if (filter.free) clauses.push("is_free = 1");
    if (typeof filter.minScore === "number" && filter.minScore > 0) {
      clauses.push("interest_score >= ?");
      params.push(filter.minScore);
    }
    if (filter.starred) clauses.push("starred = 1");
    if (filter.q && filter.q.trim()) {
      const tokens = filter.q.trim().toLowerCase().split(/\s+/).slice(0, 8);
      for (const t of tokens) {
        clauses.push(
          "(lower(title) LIKE ? OR lower(coalesce(description,'')) LIKE ? OR lower(coalesce(organizer,'')) LIKE ? OR lower(coalesce(venue_name,'')) LIKE ?)",
        );
        const like = `%${t}%`;
        params.push(like, like, like, like);
      }
    }

    if (opts.includeMultiSelect) {
      if (filter.cities?.length) {
        clauses.push(inClause("city", filter.cities, params));
      }
      if (filter.sources?.length) {
        const ph = filter.sources.map(() => "?").join(",");
        clauses.push(
          `id IN (SELECT event_id FROM event_sources WHERE source_id IN (${ph}))`,
        );
        params.push(...filter.sources);
      }
      if (filter.categories?.length) {
        const ph = filter.categories.map(() => "?").join(",");
        clauses.push(
          `EXISTS (SELECT 1 FROM json_each(events.categories) WHERE value IN (${ph}))`,
        );
        params.push(...filter.categories);
      }
    }

    const clause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return { clause, params };
  }

  async queryEvents(filter: EventFilter): Promise<EventQueryResult> {
    const { clause, params } = this.buildWhere(filter, {
      includeMultiSelect: true,
    });

    const order =
      filter.sort === "score"
        ? "ORDER BY (interest_score IS NULL), interest_score DESC, start_utc ASC"
        : "ORDER BY start_utc ASC";
    const limit = Math.min(Math.max(filter.limit ?? 500, 1), 100_000);
    const offset = Math.max(filter.offset ?? 0, 0);

    const rows = this.db
      .prepare(`SELECT * FROM events ${clause} ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];

    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM events ${clause}`)
        .get(...params) as Row
    ).n as number;

    return {
      events: rows.map(rowToCanonical),
      total,
      facets: this.computeFacets(filter),
    };
  }

  private computeFacets(filter: EventFilter): EventFacets {
    // Facets ignore the multi-select dimensions so their counts stay stable as
    // the user toggles city/category/source chips.
    const { clause, params } = this.buildWhere(filter, {
      includeMultiSelect: false,
    });

    const cities = this.db
      .prepare(
        `SELECT city AS value, COUNT(*) AS count FROM events ${clause} GROUP BY city ORDER BY count DESC`,
      )
      .all(...params) as FacetCount[];

    const categories = this.db
      .prepare(
        `SELECT je.value AS value, COUNT(*) AS count
         FROM events, json_each(events.categories) je ${clause}
         GROUP BY je.value ORDER BY count DESC`,
      )
      .all(...params) as FacetCount[];

    const idClause = clause
      ? `WHERE event_id IN (SELECT id FROM events ${clause})`
      : "";
    const sources = this.db
      .prepare(
        `SELECT source_id AS value, COUNT(DISTINCT event_id) AS count
         FROM event_sources ${idClause}
         GROUP BY source_id ORDER BY count DESC`,
      )
      .all(...params) as FacetCount[];

    return { cities, categories, sources };
  }

  async getEventById(id: string): Promise<CanonicalEvent | null> {
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? rowToCanonical(row) : null;
  }

  async setEventFlags(
    id: string,
    flags: { starred?: boolean; hidden?: boolean },
  ): Promise<CanonicalEvent | null> {
    const sets: string[] = [];
    const params: any[] = [];
    if (typeof flags.starred === "boolean") {
      sets.push("starred = ?");
      params.push(flags.starred ? 1 : 0);
    }
    if (typeof flags.hidden === "boolean") {
      sets.push("hidden = ?");
      params.push(flags.hidden ? 1 : 0);
    }
    if (sets.length) {
      params.push(id);
      this.db
        .prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`)
        .run(...params);
    }
    return this.getEventById(id);
  }

  async eventsNeedingTags(limit = 500): Promise<CanonicalEvent[]> {
    // Match the dashboard's "upcoming" floor (now - 12h) so currently-running
    // events get tagged too, while still skipping the long tail of past events.
    const now = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE hidden = 0 AND start_utc >= ?
           AND (tag_source IS NULL OR tagged_hash IS NULL OR tagged_hash != content_hash)
         ORDER BY start_utc ASC LIMIT ?`,
      )
      .all(now, limit) as Row[];
    return rows.map(rowToCanonical);
  }

  async applyTags(tags: TagInput[]): Promise<void> {
    const stmt = this.db.prepare(
      `UPDATE events SET categories=@categories, interest_score=@score,
       interest_reason=@reason, tag_source=@source, tagged_hash=content_hash
       WHERE id=@id`,
    );
    const tx = this.db.transaction((batch: TagInput[]) => {
      for (const t of batch) {
        stmt.run({
          id: t.id,
          categories: JSON.stringify(t.categories),
          score: t.interestScore,
          reason: t.interestReason,
          source: t.tagSource,
        });
      }
    });
    tx(tags);
  }

  async countEvents(): Promise<number> {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as Row)
      .n as number;
  }

  async syncSources(sources: SourceConfig[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO sources (id, type, enabled, params_json)
       VALUES (@id, @type, @enabled, @params)
       ON CONFLICT(id) DO UPDATE SET
         type=excluded.type, enabled=excluded.enabled, params_json=excluded.params_json`,
    );
    const tx = this.db.transaction((batch: SourceConfig[]) => {
      for (const s of batch) {
        stmt.run({
          id: s.id,
          type: s.type,
          enabled: s.enabled ? 1 : 0,
          params: JSON.stringify(s.params ?? {}),
        });
      }
    });
    tx(sources);
  }

  async listSources(): Promise<StoredSource[]> {
    const rows = this.db
      .prepare(
        "SELECT id, type, enabled, last_run_at, last_status FROM sources ORDER BY id",
      )
      .all() as Row[];
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      enabled: !!r.enabled,
      lastRunAt: r.last_run_at ?? null,
      lastStatus: r.last_status ?? null,
    }));
  }

  async startRun(trigger: string): Promise<string> {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO runs (id, started_at, trigger) VALUES (?, ?, ?)",
      )
      .run(id, new Date().toISOString(), trigger);
    return id;
  }

  async recordSourceResult(runId: string, r: SourceRunResult): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO run_source_results
         (run_id, source_id, status, raw_count, error, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        r.sourceId,
        r.status,
        r.rawCount ?? null,
        r.error ?? null,
        r.durationMs ?? null,
      );
    this.db
      .prepare("UPDATE sources SET last_run_at = ?, last_status = ? WHERE id = ?")
      .run(new Date().toISOString(), r.status, r.sourceId);
  }

  async finishRun(
    runId: string,
    counts: {
      okSources: number;
      failedSources: number;
      eventsNew: number;
      eventsUpdated: number;
    },
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE runs SET finished_at=?, ok_sources=?, failed_sources=?,
         events_new=?, events_updated=? WHERE id=?`,
      )
      .run(
        new Date().toISOString(),
        counts.okSources,
        counts.failedSources,
        counts.eventsNew,
        counts.eventsUpdated,
        runId,
      );
  }

  async listRuns(limit = 20): Promise<RunSummary[]> {
    const runs = this.db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as Row[];
    const resultStmt = this.db.prepare(
      "SELECT * FROM run_source_results WHERE run_id = ?",
    );
    return runs.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? null,
      trigger: r.trigger,
      okSources: r.ok_sources,
      failedSources: r.failed_sources,
      eventsNew: r.events_new,
      eventsUpdated: r.events_updated,
      sourceResults: (resultStmt.all(r.id) as Row[]).map((sr) => ({
        sourceId: sr.source_id,
        status: sr.status,
        rawCount: sr.raw_count ?? undefined,
        error: sr.error ?? null,
        durationMs: sr.duration_ms ?? undefined,
      })),
    }));
  }

  close(): void {
    this.db.close();
  }
}
