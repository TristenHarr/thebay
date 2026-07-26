-- Track E — outcomes and attribution: which intros, events and communities
-- actually led somewhere.
--
-- THE EVIDENCE LADDER IS THE WHOLE POINT. An attribution is a claim about cause,
-- and claims about cause are the easiest thing in a product like this to get
-- wrong in public. So every row carries the tier of evidence behind it and the
-- renderer never conflates them:
--
--   sec           the round itself is on the public record   "$4.2M · Form D"
--   counterparty  both sides confirmed the causal link       "confirmed by both"
--   self          one party claims it                        "claimed by @ann"
--   platform      the edge provably predates the outcome     "met here 5 months before"
--                 — CO-OCCURRENCE, NEVER CAUSATION.
--
-- Three of those distinctions are enforced here rather than in a handler:
--   * a 'platform' row is machine-derived, so nobody may be recorded as having
--     claimed it (that is what would turn a correlation into an allegation);
--   * a 'self' row must carry the moment it was claimed;
--   * a 'counterparty' row must carry the moment it was corroborated, by someone
--     other than the claimant.
--
-- The timestamps — not the user FKs — carry those invariants, deliberately:
-- `claimed_by` / `confirmed_by` are ON DELETE SET NULL, so a CHECK written
-- against them would turn "delete my account" into a foreign-key failure. The
-- record that a claim was made outlives the account that made it.

CREATE TABLE IF NOT EXISTS outcomes (
  id         TEXT PRIMARY KEY,                   -- ULID
  kind       TEXT NOT NULL CHECK (kind IN ('funding','hire','cofounder','customer','job')),
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  round_id   TEXT REFERENCES funding_rounds(id) ON DELETE SET NULL,
  occurred_at TEXT,
  -- Public by default, with a per-user opt-out below. The deliberate product
  -- decision: outcomes are what make the graph legible, and a leaderboard nobody
  -- appears on is not a leaderboard.
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('private','network','public')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outcomes_user     ON outcomes(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_outcomes_company  ON outcomes(company_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_occurred ON outcomes(occurred_at DESC);

CREATE TABLE IF NOT EXISTS attributions (
  id           TEXT PRIMARY KEY,                 -- ULID
  outcome_id   TEXT NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
  cause_type   TEXT NOT NULL CHECK (cause_type IN ('intro','event','group','community','mentor')),
  -- Polymorphic by design (an intro_forward, an event, a group, a community, a
  -- mentor_request), so no FK is possible here. The repo resolves it per type.
  cause_id     TEXT NOT NULL,
  weight       REAL NOT NULL DEFAULT 1.0,
  evidence     TEXT NOT NULL CHECK (evidence IN ('self','counterparty','platform','sec')),
  claimed_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  claimed_at   TEXT,
  confirmed_at TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (outcome_id, cause_type, cause_id),
  CHECK (weight >= 0 AND weight <= 1),
  -- A machine-derived correlation is nobody's claim.
  CHECK (evidence <> 'platform' OR (claimed_by IS NULL AND claimed_at IS NULL AND confirmed_at IS NULL)),
  CHECK (evidence <> 'self' OR claimed_at IS NOT NULL),
  -- "Confirmed by both" means two distinct people actually said so.
  CHECK (evidence <> 'counterparty' OR (claimed_at IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (confirmed_by IS NULL OR claimed_by IS NULL OR confirmed_by <> claimed_by)
);
CREATE INDEX IF NOT EXISTS idx_attributions_outcome ON attributions(outcome_id);
-- The index E5 exists for: per-event / per-community outcome density, which
-- Track A's ranking reads through AttributionRepo.
CREATE INDEX IF NOT EXISTS idx_attributions_cause   ON attributions(cause_type, cause_id);

-- Public by default, with an explicit opt-out. Set it and you vanish from every
-- leaderboard and every public outcome list, while your own private view is
-- unchanged.
ALTER TABLE users ADD COLUMN attribution_opt_out INTEGER NOT NULL DEFAULT 0;
