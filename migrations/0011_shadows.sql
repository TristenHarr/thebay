-- Shadows — ephemeral, geo-located, location-sharded posts (the live "board" that
-- floats over the home page). Every shadow expires 24h after posting; one active
-- per author (a new one replaces the old); posting is Bay-GPS-gated in the route
-- (src/core/geo). Sharded by geohash cell (src/core/geohash) so each cell maps to
-- its own Durable Object — no single hot object. Supersedes the permanent `notes`.
CREATE TABLE IF NOT EXISTS shadows (
  id                 TEXT PRIMARY KEY,              -- ULID
  author_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat                REAL NOT NULL,
  lng                REAL NOT NULL,
  cell               TEXT NOT NULL,                 -- geohash, precision 6 (~1.2km)
  kind               TEXT NOT NULL CHECK (kind IN ('thought','photo','voice','video','connection')),
  body               TEXT,                          -- text / caption (null for pure media)
  media_key          TEXT,                          -- R2 object key (photo/voice)
  stream_id          TEXT,                          -- Cloudflare Stream id (video)
  connection_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,  -- for kind='connection'
  mod_status         TEXT NOT NULL DEFAULT 'ok' CHECK (mod_status IN ('pending','ok','blocked')),
  mod_reason         TEXT,
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL                  -- created_at + 24h
);
CREATE INDEX IF NOT EXISTS idx_shadows_cell    ON shadows(cell, expires_at);
CREATE INDEX IF NOT EXISTS idx_shadows_author  ON shadows(author_id);
CREATE INDEX IF NOT EXISTS idx_shadows_expires ON shadows(expires_at);

-- Ephemeral emoji reactions (disappear with the shadow via FK CASCADE).
CREATE TABLE IF NOT EXISTS shadow_reactions (
  shadow_id  TEXT NOT NULL REFERENCES shadows(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (shadow_id, user_id, emoji)
);
