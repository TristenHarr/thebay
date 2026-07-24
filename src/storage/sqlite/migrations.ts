import type { Db } from "./db";

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      params_json TEXT NOT NULL DEFAULT '{}',
      last_run_at TEXT,
      last_status TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id              TEXT PRIMARY KEY,
      fingerprint     TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT,
      start_utc       TEXT NOT NULL,
      end_utc         TEXT,
      timezone        TEXT NOT NULL,
      venue_name      TEXT,
      address         TEXT,
      city            TEXT NOT NULL,
      url             TEXT NOT NULL,
      organizer       TEXT,
      is_free         INTEGER,
      price_text      TEXT,
      image_url       TEXT,
      categories      TEXT NOT NULL DEFAULT '[]',
      interest_score  INTEGER,
      interest_reason TEXT,
      tag_source      TEXT,
      content_hash    TEXT NOT NULL,
      tagged_hash     TEXT,
      sources_json    TEXT NOT NULL DEFAULT '[]',
      first_seen_at   TEXT NOT NULL,
      last_seen_at    TEXT NOT NULL,
      starred         INTEGER NOT NULL DEFAULT 0,
      hidden          INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_fingerprint ON events(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_utc);
    CREATE INDEX IF NOT EXISTS idx_events_city  ON events(city);
    CREATE INDEX IF NOT EXISTS idx_events_score ON events(interest_score);
    CREATE INDEX IF NOT EXISTS idx_events_hidden ON events(hidden);

    CREATE TABLE IF NOT EXISTS event_sources (
      event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      source_id   TEXT NOT NULL,
      source_type TEXT NOT NULL,
      external_id TEXT,
      url         TEXT NOT NULL,
      PRIMARY KEY (event_id, source_id, url)
    );
    CREATE INDEX IF NOT EXISTS idx_event_sources_source ON event_sources(source_id);

    CREATE TABLE IF NOT EXISTS runs (
      id             TEXT PRIMARY KEY,
      started_at     TEXT NOT NULL,
      finished_at    TEXT,
      trigger        TEXT NOT NULL,
      ok_sources     INTEGER NOT NULL DEFAULT 0,
      failed_sources INTEGER NOT NULL DEFAULT 0,
      events_new     INTEGER NOT NULL DEFAULT 0,
      events_updated INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS run_source_results (
      run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      source_id   TEXT NOT NULL,
      status      TEXT NOT NULL,
      raw_count   INTEGER,
      error       TEXT,
      duration_ms INTEGER,
      PRIMARY KEY (run_id, source_id)
    );
  `);
}
