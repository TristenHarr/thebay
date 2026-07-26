-- The learning loop for ranking.
--
-- Every ranked surface (events / news / shadows) is scored by a weight vector that
-- is TRAINED rather than hand-tuned, and the training set is the log of what we
-- actually served. Two tables: what we showed, and what we learned from it.
--
-- Why an impression log at all: the positive labels already exist across `rsvps`,
-- `checkins`, `story_votes`, `comments`, `shadow_reactions` and `match_actions`.
-- What was missing is the DENOMINATOR — the things we showed that nobody touched —
-- and the POSITION we showed them at. Without the former there are no negatives to
-- learn from; without the latter every model just relearns "the old model was right",
-- because rank 1 gets engaged with partly for being rank 1.

-- ── what we served ──────────────────────────────────────────────────────────────
--
-- `dedup_key` makes logging idempotent the same way `points_ledger` and `xp_ledger`
-- do it: one row per (surface, viewer, item, day). A user scrolling the feed back
-- and forth must not manufacture training rows — but the repeat exposure is real
-- signal, so a conflict bumps `times_shown` instead of being dropped. `position`
-- therefore records the FIRST slot the item appeared in, which is also the least
-- biased one.
CREATE TABLE IF NOT EXISTS rank_impressions (
  id            TEXT PRIMARY KEY,                 -- ULID
  surface       TEXT NOT NULL CHECK (surface IN ('events','news','shadows')),
  -- SIGNED-IN ONLY, and NOT NULL so it cannot regress. A signed-out impression looks
  -- like useful data and is actually two bugs:
  --   · it can never be labelled positive. Every engagement we learn from (RSVP,
  --     check-in, vote, comment, reaction) requires an account, so an anonymous row is
  --     a guaranteed negative — not "shown and ignored" but "shown to someone
  --     structurally unable to respond". Training on those teaches the base rate of
  --     being logged out.
  --   · its `dedup_key` would be shared by every anonymous visitor, so `times_shown`
  --     would accumulate across all of them and the fatigue rescorer would suppress
  --     popular items for a first-time reader who had never seen them.
  viewer_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL,                    -- event / story / shadow id
  position      INTEGER NOT NULL CHECK (position >= 0),
  times_shown   INTEGER NOT NULL DEFAULT 1 CHECK (times_shown >= 1),
  -- Which weight vector produced this ordering. Training must never mix rows served
  -- by different policies without knowing which was which.
  model_version TEXT NOT NULL,
  -- The feature vector AS COMPUTED AT SERVE TIME. Denormalized on purpose: the
  -- extractor's output changes meaning as the code evolves, so recomputing features
  -- for an old impression would train on a label that answers a different question.
  features_json TEXT NOT NULL,
  -- 1 = this slot was randomized (see src/core/rank/explore.ts). Exploration rows are
  -- the only ones free of the incumbent model's own prior.
  explored      INTEGER NOT NULL DEFAULT 0 CHECK (explored IN (0, 1)),
  -- P(this item landed in this slot) under the serving policy. The IPW denominator.
  propensity    REAL NOT NULL DEFAULT 1.0 CHECK (propensity > 0 AND propensity <= 1),
  served_at     TEXT NOT NULL,
  -- NULL until labelTick joins this row against the engagement tables. 0 = shown and
  -- not engaged (a real negative), 1 = engaged.
  label         INTEGER CHECK (label IS NULL OR label IN (0, 1)),
  label_kind    TEXT,                             -- 'rsvp'|'checkin'|'vote'|'comment'|'reaction'|'open'|'dismiss'|'none'
  labeled_at    TEXT,
  dedup_key     TEXT NOT NULL UNIQUE,
  -- A label without a labelling time (or the reverse) is a bookkeeping bug, so make
  -- it unrepresentable rather than something a query has to defend against.
  CHECK ((label IS NULL) = (labeled_at IS NULL))
);
-- Training-set selection and GC both scan by surface + time.
CREATE INDEX IF NOT EXISTS idx_rank_imp_surface_time ON rank_impressions(surface, served_at);
-- The labelling join: "did this viewer engage with this item".
CREATE INDEX IF NOT EXISTS idx_rank_imp_viewer_item  ON rank_impressions(viewer_id, item_id);
-- labelTick's work queue. Partial, so it stays small however big the log gets.
CREATE INDEX IF NOT EXISTS idx_rank_imp_unlabeled    ON rank_impressions(surface, served_at)
  WHERE label IS NULL;
-- Exploration rows are read far more often than they are written (they carry most of
-- the training signal), and they are a small fraction of the table.
CREATE INDEX IF NOT EXISTS idx_rank_imp_explored     ON rank_impressions(surface, served_at)
  WHERE explored = 1;

-- ── what we learned ─────────────────────────────────────────────────────────────
--
-- A model is a ROW, not a redeploy — the same choice `tag_vocab` makes for the
-- taxonomy. Every training run appends a candidate; `promoted_at` is set only if it
-- beat the incumbent on a holdout slice.
--
-- The CHECK on promotion is the load-bearing one: an unattended cron that can
-- promote an UNEVALUATED model will eventually promote a broken one and silently
-- ruin the feed forever. The schema refuses to represent that.
CREATE TABLE IF NOT EXISTS rank_models (
  id            TEXT PRIMARY KEY,                 -- ULID
  surface       TEXT NOT NULL CHECK (surface IN ('events','news','shadows')),
  version       INTEGER NOT NULL CHECK (version >= 1),
  -- The logistic-regression weight vector (the "heavy ranker"), keyed by feature name.
  weights_json  TEXT NOT NULL,
  -- The RRF list weights (the "light ranker"/fusion stage) — see src/core/search/rank.ts.
  rrf_json      TEXT NOT NULL,
  n_rows        INTEGER NOT NULL CHECK (n_rows >= 0),
  holdout_auc   REAL CHECK (holdout_auc IS NULL OR (holdout_auc >= 0 AND holdout_auc <= 1)),
  incumbent_auc REAL CHECK (incumbent_auc IS NULL OR (incumbent_auc >= 0 AND incumbent_auc <= 1)),
  trained_at    TEXT NOT NULL,
  promoted_at   TEXT,
  notes         TEXT,
  UNIQUE (surface, version),
  -- Never promote what was never measured.
  CHECK (promoted_at IS NULL OR holdout_auc IS NOT NULL)
);
-- "The live model for this surface" = highest promoted version.
CREATE INDEX IF NOT EXISTS idx_rank_models_live ON rank_models(surface, promoted_at, version);
