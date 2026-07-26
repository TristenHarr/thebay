-- Add `reddit` to the origin vocabulary.
--
-- Same table-rebuild dance as 0009, and the same hazard: dropping `stories`
-- cascades into comments/votes/sources. Children are parked in FK-free tables
-- first. See 0009 for the full explanation; tests/news-migration.test.ts guards
-- both.
CREATE TABLE IF NOT EXISTS _mig10_comments AS SELECT * FROM comments;
CREATE TABLE IF NOT EXISTS _mig10_votes    AS SELECT * FROM story_votes;
CREATE TABLE IF NOT EXISTS _mig10_sources  AS SELECT * FROM story_sources;
CREATE TABLE IF NOT EXISTS _mig10_stories  AS SELECT * FROM stories;
CREATE TABLE IF NOT EXISTS _mig10_cvotes   AS SELECT * FROM comment_votes;

DROP TABLE comment_votes;
DROP TABLE comments;
DROP TABLE story_votes;
DROP TABLE story_sources;
DROP TABLE stories;

CREATE TABLE stories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'link' CHECK (kind IN ('link','text','ask','show')),
  title TEXT NOT NULL, url TEXT, url_hash TEXT, body TEXT,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  origin TEXT NOT NULL DEFAULT 'bay'
         CHECK (origin IN ('bay','hn','lobsters','rss','event','github','sec','reddit')),
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  summary TEXT, topics_json TEXT NOT NULL DEFAULT '[]', slug TEXT,
  image_url TEXT, description TEXT, site_name TEXT, favicon_url TEXT,
  author_name TEXT, published_at TEXT, lang TEXT, preview_fetched_at TEXT,
  vote_count INTEGER NOT NULL DEFAULT 0, comment_count INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0, dead INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  CHECK ((kind = 'link' AND url IS NOT NULL) OR (kind <> 'link' AND (body IS NOT NULL OR url IS NOT NULL)))
);
CREATE TABLE story_sources (
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('bay','hn','lobsters','rss','event','github','sec','reddit')),
  external_id TEXT NOT NULL, external_url TEXT, external_points INTEGER,
  external_comments INTEGER, fetched_at TEXT NOT NULL,
  PRIMARY KEY (story_id, origin, external_id)
);
CREATE TABLE story_votes (
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY (story_id, user_id)
);
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0,
  vote_count INTEGER NOT NULL DEFAULT 0, dead INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE comment_votes (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY (comment_id, user_id)
);

INSERT INTO stories (id,kind,title,url,url_hash,body,author_id,origin,event_id,summary,topics_json,slug,
  image_url,description,site_name,favicon_url,author_name,published_at,lang,preview_fetched_at,
  vote_count,comment_count,score,dead,created_at)
SELECT id,kind,title,url,url_hash,body,author_id,origin,event_id,summary,topics_json,slug,
  image_url,description,site_name,favicon_url,author_name,published_at,lang,preview_fetched_at,
  vote_count,comment_count,score,dead,created_at FROM _mig10_stories;
INSERT INTO story_sources SELECT * FROM _mig10_sources;
INSERT INTO story_votes   SELECT * FROM _mig10_votes;
INSERT INTO comments      SELECT * FROM _mig10_comments;
INSERT INTO comment_votes SELECT * FROM _mig10_cvotes;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stories_url_hash ON stories(url_hash) WHERE url_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stories_created ON stories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_rank    ON stories(dead, score DESC);
CREATE INDEX IF NOT EXISTS idx_stories_origin  ON stories(origin, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_event   ON stories(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_sources_ext ON story_sources(origin, external_id);
CREATE INDEX IF NOT EXISTS idx_story_votes_user ON story_votes(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_story  ON comments(story_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);

DROP TABLE _mig10_stories; DROP TABLE _mig10_sources; DROP TABLE _mig10_votes;
DROP TABLE _mig10_comments; DROP TABLE _mig10_cvotes;
