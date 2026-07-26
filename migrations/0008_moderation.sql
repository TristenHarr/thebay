-- Moderation for thebay.news.
--
-- Until now the only lever was hand-written SQL against production: the `dead`
-- column existed on stories and comments but nothing ever set it. That is fine
-- with no users and untenable with any.
--
-- The governing rule is LET PEOPLE SPEAK. Moderation here is for spam and floods,
-- not opinions, so NOTHING in this schema removes anything automatically:
--
--   flags              — readers reporting content. A flag is a signal that sorts
--                        a human's queue. It never hides anything by itself, at
--                        any count — otherwise three annoyed readers can silence
--                        one person, which is the dynamic people rightly resent.
--   moderation_actions — an append-only audit log. Every hide/unhide/ban is
--                        attributable and reversible.
--   blocked_domains    — domains an operator blocked AFTER seeing spam. A human
--                        decision that gets logged like any other, not a filter
--                        that silently eats submissions.
--
-- Nothing here hard-deletes. Moderation that destroys evidence is how you end up
-- unable to answer "why was this removed?".

CREATE TABLE IF NOT EXISTS flags (
  target_type TEXT NOT NULL CHECK (target_type IN ('story','comment')),
  target_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL DEFAULT 'other'
              CHECK (reason IN ('spam','off_topic','abuse','duplicate','broken','other')),
  created_at  TEXT NOT NULL,
  -- One flag per person per item: flagging is a signal, not a vote you can stack.
  -- The flagger is recorded, so brigading is visible to whoever reviews the queue.
  PRIMARY KEY (target_type, target_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_flags_target ON flags(target_type, target_id);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id          TEXT PRIMARY KEY,                       -- ULID
  target_type TEXT NOT NULL CHECK (target_type IN ('story','comment','user')),
  target_id   TEXT NOT NULL,
  -- No 'auto_hide': nothing here acts without a person.
  action      TEXT NOT NULL CHECK (action IN ('hide','unhide','kill','revive','ban','unban','block_domain','unblock_domain')),
  -- Null for automated actions, so "who did this" is never falsely attributed.
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modlog_target  ON moderation_actions(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_modlog_created ON moderation_actions(created_at DESC);

CREATE TABLE IF NOT EXISTS blocked_domains (
  domain     TEXT PRIMARY KEY,                        -- canonical host, no www.
  reason     TEXT,
  created_at TEXT NOT NULL
);

-- Banned users can still read; they just can't write. Enforced in the write gate
-- rather than by deleting the account, so their existing contributions keep their
-- attribution and the decision stays reversible.
ALTER TABLE users ADD COLUMN banned_at TEXT;
