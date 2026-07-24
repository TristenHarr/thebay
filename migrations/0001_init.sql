-- The Bay — initial D1 schema.
-- Events pipeline (mirrors the local SQLite DDL, + geo + host columns) and the
-- full social layer. FKs point ON DELETE CASCADE where a child is meaningless
-- without its parent. Tables are ordered so every FK target already exists.
-- Invariants are enforced in the schema itself (UNIQUE, CHECK, composite PKs)
-- so the app is pushed into the pit of success.

-- ── identity ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,            -- ULID
  email          TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  handle         TEXT NOT NULL UNIQUE,        -- @handle, lowercased
  display_name   TEXT NOT NULL,
  avatar_key     TEXT,                        -- R2 object key
  bio            TEXT,
  home_city      TEXT,
  social_enabled INTEGER NOT NULL DEFAULT 0,  -- opt-in to the social graph
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);

CREATE TABLE IF NOT EXISTS identities (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,                 -- 'google' | 'github' | 'email'
  provider_uid TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (provider, provider_uid)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,                -- sha-256 of the emailed token
  email      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- ── sources & events (pipeline) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  params_json TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT,
  last_status TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,           -- ULID
  fingerprint     TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  start_utc       TEXT NOT NULL,
  end_utc         TEXT,
  timezone        TEXT NOT NULL,
  venue_name      TEXT,
  address         TEXT,
  city            TEXT NOT NULL,
  latitude        REAL,                       -- geocoded (M6); null until then
  longitude       REAL,
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
  host_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL, -- non-null ⇒ user-hosted
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  starred         INTEGER NOT NULL DEFAULT 0,
  hidden          INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_fingerprint ON events(fingerprint);
CREATE INDEX IF NOT EXISTS idx_events_start  ON events(start_utc);
CREATE INDEX IF NOT EXISTS idx_events_city   ON events(city);
CREATE INDEX IF NOT EXISTS idx_events_score  ON events(interest_score);
CREATE INDEX IF NOT EXISTS idx_events_hidden ON events(hidden);
CREATE INDEX IF NOT EXISTS idx_events_host   ON events(host_user_id);

CREATE TABLE IF NOT EXISTS event_sources (
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL,
  source_type TEXT NOT NULL,
  external_id TEXT,
  url         TEXT NOT NULL,
  PRIMARY KEY (event_id, source_id, url)
);
CREATE INDEX IF NOT EXISTS idx_event_sources_source ON event_sources(source_id);

-- ── social graph ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rsvps (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('going','interested','went')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_rsvps_event ON rsvps(event_id);
CREATE INDEX IF NOT EXISTS idx_rsvps_user  ON rsvps(user_id);

-- one row per pair, with user_low < user_high enforced in app code so A↔B never dupes
CREATE TABLE IF NOT EXISTS friendships (
  user_low     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('pending','accepted','blocked')),
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_low, user_high),
  CHECK (user_low < user_high)
);
CREATE INDEX IF NOT EXISTS idx_friend_high ON friendships(user_high);

-- ── groups & chat ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  event_id   TEXT REFERENCES events(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_event ON groups(event_id);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, created_at);

-- ── user-generated content ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_photos (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  caption    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_photos_event ON event_photos(event_id);

CREATE TABLE IF NOT EXISTS reviews (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, user_id)                  -- one review per person per event
);
CREATE INDEX IF NOT EXISTS idx_reviews_event ON reviews(event_id);

-- ── gamification ────────────────────────────────────────────────────────────
-- Append-only ledger. Points are never client-set: only the server writes here,
-- and dedup_key UNIQUE makes every award idempotent (no double points).
CREATE TABLE IF NOT EXISTS points_ledger (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                   -- 'rsvp'|'checkin'|'photo'|'review'|'host'
  points     INTEGER NOT NULL,
  event_id   TEXT REFERENCES events(id) ON DELETE SET NULL,
  dedup_key  TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_points_user ON points_ledger(user_id);

-- ── geocoding cache (M6) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS geocode_cache (
  norm_address TEXT PRIMARY KEY,
  lat          REAL,
  lng          REAL,
  provider     TEXT,
  created_at   TEXT NOT NULL
);

-- ── scrape run log ──────────────────────────────────────────────────────────
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
