-- The Bay — event vibes (Track B).
--
-- "You don't know the caliber or the vibe of a room before you go." This models an
-- event the way a dispensary describes a strain: six numeric 0–100 axes, evocative
-- prose, and a "best for" — a PREDICTED prior from the listing, then progressively
-- overwritten by check-in-verified attendee reports (see src/core/vibe.ts).
--
-- Invariants live here, not in handlers:
--   · every axis is CHECKed into 0–100 in BOTH tables, so a bad slider is
--     unrepresentable no matter which path wrote it (route, admin enrich, backfill);
--   · `source` is a CHECKed enum — the honesty contract with the UI. A card that
--     says 'predicted' must never be rendered as if attendees had reported it;
--   · PRIMARY KEY (event_id, user_id) on the reports = one report per person per
--     room, so a second submit is an UPSERT rather than ballot-stuffing;
--   · confidence is CHECKed into 0–1 and n_reports non-negative — nothing downstream
--     has to defend against a nonsense denominator.
-- Axes are NULLable (an unrated axis is genuinely unknown); the CHECKs still bind
-- every non-NULL value.

CREATE TABLE IF NOT EXISTS event_vibes (
  event_id        TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  energy          INTEGER CHECK (energy          BETWEEN 0 AND 100),
  formality       INTEGER CHECK (formality       BETWEEN 0 AND 100),
  intimacy        INTEGER CHECK (intimacy        BETWEEN 0 AND 100),
  talk_ratio      INTEGER CHECK (talk_ratio      BETWEEN 0 AND 100),  -- 0 = pure mingling, 100 = pure talks
  signal          INTEGER CHECK (signal          BETWEEN 0 AND 100),  -- 0 = recruiters/tourists, 100 = real builders
  approachability INTEGER CHECK (approachability BETWEEN 0 AND 100),
  headline        TEXT,
  blurb           TEXT,
  best_for_json   TEXT NOT NULL DEFAULT '[]',
  expect_json     TEXT NOT NULL DEFAULT '[]',
  crowd_json      TEXT NOT NULL DEFAULT '{}',
  -- The IMMUTABLE prior (axes + crowd + best_for + expect + archetype) exactly as
  -- predicted from the listing. The columns above hold the BLENDED result, so
  -- without this a re-blend would fold its own output back in and drift toward
  -- whoever reported last. Keeping the prior makes recompute idempotent.
  predicted_json  TEXT NOT NULL DEFAULT '{}',
  source          TEXT NOT NULL CHECK (source IN ('predicted','blended','reported')),
  confidence      REAL NOT NULL DEFAULT 0.3 CHECK (confidence >= 0 AND confidence <= 1),
  -- VERIFIED reports only — the number the UI is allowed to show as "N attendees".
  n_reports       INTEGER NOT NULL DEFAULT 0 CHECK (n_reports >= 0),
  model           TEXT,
  updated_at      TEXT NOT NULL
);
-- Range filters (Track A's search consumes these as facets).
CREATE INDEX IF NOT EXISTS idx_event_vibes_signal ON event_vibes(signal);
CREATE INDEX IF NOT EXISTS idx_event_vibes_source ON event_vibes(source, n_reports);

CREATE TABLE IF NOT EXISTS vibe_reports (
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  energy          INTEGER CHECK (energy          BETWEEN 0 AND 100),
  formality       INTEGER CHECK (formality       BETWEEN 0 AND 100),
  intimacy        INTEGER CHECK (intimacy        BETWEEN 0 AND 100),
  talk_ratio      INTEGER CHECK (talk_ratio      BETWEEN 0 AND 100),
  signal          INTEGER CHECK (signal          BETWEEN 0 AND 100),
  approachability INTEGER CHECK (approachability BETWEEN 0 AND 100),
  crowd_json      TEXT NOT NULL DEFAULT '{}',
  tags_json       TEXT NOT NULL DEFAULT '[]',
  worth_it        INTEGER CHECK (worth_it BETWEEN 1 AND 5),
  -- Server-set from `checkins` (0002). Only verified reports move the blend, so
  -- this is never accepted from the client.
  verified        INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  created_at      TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)     -- one report per person; dupes unrepresentable
);
CREATE INDEX IF NOT EXISTS idx_vibe_reports_user ON vibe_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_vibe_reports_verified ON vibe_reports(event_id, verified);
