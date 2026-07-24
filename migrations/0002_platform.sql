-- The Bay — platform expansion (PLATFORM_SPEC §6).
-- Goals, achievements/streaks, the review-gate, QR check-in, media, the founder
-- graph (intros/mentors/matching/communities), integrations, and the AI agent.
-- Invariants live in the schema: FK ON DELETE CASCADE, CHECK enumerations,
-- composite PKs for one-per-pair, UNIQUE dedup keys for idempotent awards.

-- ── goals ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS goals (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('overall','event')),
  event_id   TEXT REFERENCES events(id) ON DELETE CASCADE,   -- set when kind='event'
  title      TEXT NOT NULL,
  metric     TEXT,
  target     INTEGER,
  progress   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','archived')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','friends','public')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (kind = 'overall' OR event_id IS NOT NULL)            -- event goals need an event
);
CREATE INDEX IF NOT EXISTS idx_goals_user  ON goals(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_event ON goals(event_id);

-- ── gamification ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS achievements (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                                    -- 'first_review'|'5_intros'|'super_connector'|…
  dedup_key  TEXT NOT NULL UNIQUE,                             -- idempotent awards
  meta_json  TEXT NOT NULL DEFAULT '{}',
  awarded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements(user_id);

CREATE TABLE IF NOT EXISTS streaks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,                                       -- 'attend'
  count   INTEGER NOT NULL DEFAULT 0,
  best    INTEGER NOT NULL DEFAULT 0,
  last_at TEXT,
  PRIMARY KEY (user_id, kind)
);

-- ── reviews & the review-gate ─────────────────────────────────────────────────
-- Existing `reviews` stays for event reviews. Obligations enforce: you must review
-- an attended event before registering for the next.
CREATE TABLE IF NOT EXISTS review_obligations (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  satisfied  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_oblig_open ON review_obligations(user_id, satisfied);

-- Generalized reviews of hosts / speakers / participants (event reviews use `reviews`).
CREATE TABLE IF NOT EXISTS subject_reviews (
  id           TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('host','speaker','participant')),
  subject_id   TEXT NOT NULL,                                  -- a user id
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id     TEXT REFERENCES events(id) ON DELETE SET NULL,
  rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  tags_json    TEXT NOT NULL DEFAULT '[]',
  body         TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (subject_type, subject_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_subject_reviews ON subject_reviews(subject_type, subject_id);

-- ── QR check-in ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS checkin_tokens (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkin_tokens_event ON checkin_tokens(event_id);

CREATE TABLE IF NOT EXISTS checkins (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  at       TEXT NOT NULL,
  source   TEXT NOT NULL DEFAULT 'qr' CHECK (source IN ('qr','manual')),
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_checkins_event ON checkins(event_id);

-- ── media (photos + videos) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   TEXT REFERENCES events(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('photo','video')),
  image_id   TEXT,                                             -- Cloudflare Images id
  stream_id  TEXT,                                             -- Cloudflare Stream id
  r2_key     TEXT,                                             -- original
  lat        REAL,
  lng        REAL,
  taken_at   TEXT,
  caption    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_user  ON media(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_media_event ON media(event_id);

CREATE TABLE IF NOT EXISTS media_tags (
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (media_id, user_id)
);

-- ── founder graph: intros ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS intro_requests (
  id             TEXT PRIMARY KEY,
  requester_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_desc    TEXT NOT NULL,                                -- "someone at Sequoia"
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','closed')),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intro_requests_user ON intro_requests(requester_id);

CREATE TABLE IF NOT EXISTS intro_forwards (
  id           TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL REFERENCES intro_requests(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','forwarded','accepted','declined')),
  created_at   TEXT NOT NULL,
  UNIQUE (request_id, connector_id)
);

-- ── founder graph: mentors ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mentor_profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  topics_json  TEXT NOT NULL DEFAULT '[]',
  availability TEXT,
  blurb        TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mentor_requests (
  id         TEXT PRIMARY KEY,
  mentee_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mentor_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at TEXT NOT NULL,
  UNIQUE (mentee_id, mentor_id)
);

-- ── founder graph: matching ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS match_prefs (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  has_idea      INTEGER,
  technical     INTEGER,
  commitment    TEXT,
  radius_km     INTEGER,
  interests_json TEXT NOT NULL DEFAULT '[]',
  looking       INTEGER NOT NULL DEFAULT 0,                    -- opted into the deck
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS match_actions (
  actor_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action    TEXT NOT NULL CHECK (action IN ('invite','save','skip','hide')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, target_id)
);

-- ── communities + themed groups ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS communities (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_members (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',
  joined_at    TEXT NOT NULL,
  PRIMARY KEY (community_id, user_id)
);
ALTER TABLE groups ADD COLUMN theme TEXT;
ALTER TABLE groups ADD COLUMN theme_color TEXT;

-- ── integrations ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integration_accounts (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (provider IN ('luma','eventbrite','meetup','calendar','linkedin','telegram')),
  token_json   TEXT NOT NULL DEFAULT '{}',
  connected_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS imported_items (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind        TEXT NOT NULL,                                   -- 'event'|'connection'
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, provider, external_id)
);

-- ── AI agent ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_settings (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  networking_enabled INTEGER NOT NULL DEFAULT 0,
  guardrails_json    TEXT NOT NULL DEFAULT '{}',
  updated_at         TEXT NOT NULL
);
