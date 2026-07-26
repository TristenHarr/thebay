-- Rank on when a story reached US; keep displaying when it actually happened.
--
-- `stories.created_at` is the SOURCE's date: an HN post's submit time, an RSS
-- item's pubDate, an SEC filing date, an FDA decision date. That's the right
-- thing to show a reader, and it must not change.
--
-- But `hot` gates candidates on created_at >= 7 days, and some sources publish
-- with structural lag. openFDA is the clear case: it releases 510(k) records
-- roughly two weeks after the decision date printed on them, so every clearance
-- we ingest is born ~16 days "old" and can never enter a 7-day window. Fourteen
-- of them landed and not one could reach the front page. Nothing was broken;
-- the source was simply unreachable by construction.
--
-- So: hot now windows and decays on first_seen_at (when it entered our feed),
-- while every displayed timestamp still comes from created_at. "Hot" means
-- recently surfaced here, which is what a reader actually means by it.
--
-- ALTER ADD COLUMN, deliberately: no table rebuild, so this cannot cascade into
-- comments and votes the way 0009 nearly did.
ALTER TABLE stories ADD COLUMN first_seen_at TEXT;

-- Exact backfill, not an approximation. story_sources rows are written with
-- INSERT OR IGNORE, so fetched_at is never overwritten on re-ingest — it is
-- already a true first-seen timestamp. Human submissions have no source row and
-- fall back to created_at, which for them is the same instant anyway.
UPDATE stories
   SET first_seen_at = COALESCE(
         (SELECT MIN(ss.fetched_at) FROM story_sources ss WHERE ss.story_id = stories.id),
         created_at);

CREATE INDEX IF NOT EXISTS idx_stories_first_seen ON stories(first_seen_at DESC);
