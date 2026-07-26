-- Experience (XP) — the game's leveling track, deliberately SEPARATE from the
-- social `points_ledger` (which stays the credible "founder score"). XP comes from
-- movement, orbs, catches, crawls (see src/core/xp/*). Mirrors points_ledger: every
-- grant is idempotent via a globally-UNIQUE dedup_key (so the keys embed the user +
-- the thing earned, e.g. 'movement:<user>:<day>', and re-running never double-grants).
CREATE TABLE IF NOT EXISTS xp_ledger (
  id         TEXT PRIMARY KEY,                 -- ULID
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                    -- 'movement'|'orb'|'catch'|'crawl'|'shadow'|…
  xp         INTEGER NOT NULL,
  dedup_key  TEXT NOT NULL UNIQUE,
  meta_json  TEXT,                             -- optional context (distance, orb id, caught user, …)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_xp_user      ON xp_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_xp_user_kind ON xp_ledger(user_id, kind);
