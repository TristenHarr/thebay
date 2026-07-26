-- Track A — search: a real tag model, plus a full-text index.
--
-- WHAT CHANGES AND WHY
--
-- 1. Tags become DATA, not code. Until now the taxonomy was a five-entry array
--    bundled into the Worker at build time, stored per event as a JSON blob in
--    events.categories, and filtered with EXISTS(SELECT 1 FROM json_each(...)) —
--    a full scan that no index can help, and a redeploy to add a tag. tag_vocab +
--    event_tags make the taxonomy a table and the assignment an indexed row, with
--    a confidence and a provenance ('keyword' | 'llm' | 'host' | 'crowd') so a
--    machine guess and a host's own label are distinguishable forever.
--
-- 2. events.categories STAYS IN SYNC. /api/events, the static dashboard
--    (src/server/public/app.js) and the news classifier (src/news/curate.ts) all
--    still read that column, so SearchRepo write-through rebuilds it from the
--    topic facet on every tag write. It is now a derived cache, not the truth.
--
-- 3. Full text search. events_fts is a STANDALONE fts5 table (no content=): the
--    rowid-sync triggers external-content FTS needs are fragile across D1
--    migrations, and event_id is a stable ULID we can key on directly. Sync is by
--    trigger — DELETE-then-INSERT keyed on event_id — so the index cannot drift
--    from the events table no matter which code path writes. Title is weighted
--    8x in bm25 at query time.
--
-- 4. embedded_hash mirrors the existing tagged_hash staleness pattern
--    (d1-repo.ts:282): an event needs re-embedding exactly when
--    embedded_hash != content_hash. The vector index itself is optional — see
--    Env.VECTORIZE — and search must work without it.

-- ── the taxonomy ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tag_vocab (
  id            TEXT PRIMARY KEY,           -- 'facet:slug', e.g. 'topic:hardware'
  facet         TEXT NOT NULL,              -- topic | format | audience | stage | cost | perk
  label         TEXT NOT NULL,
  keywords_json TEXT NOT NULL DEFAULT '[]', -- deterministic matchers (word-boundary)
  emoji         TEXT,
  color         TEXT,
  -- 'proposed' lets the crowd (or a model) suggest a tag without it leaking into
  -- search; 'retired' keeps history readable without ever offering the tag again.
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','proposed','retired')),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tag_vocab_facet ON tag_vocab(facet, status);

-- ── the assignments ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_tags (
  event_id   TEXT NOT NULL REFERENCES events(id)    ON DELETE CASCADE,
  tag_id     TEXT NOT NULL REFERENCES tag_vocab(id) ON DELETE CASCADE,
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  source     TEXT NOT NULL CHECK (source IN ('keyword','llm','host','crowd')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, tag_id)
);
-- (tag_id, event_id) is the search direction: "every event carrying this tag".
CREATE INDEX IF NOT EXISTS idx_event_tags_tag ON event_tags(tag_id, event_id);

-- ── vector staleness (mirrors tagged_hash) ──────────────────────────────────
ALTER TABLE events ADD COLUMN embedded_hash TEXT;

-- ── full text ───────────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  event_id UNINDEXED,
  title,
  body,
  tokenize='porter unicode61'
);

-- Keep the index honest from SQL, not from application discipline: any writer —
-- ingest, renormalize, the enrich job, a manual UPDATE — leaves events_fts correct.
CREATE TRIGGER IF NOT EXISTS trg_events_fts_ai AFTER INSERT ON events BEGIN
  DELETE FROM events_fts WHERE event_id = new.id;
  INSERT INTO events_fts (event_id, title, body) VALUES (new.id, new.title, trim(
      coalesce(new.description, '') || ' ' ||
      coalesce(new.organizer, '')   || ' ' ||
      coalesce(new.venue_name, '')  || ' ' ||
      coalesce((SELECT group_concat(tv.label, ' ')
                  FROM event_tags et JOIN tag_vocab tv ON tv.id = et.tag_id
                 WHERE et.event_id = new.id), '')
    ));
END;

-- Only the indexed columns retrigger a rebuild; a geocode or a starred flag doesn't.
CREATE TRIGGER IF NOT EXISTS trg_events_fts_au
AFTER UPDATE OF title, description, organizer, venue_name ON events BEGIN
  DELETE FROM events_fts WHERE event_id = new.id;
  INSERT INTO events_fts (event_id, title, body) VALUES (new.id, new.title, trim(
      coalesce(new.description, '') || ' ' ||
      coalesce(new.organizer, '')   || ' ' ||
      coalesce(new.venue_name, '')  || ' ' ||
      coalesce((SELECT group_concat(tv.label, ' ')
                  FROM event_tags et JOIN tag_vocab tv ON tv.id = et.tag_id
                 WHERE et.event_id = new.id), '')
    ));
END;

CREATE TRIGGER IF NOT EXISTS trg_events_fts_ad AFTER DELETE ON events BEGIN
  DELETE FROM events_fts WHERE event_id = old.id;
END;

-- Tag labels are part of the body, so changing an event's tags re-indexes it.
CREATE TRIGGER IF NOT EXISTS trg_event_tags_fts_ai AFTER INSERT ON event_tags BEGIN
  DELETE FROM events_fts WHERE event_id = new.event_id;
  INSERT INTO events_fts (event_id, title, body)
    SELECT e.id, e.title, trim(
      coalesce(e.description, '') || ' ' ||
      coalesce(e.organizer, '')   || ' ' ||
      coalesce(e.venue_name, '')  || ' ' ||
      coalesce((SELECT group_concat(tv.label, ' ')
                  FROM event_tags et JOIN tag_vocab tv ON tv.id = et.tag_id
                 WHERE et.event_id = e.id), '')
    ) FROM events e WHERE e.id = new.event_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_event_tags_fts_ad AFTER DELETE ON event_tags BEGIN
  DELETE FROM events_fts WHERE event_id = old.event_id;
  INSERT INTO events_fts (event_id, title, body)
    SELECT e.id, e.title, trim(
      coalesce(e.description, '') || ' ' ||
      coalesce(e.organizer, '')   || ' ' ||
      coalesce(e.venue_name, '')  || ' ' ||
      coalesce((SELECT group_concat(tv.label, ' ')
                  FROM event_tags et JOIN tag_vocab tv ON tv.id = et.tag_id
                 WHERE et.event_id = e.id), '')
    ) FROM events e WHERE e.id = old.event_id;
END;

-- Backfill whatever is already stored (no-op on a fresh database).
INSERT INTO events_fts (event_id, title, body)
  SELECT e.id, e.title, trim(
      coalesce(e.description, '') || ' ' ||
      coalesce(e.organizer, '')   || ' ' ||
      coalesce(e.venue_name, '')  || ' ' ||
      coalesce((SELECT group_concat(tv.label, ' ')
                  FROM event_tags et JOIN tag_vocab tv ON tv.id = et.tag_id
                 WHERE et.event_id = e.id), '')
    )
    FROM events e
   WHERE NOT EXISTS (SELECT 1 FROM events_fts f WHERE f.event_id = e.id);

-- ── seed the vocabulary ─────────────────────────────────────────────────────
-- topic:* mirrors config/categories.json (same ids, labels, colors and keyword
-- lists) so the legacy events.categories values map 1:1 onto 'topic:' + value.
-- The other facets are new: they are what "free hardware meetups in SoMa next
-- week" actually asks about. INSERT OR IGNORE ⇒ re-running is safe, and an
-- operator's later edits to a row are never stomped.
INSERT OR IGNORE INTO tag_vocab (id, facet, label, keywords_json, emoji, color, status, created_at) VALUES
  ('topic:hardware', 'topic', 'Hardware', '["hardware","pcb","robotics","robot","fpga","semiconductor","chip","chips","silicon","asic","embedded","iot","sensor","sensors","drone","drones","electronics","soldering","maker","makerspace","3d printing","cnc","manufacturing","prototyping","wearable","wearables","battery","photonics","quantum hardware","device","devices","circuit","circuits","arduino","raspberry pi","microcontroller","mems"]', NULL, '#e07a5f', 'active', '2026-07-26T00:00:00.000Z'),
  ('topic:vc', 'topic', 'VC / Early-stage', '["vc","venture capital","venture","investor","investors","angel","angels","seed","pre-seed","preseed","series a","demo day","pitch","pitching","founders","founder","fundraising","fundraise","raising","startup","startups","accelerator","incubator","yc","y combinator","term sheet","cap table","office hours","lp","limited partner","deal flow","portfolio"]', NULL, '#3d5a80', 'active', '2026-07-26T00:00:00.000Z'),
  ('topic:math', 'topic', 'Mathematics', '["math","mathematics","mathematical","topology","category theory","number theory","proof","proofs","theorem","combinatorics","algebra","geometry","calculus","analysis","probability","statistics","statistical","optimization","graph theory","cryptography","logic","set theory","differential","linear algebra","abstract algebra"]', NULL, '#81b29a', 'active', '2026-07-26T00:00:00.000Z'),
  ('topic:software', 'topic', 'Software', '["software","api","apis","kubernetes","k8s","docker","rust","golang","typescript","javascript","python","react","node","backend","frontend","full stack","fullstack","devops","ci/cd","database","postgres","distributed","microservices","web dev","webdev","cloud","serverless","ai","ml","machine learning","llm","llms","gpt","deep learning","data science","developer","developers","coding","hackathon","open source","programming","compiler","security","cybersecurity","blockchain","web3","crypto"]', NULL, '#f2cc8f', 'active', '2026-07-26T00:00:00.000Z'),
  ('topic:tech', 'topic', 'Tech (general)', '[]', NULL, '#8d99ae', 'active', '2026-07-26T00:00:00.000Z'),
  ('format:talk', 'format', 'Talk', '["talk","talks","lecture","keynote","fireside","fireside chat","seminar","speaker series"]', '🎤', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('format:panel', 'format', 'Panel', '["panel","panels","panel discussion","roundtable","round table"]', '🗣️', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('format:hackathon', 'format', 'Hackathon', '["hackathon","hackathons","hack night","hack day","buildathon","build night","code jam"]', '💻', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('format:demo-day', 'format', 'Demo Day', '["demo day","demo days","demoday","pitch day","pitch night","showcase"]', '🚀', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('format:mixer', 'format', 'Mixer', '["mixer","mixers","happy hour","meet and greet","networking night","cocktails","mingle"]', '🍸', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('format:workshop', 'format', 'Workshop', '["workshop","workshops","hands-on","bootcamp","tutorial","masterclass","lab session"]', '🛠️', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('format:office-hours', 'format', 'Office Hours', '["office hours","office-hour","ama","ask me anything","open house","drop-in"]', '🕐', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('format:dinner', 'format', 'Dinner', '["dinner","dinners","supper club","brunch","lunch","breakfast","banquet"]', '🍽️', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('format:conference', 'format', 'Conference', '["conference","conferences","summit","symposium","expo","unconference"]', '🎪', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('format:meetup', 'format', 'Meetup', '["meetup","meetups","meet-up","meet up","user group"]', '👥', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('audience:founders', 'audience', 'Founders', '["founder","founders","cofounder","co-founder","entrepreneur","entrepreneurs","ceo","solo founder"]', '🧑‍🚀', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('audience:engineers', 'audience', 'Engineers', '["engineer","engineers","developer","developers","devs","hackers","technical","swe"]', '👷', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('audience:investors', 'audience', 'Investors', '["investor","investors","vc","vcs","lp","lps","angel","angels","limited partner","family office"]', '💰', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('audience:designers', 'audience', 'Designers', '["designer","designers","ux","ui","product design","industrial design","figma"]', '🎨', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('audience:students', 'audience', 'Students', '["student","students","university","college","campus","undergrad","phd","grad students"]', '🎓', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('audience:recruiters', 'audience', 'Recruiters', '["recruiter","recruiters","hiring","talent","job fair","career fair","we''re hiring"]', '🧲', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('stage:pre-idea', 'stage', 'Pre-idea', '["pre-idea","idea stage","ideation","aspiring founder","aspiring founders","side project"]', '💡', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('stage:pre-seed', 'stage', 'Pre-seed', '["pre-seed","preseed","pre seed","friends and family round"]', '🌱', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('stage:seed', 'stage', 'Seed', '["seed stage","seed round","seed funding","seed-stage"]', '🌿', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('stage:series-a-plus', 'stage', 'Series A+', '["series a","series b","series c","growth stage","late stage","scale-up"]', '🌳', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('cost:free', 'cost', 'Free', '["free","no cost","free entry","complimentary","free to attend"]', '🆓', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('cost:under-25', 'cost', 'Under $25', '["$5","$10","$15","$20","$25","low cost","cheap"]', '🎟️', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('cost:paid', 'cost', 'Paid', '["ticketed","paid","tickets","admission","registration fee"]', '💳', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('cost:application-only', 'cost', 'Application only', '["application only","apply to attend","invite only","invite-only","approval required","curated guest list","rsvp approval"]', '📝', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('perk:open-bar', 'perk', 'Open bar', '["open bar","free drinks","drinks provided","beer and wine","cocktails provided"]', '🍻', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('perk:food', 'perk', 'Food', '["free food","food provided","dinner provided","catered","pizza","snacks","refreshments","lunch provided"]', '🍕', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('perk:swag', 'perk', 'Swag', '["swag","t-shirt","tshirt","giveaway","raffle","prizes","goodie bag"]', '🎁', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('perk:demos', 'perk', 'Demos', '["demos","live demo","show and tell","demo tables","science fair"]', '🖥️', NULL, 'active', '2026-07-26T00:00:00.000Z'),
  ('perk:recorded', 'perk', 'Recorded', '["recorded","livestream","live stream","streamed","recording available","on youtube"]', '📹', NULL, 'active', '2026-07-26T00:00:00.000Z');
