-- The scrape network's work queue: recipes, hosts, jobs, leases, observations.
--
-- Distribution breaks the politeness model we had. `HOST_MIN_GAP_MS` in
-- src/sources/util/http.ts is an in-memory Map on one machine; fifty volunteers
-- each politely waiting 900ms between requests collectively hammer Eventbrite,
-- and no amount of client-side discipline fixes that because clients cannot see
-- each other. So politeness moves to where it can actually be enforced: the
-- coordinator simply REFUSES TO HAND OUT WORK faster than a host tolerates.
-- `scrape_hosts` is that budget, and a lease is permission to crawl.
--
-- The win from distribution is not "more requests per second" — it's the same
-- polite request rate arriving from a rotating set of residential IPs, which is
-- coverage one datacenter machine can never have.
--
-- Three structural decisions worth reading before you change anything here:
--
--  · A RECIPE IS DATA, NOT CODE. `type` must be one of the adapters already
--    registered in src/sources/registry.ts, and `params_json` is validated by that
--    adapter's own `parseParams`. So a contributor can add a source, fix a broken
--    field mapping, or improve a selector path without a deploy — and the worst a
--    malicious recipe can do is produce bad data, which consensus catches. Code
--    stays code. `kind` leaves room for sandboxed extractors later without
--    pretending we've solved that today.
--
--  · OBSERVATIONS ARE NOT EVENTS. A submission lands in `scrape_observations` and
--    stays there until it is corroborated (or came from someone who has earned the
--    right to publish alone). `events` only ever receives promoted rows, so the
--    public catalog cannot contain an unverified claim.
--
--  · INDEPENDENCE IS MEASURED, NOT ASSUMED. `scrape_leases` records the egress
--    ASN and a salted IP hash, because two accounts behind one NAT are one
--    observer wearing two hats, and treating their agreement as consensus is
--    exactly how a Sybil publishes whatever it likes.
--
-- Guarded by tests/net-politeness.test.ts and tests/net-consensus.test.ts.

-- ── recipes ───────────────────────────────────────────────────────────────────
-- Versioned, because promotion has to be reversible: a candidate that wins the
-- audit and then degrades in the wild is fixed by restoring the previous version,
-- not by an emergency deploy.
CREATE TABLE IF NOT EXISTS scrape_recipes (
  id            TEXT PRIMARY KEY,                 -- ULID
  source_id     TEXT NOT NULL,                    -- stable across versions ('luma-bay')
  version       INTEGER NOT NULL CHECK (version > 0),
  kind          TEXT NOT NULL DEFAULT 'declarative' CHECK (kind IN ('declarative')),
  type          TEXT NOT NULL,                    -- must satisfy hasAdapter(); checked in the route
  params_json   TEXT NOT NULL,                    -- validated by the adapter's own parseParams
  -- The host this recipe crawls, derived by src/core/scrape/host.ts. NOT NULL on
  -- purpose: we refuse to schedule work we cannot rate-limit.
  host          TEXT NOT NULL,
  requires_json TEXT NOT NULL DEFAULT '["fetch"]', -- client capabilities needed
  window_ms     INTEGER NOT NULL DEFAULT 21600000 CHECK (window_ms >= 60000), -- 6h
  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','shadow','active','retired')),
  author_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  promoted_at   TEXT,
  retired_at    TEXT,
  UNIQUE (source_id, version)
);
-- Exactly one live recipe per source. A partial unique index, so "two actives"
-- is unrepresentable rather than something every writer has to remember.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recipe_active ON scrape_recipes(source_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_recipe_status ON scrape_recipes(status, host);

-- ── host budgets (the politeness engine's state) ───────────────────────────────
-- One row per hostname we touch. `crawl_delay_ms` and `disallow_json` are refreshed
-- from robots.txt by cron; when a host asks for more space than our default, its
-- request wins (see effectiveGapMs in src/core/scrape/politeness.ts).
CREATE TABLE IF NOT EXISTS scrape_hosts (
  host              TEXT PRIMARY KEY,
  min_gap_ms        INTEGER NOT NULL DEFAULT 1000 CHECK (min_gap_ms >= 0),
  -- How many clients may crawl this host AT ONCE, fleet-wide. 1 means the crawl is
  -- serialised across every volunteer, which reproduces today's single-machine
  -- politeness while the requests come from many residential IPs.
  max_concurrent    INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrent >= 1),
  daily_cap         INTEGER CHECK (daily_cap IS NULL OR daily_cap > 0),
  granted_today     INTEGER NOT NULL DEFAULT 0 CHECK (granted_today >= 0),
  granted_day       TEXT,                          -- YYYY-MM-DD the counter belongs to
  crawl_delay_ms    INTEGER CHECK (crawl_delay_ms IS NULL OR crawl_delay_ms >= 0),
  disallow_json     TEXT NOT NULL DEFAULT '[]',
  -- The Allow patterns, kept beside the Disallow ones. Without them `Disallow: /` plus
  -- `Allow: /events/` — the most common shape in the wild — reads as a total ban.
  allow_json        TEXT NOT NULL DEFAULT '[]',
  robots_fetched_at TEXT,
  robots_status     INTEGER,                       -- last robots.txt HTTP status
  -- Set when a host tells us to back off (429/403). Nothing is leased for this host until it
  -- passes — the one signal we must never argue with.
  blocked_until     TEXT,
  -- Consecutive refusals, so the back-off can escalate (see backoffUntilMs). Reset by the
  -- first clean submission: one bad afternoon must not hold a source hostage forever.
  rebuffs           INTEGER NOT NULL DEFAULT 0 CHECK (rebuffs >= 0),
  last_granted_at   TEXT
);

-- ── jobs: one unit of "somebody go look at this source now" ────────────────────
-- Keyed by (recipe, window). Two workers given the same job are meant to agree;
-- comparing observations from DIFFERENT windows would just measure how fast the
-- site changes, which is why the window is part of the identity.
CREATE TABLE IF NOT EXISTS scrape_jobs (
  id               TEXT PRIMARY KEY,
  recipe_id        TEXT NOT NULL REFERENCES scrape_recipes(id) ON DELETE CASCADE,
  source_id        TEXT NOT NULL,
  host             TEXT NOT NULL,
  window_start     TEXT NOT NULL,
  window_ms        INTEGER NOT NULL,
  -- How many INDEPENDENT observers this job wants before its findings publish.
  -- Scales with risk: 1 for a core member on a settled recipe, 3 for a candidate
  -- recipe under audit.
  target_observers INTEGER NOT NULL DEFAULT 2 CHECK (target_observers >= 1),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','expired')),
  created_at       TEXT NOT NULL,
  UNIQUE (recipe_id, window_start)
);
CREATE INDEX IF NOT EXISTS idx_jobs_open ON scrape_jobs(status, host, window_start);

-- ── leases: permission to crawl, with an expiry ─────────────────────────────────
-- A lease is how we know a host is currently being crawled and by whom. It expires
-- so a laptop that closes its lid doesn't hold a source hostage.
CREATE TABLE IF NOT EXISTS scrape_leases (
  id             TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES scrape_jobs(id) ON DELETE CASCADE,
  client_id      TEXT NOT NULL REFERENCES worker_clients(id) ON DELETE CASCADE,
  member_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Independence, recorded at grant time. Salted hash: we need to know whether two
  -- workers share an egress, never what the address is.
  egress_ip_hash TEXT,
  egress_asn     INTEGER,
  granted_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  submitted_at   TEXT,
  released_at    TEXT,
  outcome        TEXT CHECK (outcome IS NULL OR outcome IN ('submitted','failed','expired','released')),
  error          TEXT,
  -- One lease per client per job: a client cannot corroborate itself by submitting
  -- the same job twice, and re-leasing is unrepresentable rather than policed.
  UNIQUE (job_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_leases_live   ON scrape_leases(expires_at, submitted_at, released_at);
CREATE INDEX IF NOT EXISTS idx_leases_member ON scrape_leases(member_id, granted_at);
CREATE INDEX IF NOT EXISTS idx_leases_job    ON scrape_leases(job_id);

-- ── observations: what a worker says it saw ────────────────────────────────────
-- `item_key` and `fingerprint` are SERVER-DERIVED from the submitted RawEvent, never
-- accepted from the client. That single choice removes the whole attack class where
-- a submitter picks the fingerprint and therefore picks which existing event their
-- data merges into: the server normalises with src/core/**, so every observer's key
-- for the same upstream item is identical by construction and nobody can lie about
-- a hash they didn't compute.
--
-- `payload_json` is the server's own normalised CanonicalEvent draft, kept so a
-- promotion is a copy rather than a re-derivation, and so a contradiction can be
-- inspected afterwards instead of argued about.
CREATE TABLE IF NOT EXISTS scrape_observations (
  id           TEXT PRIMARY KEY,
  lease_id     TEXT NOT NULL REFERENCES scrape_leases(id) ON DELETE CASCADE,
  job_id       TEXT NOT NULL REFERENCES scrape_jobs(id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_key     TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','confirmed','published','contradicted','quarantined')),
  -- ON DELETE SET NULL, not CASCADE: if a dedup merge removes the event this was
  -- promoted into, the observation is still a true record of what someone saw.
  event_id     TEXT REFERENCES events(id) ON DELETE SET NULL,
  resolved_at  TEXT,
  created_at   TEXT NOT NULL,
  -- One observation per item per lease. A worker listing the same event twice in
  -- one submission is a client bug, not two sightings.
  UNIQUE (lease_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_obs_job    ON scrape_observations(job_id, item_key);
CREATE INDEX IF NOT EXISTS idx_obs_status ON scrape_observations(status, created_at);
CREATE INDEX IF NOT EXISTS idx_obs_member ON scrape_observations(member_id, status);

-- ── receipts: weak evidence, real forensics ────────────────────────────────────
-- What the client says it fetched. Nobody's reputation moves on this — a fabricator
-- can invent a receipt — but a `Date` header, an ETag and a byte count are cheap to
-- report honestly and expensive to fake consistently, and when a contradiction needs
-- explaining these are the only trace of what actually happened.
CREATE TABLE IF NOT EXISTS scrape_receipts (
  id         TEXT PRIMARY KEY,
  lease_id   TEXT NOT NULL REFERENCES scrape_leases(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  status     INTEGER,
  bytes      INTEGER,
  server_date TEXT,
  etag       TEXT,
  elapsed_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_receipts_lease ON scrape_receipts(lease_id);
