-- The audit trail for automatic scraper promotion.
--
-- The scrape network lets anyone propose a better recipe (migrations/0025), and a candidate
-- that wins its shadow trial replaces the live one with no deploy and no human in the loop.
-- Automating that is only defensible if two things hold, and this table is both of them:
--
--   1. EVERY DECISION IS RECONSTRUCTABLE. `stats_json` keeps the numbers the verdict was
--      computed from — yield, precision, completeness, request cost, windows, days — so
--      "why is this recipe live?" has an answer six months later. A promotion nobody can
--      reconstruct is a promotion nobody can argue with, which is the wrong kind of
--      unarguable.
--   2. EVERY DECISION IS REVERSIBLE. `rollback` is a verdict like any other, and because
--      recipes are versioned rather than edited in place, undoing a bad promotion is one
--      UPDATE that makes the previous version active again.
--
-- Deliberately append-only and never cleaned up: this is small (one row per audit pass per
-- candidate) and it is the only record of how the catalog's scrapers came to be what they
-- are. Guarded by tests/net-recipes.test.ts.
CREATE TABLE IF NOT EXISTS recipe_audits (
  id           TEXT PRIMARY KEY,                 -- ULID
  recipe_id    TEXT NOT NULL REFERENCES scrape_recipes(id) ON DELETE CASCADE,
  source_id    TEXT NOT NULL,
  -- What it was judged against. NULL when the source had no live recipe (a brand new
  -- source), and ON DELETE SET NULL so retiring an ancient incumbent can't erase the
  -- record of the decision it lost.
  incumbent_id TEXT REFERENCES scrape_recipes(id) ON DELETE SET NULL,
  verdict      TEXT NOT NULL CHECK (verdict IN ('promote','keep','reject','rollback')),
  reason       TEXT NOT NULL,
  stats_json   TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipe_audits_recipe ON recipe_audits(recipe_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recipe_audits_source ON recipe_audits(source_id, created_at DESC);
