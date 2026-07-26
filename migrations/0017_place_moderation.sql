-- A crowd map needs the same "this is wrong / this is spam" lever the news site
-- has, pointed at a pin. `flags` already is that lever — it just doesn't accept
-- 'place' as a target type.
--
-- SQLite cannot ALTER a CHECK, so this is a TABLE REBUILD, the shape that in
-- 0009 silently deleted every comment and vote on the site (DROP TABLE cascaded
-- into children) and looked completely fine while doing it. `flags` has no
-- children of its own, but it holds every abuse report ever filed, so this
-- follows the same park-the-rows-in-an-FK-free-table dance rather than trusting
-- `PRAGMA foreign_keys = OFF` (support varies across D1, better-sqlite3 and
-- transaction context — exactly the thing that passes CI and fails in prod).
-- No pragmas, no driver assumptions, re-runnable.
-- tests/places-migration.test.ts asserts the rows survive.

-- ── 1. park the rows somewhere with no foreign keys ───────────────────────────
CREATE TABLE IF NOT EXISTS _mig17_flags AS SELECT * FROM flags;

-- ── 2. drop the old table ─────────────────────────────────────────────────────
DROP TABLE flags;

-- ── 3. rebuild with 'place' in the vocabulary ─────────────────────────────────
CREATE TABLE flags (
  target_type TEXT NOT NULL CHECK (target_type IN ('story','comment','place')),
  target_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL DEFAULT 'other'
              CHECK (reason IN ('spam','off_topic','abuse','duplicate','broken','other')),
  created_at  TEXT NOT NULL,
  -- Unchanged from 0008: one flag per person per item. Flagging is a signal that
  -- sorts a human's queue, never a vote you can stack, and never an auto-hide.
  PRIMARY KEY (target_type, target_id, user_id)
);

-- ── 4. restore ────────────────────────────────────────────────────────────────
INSERT INTO flags (target_type, target_id, user_id, reason, created_at)
SELECT target_type, target_id, user_id, reason, created_at FROM _mig17_flags;

-- ── 5. the index went with the dropped table ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_flags_target ON flags(target_type, target_id);

-- ── 6. tidy up ────────────────────────────────────────────────────────────────
DROP TABLE _mig17_flags;
