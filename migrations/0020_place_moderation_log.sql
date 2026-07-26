-- 0017 taught `flags` to accept a 'place' target, so a pin can be reported. But
-- the other half of moderation never learned: `moderation_actions` — the audit log
-- every mutation writes in the same call — still only admits 'story'|'comment'|
-- 'user'. So reports arrived and could be listed, and then hiding the pin would
-- have failed the CHECK on the log insert. A report you can file but not act on is
-- worse than no report at all.
--
-- Same TABLE REBUILD hazard as 0009/0017: SQLite cannot ALTER a CHECK. Unlike
-- `flags` this table has no children *and* nothing references it, so the cascade
-- risk that nearly destroyed every comment and vote in 0009 doesn't apply here.
-- What does apply: this is the permanent record of every moderation decision ever
-- made, and it must survive intact. So the rows are parked in an FK-free table
-- rather than trusting `PRAGMA foreign_keys = OFF`, whose behaviour differs across
-- D1, better-sqlite3 and transaction context — the exact class of thing that
-- passes CI and loses data in production.
--
-- tests/places-moderation.test.ts asserts the audit rows survive the rebuild.

-- ── 1. park the log somewhere with no foreign keys ─────────────────────────────
CREATE TABLE IF NOT EXISTS _mig20_modlog AS SELECT * FROM moderation_actions;

-- ── 2. drop the old table ─────────────────────────────────────────────────────
DROP TABLE moderation_actions;

-- ── 3. rebuild with 'place' in the target vocabulary ──────────────────────────
CREATE TABLE moderation_actions (
  id          TEXT PRIMARY KEY,                       -- ULID
  target_type TEXT NOT NULL CHECK (target_type IN ('story','comment','user','place')),
  target_id   TEXT NOT NULL,
  -- Unchanged from 0008. No 'auto_hide': nothing here acts without a person.
  -- 'hide'/'unhide' already cover a pin — a place needs no new verb.
  action      TEXT NOT NULL CHECK (action IN ('hide','unhide','kill','revive','ban','unban','block_domain','unblock_domain')),
  -- Null for automated actions, so "who did this" is never falsely attributed.
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT,
  created_at  TEXT NOT NULL
);

-- ── 4. restore, column-explicit so a future column can't silently reorder ──────
INSERT INTO moderation_actions (id, target_type, target_id, action, actor_id, note, created_at)
SELECT id, target_type, target_id, action, actor_id, note, created_at FROM _mig20_modlog;

-- ── 5. the indexes went with the dropped table ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_modlog_target  ON moderation_actions(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_modlog_created ON moderation_actions(created_at DESC);

-- ── 6. tidy up ────────────────────────────────────────────────────────────────
DROP TABLE _mig20_modlog;
