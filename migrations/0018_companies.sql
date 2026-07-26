-- Track E — the funding graph: companies, the rounds they file, and the people
-- named on those filings.
--
-- Everything here is mined from public record (SEC Form D / Reg CF / S-1) plus
-- what members tell us about themselves. Two invariants are pushed into the
-- schema rather than trusted to handlers, because both are accuracy gates:
--
--   1. RE-INGEST IS IDEMPOTENT. `funding_rounds` is UNIQUE(source, external_id)
--      and the external id is the SEC accession number, so the same filing can be
--      harvested every 15 minutes forever and still be one row.
--
--   2. A NAME ON A FILING IS NOT AN ACCOUNT. `company_people.user_id` is nullable
--      and starts null. It may only be set by the person themselves — see the
--      CHECKs below. Publishing "@annlee raised $4.2M" off a fuzzy name match
--      would be publishing a possibly-false claim about a real person, so the
--      link between a Form D name and a @handle is unrepresentable until they
--      confirm it.

CREATE TABLE IF NOT EXISTS companies (
  id           TEXT PRIMARY KEY,                 -- ULID
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,             -- URL identity: /company/<slug>
  domain       TEXT,                             -- bare host, lowercased ('acme.com')
  -- SEC Central Index Key. UNIQUE so two harvests of the same filer converge on
  -- one company row instead of forking on a punctuation difference in the name.
  cik          TEXT UNIQUE,
  city         TEXT,
  state        TEXT,
  industry     TEXT,
  year_founded INTEGER,
  description  TEXT,
  source       TEXT NOT NULL CHECK (source IN ('sec','crowd','user','import')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_name    ON companies(name);
CREATE INDEX IF NOT EXISTS idx_companies_city    ON companies(city);
CREATE INDEX IF NOT EXISTS idx_companies_domain  ON companies(domain);

CREATE TABLE IF NOT EXISTS funding_rounds (
  id              TEXT PRIMARY KEY,              -- ULID
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- What kind of filing/report this is ('form-d', 'reg-cf', 's-1', 'announced').
  kind            TEXT NOT NULL,
  -- Named stage ('seed', 'series-a', …). DELIBERATELY NULL for SEC-derived rounds:
  -- a Form D states an amount, never a stage. Inferring "seed" from a dollar figure
  -- would be inventing a fact, so only 'news'/'crowd' sources may fill this in.
  stage           TEXT,
  amount_usd      INTEGER,                       -- total offering amount
  amount_sold_usd INTEGER,                       -- how much of it has actually sold
  filed_at        TEXT,
  first_sale_at   TEXT,
  source          TEXT NOT NULL CHECK (source IN ('sec','news','crowd')),
  source_url      TEXT,
  -- The SEC accession number for 'sec' rows. Paired with `source` below, this is
  -- what makes harvesting the same filing twice a no-op.
  external_id     TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (source, external_id),
  -- Money is stored in whole dollars and can never be negative.
  CHECK (amount_usd IS NULL OR amount_usd >= 0),
  CHECK (amount_sold_usd IS NULL OR amount_sold_usd >= 0)
);
CREATE INDEX IF NOT EXISTS idx_rounds_company ON funding_rounds(company_id, filed_at DESC);
CREATE INDEX IF NOT EXISTS idx_rounds_filed   ON funding_rounds(filed_at DESC);

-- People named on a filing (executives, directors, promoters), or self-declared.
--
-- `user_id` is the identity-resolution gate. It is NULL by default and stays NULL
-- for every deterministic or model-generated candidate match. The two CHECKs make
-- the product rule structural:
--   * a row may only carry a user_id if it came from that person ('self'), and
--   * a resolved row always carries the moment they confirmed it.
-- An unconfirmed Form D name is still public (it is public record) — it simply has
-- no @handle welded to it.
CREATE TABLE IF NOT EXISTS company_people (
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  person_name  TEXT NOT NULL,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,  -- NULLABLE: unresolved by default
  role         TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('sec','self','crowd')),
  confidence   REAL,                             -- candidate-match score, 0..1; never a link
  confirmed_at TEXT,
  started_at   TEXT,
  ended_at     TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (company_id, person_name, role),
  CHECK (user_id IS NULL OR source = 'self'),
  CHECK ((user_id IS NULL) = (confirmed_at IS NULL)),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);
CREATE INDEX IF NOT EXISTS idx_company_people_user ON company_people(user_id);
CREATE INDEX IF NOT EXISTS idx_company_people_name ON company_people(person_name);

-- Self-declared employment. `users` has no company/role/title column at all —
-- until now the only signal was a regex over `users.bio` (src/ai/research.ts) —
-- so this is the first place a member can simply say where they work. Distinct
-- from company_people: that table records what a FILING says; this records what
-- the MEMBER says.
CREATE TABLE IF NOT EXISTS user_companies (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  title        TEXT,
  is_current   INTEGER NOT NULL DEFAULT 1,
  -- 'self'   — typed into their profile
  -- 'import' — read out of imported_items.payload_json.$.company / $.position
  --            (the LinkedIn importer has been writing those since day one and
  --             nothing ever read them)
  source       TEXT NOT NULL CHECK (source IN ('self','import')),
  started_at   TEXT,
  ended_at     TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, company_id, role)
);
CREATE INDEX IF NOT EXISTS idx_user_companies_company ON user_companies(company_id);

-- Stories ↔ companies, so the news front page can render a filing as
-- "Acme Robotics — $4.2M · 2 founders in your network" instead of a bare headline.
CREATE TABLE IF NOT EXISTS story_companies (
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  round_id   TEXT REFERENCES funding_rounds(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (story_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_story_companies_company ON story_companies(company_id);
