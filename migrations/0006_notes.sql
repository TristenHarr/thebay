-- Map bulletin board — localized "notes" (Yik-Yak-style), each dropped at the
-- author's GPS point. Posting is gated to the Bay Area in the route (src/core/geo).
CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,               -- ULID
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);
