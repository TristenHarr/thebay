-- Founder crawls — named, shareable ROUTES through the city (a pub crawl for VC
-- landmarks + events). You plan a crawl as an ordered list of stops, others join and
-- "mob" it together; reaching each stop (GPS-verified) pays waypoint XP, finishing
-- the whole route pays a bonus. Both breadcrumb trails (movement) and these planned
-- routes are "trails" — this is the planned, competitive half.
CREATE TABLE IF NOT EXISTS crawls (
  id          TEXT PRIMARY KEY,               -- ULID
  name        TEXT NOT NULL,
  description TEXT,
  creator_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_public   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crawls_public ON crawls(is_public, created_at);

CREATE TABLE IF NOT EXISTS crawl_stops (
  crawl_id TEXT NOT NULL REFERENCES crawls(id) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,                  -- order along the route (0-based)
  name     TEXT NOT NULL,
  lat      REAL NOT NULL,
  lng      REAL NOT NULL,
  PRIMARY KEY (crawl_id, idx)
);

CREATE TABLE IF NOT EXISTS crawl_participants (
  crawl_id    TEXT NOT NULL REFERENCES crawls(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at   TEXT NOT NULL,
  progress    INTEGER NOT NULL DEFAULT 0,     -- stops reached (sequential)
  finished_at TEXT,
  PRIMARY KEY (crawl_id, user_id)
);
