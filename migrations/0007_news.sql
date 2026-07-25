-- thebay.news — an HN-shaped link aggregator + discussion, sharing this database
-- with the events platform so a story can point at a real event and a commenter
-- can be shown to have actually been there.
--
-- Two invariants are pushed into the schema here:
--   1. ONE STORY PER LINK. `stories.url_hash` is UNIQUE over the canonicalized URL,
--      and `story_sources` carries the many attributions (HN + Lobsters + RSS + a
--      human can all surface the same article; readers should see one row with
--      four credits, not four rows).
--   2. ONE VOTE PER PERSON. `story_votes` / `comment_votes` are keyed on the pair,
--      mirroring `rsvps`, so double-voting is unrepresentable rather than guarded.

CREATE TABLE IF NOT EXISTS stories (
  id             TEXT PRIMARY KEY,                 -- ULID
  kind           TEXT NOT NULL DEFAULT 'link' CHECK (kind IN ('link','text','ask','show')),
  title          TEXT NOT NULL,
  url            TEXT,                             -- null for text/ask posts
  url_hash       TEXT,                             -- canonicalized URL hash; UNIQUE below
  body           TEXT,                             -- self-post text
  -- Null for ingested stories (no local author) and for authors who delete their
  -- account — the discussion outlives the submitter, as on HN.
  author_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  origin         TEXT NOT NULL DEFAULT 'bay' CHECK (origin IN ('bay','hn','lobsters','rss','event')),
  event_id       TEXT REFERENCES events(id) ON DELETE SET NULL,
  summary        TEXT,                             -- AI TL;DR; null when unavailable
  topics_json    TEXT NOT NULL DEFAULT '[]',
  -- URL-safe title, so a story is /item/<id>/<slug> rather than a bare id. Search
  -- engines and humans both read the slug; the id is what actually resolves it.
  slug           TEXT,
  -- Link preview / SEO metadata, harvested from the target page's OpenGraph tags.
  -- Stored rather than fetched at render time: a news front page must not depend
  -- on 30 third-party origins being up, and crawlers must get these synchronously.
  image_url      TEXT,
  description    TEXT,
  site_name      TEXT,
  favicon_url    TEXT,
  author_name    TEXT,                             -- article:author, for ingested items
  published_at   TEXT,                             -- article:published_time (JSON-LD datePublished)
  lang           TEXT,
  preview_fetched_at TEXT,                         -- null = never harvested; drives the backfill
  vote_count     INTEGER NOT NULL DEFAULT 0,
  comment_count  INTEGER NOT NULL DEFAULT 0,
  score          REAL NOT NULL DEFAULT 0,          -- cached rank; recomputed by cron
  dead           INTEGER NOT NULL DEFAULT 0,       -- moderation tombstone (never hard-delete)
  created_at     TEXT NOT NULL,
  -- A link post must carry a URL; a text post must carry a body. Enforced here so
  -- no handler can persist a story that renders as an empty row.
  CHECK ((kind = 'link' AND url IS NOT NULL) OR (kind <> 'link' AND (body IS NOT NULL OR url IS NOT NULL)))
);
-- Partial UNIQUE: many text posts have no URL, but a given link exists at most once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stories_url_hash ON stories(url_hash) WHERE url_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stories_created ON stories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_rank    ON stories(dead, score DESC);
CREATE INDEX IF NOT EXISTS idx_stories_origin  ON stories(origin, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_event   ON stories(event_id);

-- Where a story was seen, and what it scored there. One row per (story, origin).
-- `external_url` is the DISCUSSION url on that site — we link readers to the
-- original article and offer their thread as a separate, credited destination.
CREATE TABLE IF NOT EXISTS story_sources (
  story_id          TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  origin            TEXT NOT NULL CHECK (origin IN ('bay','hn','lobsters','rss','event')),
  external_id       TEXT NOT NULL,
  external_url      TEXT,
  external_points   INTEGER,
  external_comments INTEGER,
  fetched_at        TEXT NOT NULL,
  PRIMARY KEY (story_id, origin, external_id)
);
-- Lets ingestion ask "have I already seen HN item 12345?" without a table scan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_sources_ext ON story_sources(origin, external_id);

CREATE TABLE IF NOT EXISTS story_votes (
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (story_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_story_votes_user ON story_votes(user_id);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,                     -- ULID
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES comments(id) ON DELETE CASCADE,  -- null = top level
  author_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  depth      INTEGER NOT NULL DEFAULT 0,
  vote_count INTEGER NOT NULL DEFAULT 0,
  dead       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_story  ON comments(story_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);

CREATE TABLE IF NOT EXISTS comment_votes (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);

-- Cross-domain sign-in. thebay.events and thebay.news are different registrable
-- domains, so no cookie can span them; a signed-in user is handed across via a
-- single-use token instead. Stored HASHED, claimed with one atomic guarded UPDATE
-- (see src/auth/magic.ts for why check-then-act is not good enough), and the
-- destination path lives HERE rather than in the query string so the landing
-- endpoint cannot be turned into an open redirect.
CREATE TABLE IF NOT EXISTS handoff_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_host TEXT NOT NULL,
  next_path   TEXT NOT NULL DEFAULT '/',
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoff_expires ON handoff_tokens(expires_at);
