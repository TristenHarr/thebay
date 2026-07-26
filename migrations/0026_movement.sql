-- Movement log — the record behind "mobbing" (turn on live movement, earn XP for
-- moving through the city). One row per accepted ping: where you were, how far since
-- the last ping, the implied speed, XP awarded, and whether it was flagged as
-- implausible (we DON'T block spoofers — semi-cheatable by design — but the tracker
-- sees them). Doubles as the source for your fading breadcrumb TRAIL and for the
-- admin movement tracker. XP itself lands in xp_ledger; this is the telemetry + cap.
CREATE TABLE IF NOT EXISTS movement_log (
  id       TEXT PRIMARY KEY,                 -- ULID
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat      REAL NOT NULL,
  lng      REAL NOT NULL,
  cell     TEXT NOT NULL,                     -- geohash p7 (~150m) — presence/trail index
  at       TEXT NOT NULL,
  dist_m   REAL NOT NULL DEFAULT 0,           -- metres since this user's previous ping
  mps      REAL NOT NULL DEFAULT 0,           -- implied speed (for the tracker)
  xp       INTEGER NOT NULL DEFAULT 0,        -- movement XP awarded for this segment
  flagged  INTEGER NOT NULL DEFAULT 0,        -- 1 = implausible speed / teleport
  scope    TEXT NOT NULL DEFAULT 'public'     -- public | friends | group:<id>
);
CREATE INDEX IF NOT EXISTS idx_move_user_at ON movement_log(user_id, at);
CREATE INDEX IF NOT EXISTS idx_move_at      ON movement_log(at);
CREATE INDEX IF NOT EXISTS idx_move_cell    ON movement_log(cell, at);
