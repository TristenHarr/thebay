-- Catches — the founder "Pokédex". The whole game's twist: the collectibles are
-- PEOPLE. You catch someone by scanning their rotating catch QR (a per-user mirror of
-- checkin_tokens — you must be physically together), which snapshots their derived
-- stats + rarity (src/core/xp/stats) and adds them to your collection. You catch each
-- person once; rarer founders are worth more XP.
CREATE TABLE IF NOT EXISTS catch_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catch_tokens_user ON catch_tokens(user_id);

CREATE TABLE IF NOT EXISTS catches (
  catcher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caught_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caught_at  TEXT NOT NULL,
  rarity     TEXT NOT NULL,        -- snapshot at catch time (their card can grow later)
  power      INTEGER NOT NULL,
  stats_json TEXT NOT NULL,        -- the full FounderStats snapshot
  PRIMARY KEY (catcher_id, caught_id)
);
CREATE INDEX IF NOT EXISTS idx_catches_catcher ON catches(catcher_id, caught_at);
