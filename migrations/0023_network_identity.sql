-- The scrape network's front door: who is allowed to do work for the catalog.
--
-- The catalog is currently produced by ONE machine on ONE residential IP. Opening
-- that up means accepting data from people we can't audit line-by-line, and the
-- only defence that actually scales is making accounts expensive to obtain. So
-- membership is not a signup — it is a HANDSHAKE. You meet a member, their phone
-- plays a short rolling animation, your phone watches it for about a second and a
-- half, and the redemption creates a real `friendships` edge. There is no other way
-- in, and no still image of that animation is worth anything.
--
-- That single decision does most of the anti-Sybil work in the whole system:
-- consensus can only be gamed by someone controlling two independent observers,
-- and here each one costs a physical meeting with somebody who already has
-- standing to lose. Consensus (0023) is the SECOND layer, not the first.
--
-- Three properties are enforced here rather than in a handler:
--   · no secret is stored at all — the animated handshake's frame codes are
--     recomputed from an env key, so a database read (or a leaked backup) cannot
--     mint a membership;
--   · you cannot vouch for yourself (CHECK);
--   · single-use is a property of the redeeming UPDATE (`WHERE redeemed_at IS
--     NULL`, then assert one row changed), not of a SELECT that two concurrent
--     scans could both pass. tests/net-invite.test.ts fires both at once.

-- ── the handshake session ─────────────────────────────────────────────────────
-- Not a code — a short animated film. The ambassador's screen plays a new frame
-- every `step_ms`, and the joiner has to capture `frames_required` CONSECUTIVE
-- frames while they're still recent (src/core/net/handshake.ts). A screenshot is one
-- frame of four; a recorded video has steps in the past. Getting in costs about a
-- second and a half of actually pointing a camera at their phone, which is the human
-- act the whole network is built on.
--
-- NOTHING SECRET IS STORED HERE. Frame codes are recomputed on demand from
-- HMAC(HANDSHAKE_KEY, id | step), so a database read — or a leaked backup — yields
-- no way to mint a membership. `start_step`/`end_step` are the verification bounds,
-- stored rather than re-derived so the display and the verifier cannot drift apart.
--
-- `lat`/`lng` record where the ambassador physically stood; the join route requires
-- the joiner within INVITE_RADIUS_M of it, which is what stops a leaked frame list
-- from being redeemable from another city.
CREATE TABLE IF NOT EXISTS network_invites (
  id             TEXT PRIMARY KEY,                -- ULID; public, travels in every frame
  ambassador_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat            REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng            REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
  step_ms        INTEGER NOT NULL CHECK (step_ms > 0),
  frames_required INTEGER NOT NULL CHECK (frames_required >= 2),
  start_step     INTEGER NOT NULL,
  end_step       INTEGER NOT NULL,
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT,                            -- set when the display starts a new session
  redeemed_at    TEXT,
  redeemed_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  CHECK (end_step >= start_step + frames_required),
  -- Vouching for yourself would make the whole gate decorative.
  CHECK (redeemed_by IS NULL OR redeemed_by <> ambassador_id),
  -- Redemption is atomic: both columns move together or neither does.
  CHECK ((redeemed_at IS NULL) = (redeemed_by IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_invites_amb ON network_invites(ambassador_id, redeemed_at);

-- ── the member ────────────────────────────────────────────────────────────────
-- Tier is the evidence ladder for scrape work (cf. `attributions.evidence`):
-- 'probation' data needs corroboration before it publishes, 'trusted' publishes
-- solo and may vouch, 'core' additionally gets the lowest observer requirement.
-- Promotion is computed from the counters below by src/core/net/trust.ts — never
-- granted by hand, so nobody can be talked into a tier.
--
-- `distinct_days` is deliberately separate from `confirms`: trust should cost
-- calendar time, not just volume, or a single scripted afternoon buys 'trusted'.
CREATE TABLE IF NOT EXISTS network_members (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tier           TEXT NOT NULL DEFAULT 'probation' CHECK (tier IN ('probation','trusted','core')),
  -- ON DELETE SET NULL: deleting your account must not fail on someone else's row,
  -- and must not delete their membership either.
  vouched_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- Founded by config (`ADMIN_HANDLES`) rather than by a handshake — the operator.
  --
  -- This is a FLOOR on their tier, and it has to be, for a reason that is not obvious until it
  -- bites: tier is recomputed from a member's own observations, a founder has none of their own,
  -- and vouching requires `trusted`. So without this the operator is demoted to `probation` the
  -- instant their first invitee submits anything, and the network can never admit a third
  -- person. Privilege stored in config cannot be escalated by an application bug; it should not
  -- be revoked by one either.
  --
  -- Note what it does NOT exempt them from: quarantine still applies, because that is about
  -- holding unresolved data rather than about standing, and the operator is the right person to
  -- notice their own machine misbehaving.
  founding       INTEGER NOT NULL DEFAULT 0,
  invite_id      TEXT REFERENCES network_invites(id) ON DELETE SET NULL,
  confirms       INTEGER NOT NULL DEFAULT 0 CHECK (confirms >= 0),
  contradictions INTEGER NOT NULL DEFAULT 0 CHECK (contradictions >= 0),
  distinct_days  INTEGER NOT NULL DEFAULT 0 CHECK (distinct_days >= 0),
  -- The last calendar day one of this member's sightings was confirmed, so
  -- `distinct_days` advances once per day rather than once per event.
  last_confirm_day TEXT,
  -- Contradictions charged to this member because someone they VOUCHED for produced
  -- one. An integer count, weighted by VOUCH_SHARE in src/core/net/trust.ts and capped
  -- there — stored whole so the column can stay a non-negative integer, and capped so
  -- vouching for a stranger stays something people are willing to do.
  vouch_debits   INTEGER NOT NULL DEFAULT 0 CHECK (vouch_debits >= 0),
  -- Derived from the counters above by src/core/net/trust.ts and rewritten whenever they
  -- move. Stored because it orders the lease queue and the contributor leaderboard, and
  -- recomputing a decaying score inside an ORDER BY is not something SQLite should do.
  trust          REAL NOT NULL DEFAULT 0,
  last_scored_at TEXT,
  -- Set when trust falls through the floor. Their pending observations are HELD:
  -- never published, never deleted. Un-quarantining is a human act, logged.
  quarantined_at TEXT,
  joined_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_tier ON network_members(tier, quarantined_at);
CREATE INDEX IF NOT EXISTS idx_members_vouch ON network_members(vouched_by);

-- ── the client ────────────────────────────────────────────────────────────────
-- A machine or a browser, not a person: one member may run a laptop, a Chrome
-- extension and a phone, and each is scored separately for independence.
--
-- The token is hashed at rest and scoped to /api/net/* only. This is the whole
-- point of the table: today a single shared INGEST_TOKEN grants `renormalize`,
-- `prune-out-of-region`, `enrich` and `run-autopilot`, so handing it to a
-- volunteer would hand them the catalog. A leaked worker token can submit
-- observations for review. It cannot reach one admin route.
--
-- `egress_ip_hash` is SALTED and hashed — we need to know whether two workers
-- share an egress (they are then not independent observers), and we never need
-- to know the address itself.
CREATE TABLE IF NOT EXISTS worker_clients (
  id                TEXT PRIMARY KEY,             -- ULID
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('cli','extension','web','app')),
  label             TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',   -- ['fetch','browser','dom']; 'residential' is DERIVED
  token_hash        TEXT NOT NULL UNIQUE,
  egress_ip_hash    TEXT,                         -- salted SHA-256. Never the raw IP.
  egress_asn        INTEGER,
  last_seen_at      TEXT,
  revoked_at        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_user  ON worker_clients(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_clients_token ON worker_clients(token_hash);
