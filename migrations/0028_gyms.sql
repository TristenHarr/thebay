-- GYMS — hosts as gym leaders, and the hardened attendance record that host-awarded
-- XP is minted against.
--
-- ## The load-bearing idea
--
-- A gym leader is a MINT. Every mint needs a monetary base it cannot fabricate, and here
-- that base is VERIFIED PHYSICAL PRESENCE, priced by how long you stayed. So the abuse
-- bound is not a rule a handler enforces — it is this foreign key:
--
--     FOREIGN KEY (user_id, event_id) REFERENCES event_presence(user_id, event_id)
--
-- A host CANNOT award XP to somebody who did not physically scan the door, inside the
-- Bay, inside the event's own time window, within DOOR_RADIUS_M of where the host stood.
-- Not "will not" — cannot. Two colluding hosts padding each other must first physically
-- meet, every single time.
--
-- ## Why a NEW attendance table instead of hardening `checkins`
--
-- `checkins` is load-bearing for four shipped features: the review-gate
-- (`review_obligations` → `canRsvp`), `points.checkin`, the attend streak, and
-- `VibeRepo`'s verification gate. `checkin_tokens` stores `ulid()+ulid()` in PLAINTEXT
-- and, until 0027's companion change, the client put that token in a URL QUERY PARAM and
-- auto-submitted it on mount — so forwarding the link checked someone in from another
-- state. Tightening that table in place would change the meaning of every historical row
-- and force a backfill decision with no right answer.
--
-- So the two jobs are split the way this repo already split points from XP:
--   · `checkins`       — the SOCIAL record. "I was here." Untouched by this migration.
--   · `event_presence` — the ECONOMIC record. "Provably here, this long."
-- Claiming presence also writes the `checkins` row through the existing path, so an
-- attendee who scans the hardened door still gets their 20 points, their streak and their
-- review obligation. The new door supersedes the old one behaviourally without
-- deprecating anything.
--
-- ## What is enforced HERE rather than in a handler
--
-- Overspend, award-without-presence, award-to-self, double-award-for-one-feat,
-- award-into-an-unarmed-gym, the absolute per-award ceiling, budget-shrink-below-spend,
-- terms-frozen-once-armed, settled-is-immutable, and the door's use ceiling. All of them
-- are properties of a row or a pair of rows, so they belong in the schema, and
-- tests/gym-schema.test.ts proves each one by driving RAW SQL around the repo entirely.
--
-- What is NOT here, deliberately: the BUDGET FORMULA. It is an aggregate over
-- `event_presence`, `reviews` and a rolling window over `gym_awards`, and it needs "now".
-- A trigger computing it would bury the economic policy in DDL where it cannot be unit
-- tested and cannot be retuned without a migration. `src/core/gym/budget.ts` owns it.
-- The division: SQL owns what a row may promise; core owns what the economy allows.

-- ── the hardened door ─────────────────────────────────────────────────────────
-- `network_invites`' substance (0023), generalised from one scan to a QUEUE. A handshake
-- code is shown to one person, so single-use is right there; a door code is shown to a
-- line of people, so single-use would mean re-minting per scan. Hence `max_uses`/`uses`
-- with a CHECK, and a claiming UPDATE that asserts one row changed — the same guarantee,
-- counted. See src/core/gym/presence.ts.
CREATE TABLE IF NOT EXISTS door_codes (
  id          TEXT PRIMARY KEY,                 -- ULID; public, rides in the QR
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  host_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 only. The plaintext is returned once and dropped, so a database read — or a
  -- leaked backup — cannot manufacture attendance. cf. worker_clients.token_hash.
  secret_hash TEXT NOT NULL UNIQUE,
  -- Where the host physically stood. NOT NULL: a code with no origin cannot be geofenced,
  -- and `events.latitude` is not a substitute — /api/host never collects coordinates and
  -- a large share of scraped venues are ungeocoded.
  lat         REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng         REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,                             -- set when the door screen rotates
  max_uses    INTEGER NOT NULL DEFAULT 20 CHECK (max_uses >= 1),
  uses        INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  created_at  TEXT NOT NULL,
  CHECK (uses <= max_uses)
);
CREATE INDEX IF NOT EXISTS idx_door_event ON door_codes(event_id, revoked_at);

-- ── the economic attendance record ────────────────────────────────────────────
-- `first_at` and `last_at` are what make the user's "caps based on time attended" real.
-- `first_at` is the entry scan; `last_at` advances on any later geofenced scan (the host's
-- screen is rotating anyway). Dwell = last − first, and src/core/gym/dwell.ts caps the
-- credit at the event's own scheduled length so a phone left open overnight cannot farm it.
--
-- lat/lng are the SCANNER's fix, NOT NULL, recorded so a later audit can ask where the
-- room actually was.
CREATE TABLE IF NOT EXISTS event_presence (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- Provenance. SET NULL so garbage-collecting spent codes never destroys the proof they
  -- created.
  code_id  TEXT REFERENCES door_codes(id) ON DELETE SET NULL,
  lat      REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng      REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
  first_at TEXT NOT NULL,
  last_at  TEXT NOT NULL,
  scans    INTEGER NOT NULL DEFAULT 1 CHECK (scans >= 1),
  PRIMARY KEY (user_id, event_id),              -- once per person per event
  -- Time cannot run backwards for one attendee. Without this a clock-skewed client could
  -- write last_at < first_at and dwellMinutes would have to defend itself in two places.
  CHECK (last_at >= first_at)
);
CREATE INDEX IF NOT EXISTS idx_presence_event ON event_presence(event_id);

-- ── the gym ───────────────────────────────────────────────────────────────────
-- Three columns do all the anti-inflation work:
--
--   · `budget` — what verified attendance bought. Recomputed by GymRepo.syncBudget from
--     src/core/gym/budget.ts. NEVER client-set.
--   · `spent`  — maintained by TRIGGER from gym_awards, not by application discipline,
--     exactly as events_fts is (0014). Any future writer — a migration, an admin script,
--     a repo nobody has written yet — leaves it correct.
--   · CHECK (spent <= budget) — the invariant. Because `spent` moves inside the trigger,
--     an over-budget INSERT INTO gym_awards ABORTS on this CHECK and leaves `spent`
--     untouched. Overspend is not a rule a handler enforces; it is a row the database
--     refuses.
--
-- `status` is the lock. Terms freeze the moment a gym is armed (trigger below), because a
-- gym whose rules can change after the event is a discretionary mint with a promise
-- attached: advertise "flat 50 to everyone", pay your friends 300, and the advertised rule
-- was a lie. Freezing is what makes the promise mean something.
CREATE TABLE IF NOT EXISTS event_gyms (
  event_id         TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  -- Denormalised from events.host_user_id, which is ON DELETE SET NULL: if the host
  -- deletes their account, the provenance of what they minted must survive.
  host_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  mode             TEXT NOT NULL DEFAULT 'none'
                   CHECK (mode IN ('none','flat','discretion','bounty')),
  flat_xp          INTEGER NOT NULL DEFAULT 0 CHECK (flat_xp >= 0 AND flat_xp <= 1000),
  -- Declarative bounty spec: [{key,label,xp,badgeSlug?,limit?}]. Parsed by
  -- src/core/gym/policy.ts, which is TOTAL — malformed entries are dropped and prices
  -- clamped, never thrown on. The discipline of core/places/fields.ts, not its shape.
  bounties_json    TEXT NOT NULL DEFAULT '[]',
  budget           INTEGER NOT NULL DEFAULT 0 CHECK (budget >= 0),
  spent            INTEGER NOT NULL DEFAULT 0 CHECK (spent >= 0),
  -- Snapshotted at arm time so it cannot be raised mid-event. The ABSOLUTE ceiling lives
  -- on gym_awards.xp; this is the tighter, tunable one.
  recipient_cap    INTEGER NOT NULL DEFAULT 500 CHECK (recipient_cap > 0),
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','armed','settled')),
  armed_at         TEXT,
  settled_at       TEXT,
  budget_synced_at TEXT,
  created_at       TEXT NOT NULL,
  CHECK (spent <= budget),
  -- The status and its timestamps move together or not at all.
  CHECK ((status = 'draft') = (armed_at IS NULL)),
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  -- A mode must be able to pay what it advertises.
  CHECK (mode <> 'flat'   OR flat_xp > 0),
  CHECK (mode <> 'bounty' OR bounties_json <> '[]')
);
CREATE INDEX IF NOT EXISTS idx_gyms_host ON event_gyms(host_id, status);

-- ── the awards ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gym_awards (
  id         TEXT PRIMARY KEY,                   -- ULID; also the xp_ledger dedup_key
  event_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  host_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- '' = the base award (flat or discretionary). A non-empty key is a named feat from
  -- bounties_json. NOT NULL DEFAULT '' rather than nullable, because SQLite treats NULLs
  -- as DISTINCT in a UNIQUE and two NULL base awards would slip straight past it.
  bounty_key TEXT NOT NULL DEFAULT '',
  -- The absolute ceiling, in the schema, deliberately looser than policy's recipient_cap:
  -- policy is tunable in TypeScript, this is the backstop no future bug can raise without
  -- a migration.
  xp         INTEGER NOT NULL CHECK (xp > 0 AND xp <= 1000),
  badge_id   TEXT,                               -- reserved for 0029's host-minted badges
  note       TEXT,
  awarded_at TEXT NOT NULL,
  UNIQUE (event_id, user_id, bounty_key),        -- one base award + one per feat
  -- Vouching for yourself would make the whole gate decorative. cf. network_invites.
  CHECK (host_id IS NULL OR host_id <> user_id),
  -- THE ABUSE BOUND. event_presence's PK is (user_id, event_id), so this composite
  -- reference is legal, and it is what makes "award XP to someone who was not verifiably
  -- present" unrepresentable rather than merely forbidden.
  --
  -- ON UPDATE CASCADE so `renormalize`'s dedup merge, which repoints event_id on the
  -- parent, carries the awards with it instead of failing on a dangling reference.
  -- ON DELETE CASCADE rather than RESTRICT for one specific reason: RESTRICT deadlocks
  -- against the merge's `DELETE FROM events`, which cascades to event_presence. The
  -- "revoke before deleting a fraudulent presence row" rule therefore lives in
  -- GymRepo.revokeAward — and it is SAFE to keep it there because the minted XP itself is
  -- in `xp_ledger`, which has NO foreign key to events and is never touched by a merge.
  -- gym_awards is the audit trail; xp_ledger is the money.
  FOREIGN KEY (user_id, event_id) REFERENCES event_presence(user_id, event_id)
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gym_awards_user  ON gym_awards(user_id, awarded_at);
CREATE INDEX IF NOT EXISTS idx_gym_awards_pair  ON gym_awards(host_id, user_id);  -- the halving lookup
CREATE INDEX IF NOT EXISTS idx_gym_awards_event ON gym_awards(event_id);

-- ── invariants that span rows, and therefore need triggers ────────────────────
-- `spent` is derived state kept correct by the database, the events_fts lesson applied to
-- money. Insert, delete and reprice all move it.
CREATE TRIGGER IF NOT EXISTS gym_award_spend AFTER INSERT ON gym_awards BEGIN
  UPDATE event_gyms SET spent = spent + NEW.xp WHERE event_id = NEW.event_id;
END;
CREATE TRIGGER IF NOT EXISTS gym_award_refund AFTER DELETE ON gym_awards BEGIN
  UPDATE event_gyms SET spent = spent - OLD.xp WHERE event_id = OLD.event_id;
END;
CREATE TRIGGER IF NOT EXISTS gym_award_reprice AFTER UPDATE OF xp ON gym_awards BEGIN
  UPDATE event_gyms SET spent = spent - OLD.xp + NEW.xp WHERE event_id = NEW.event_id;
END;

-- Awards only into an ARMED gym. This trigger is also what requires the gym row to EXIST
-- at all: a missing row makes the subquery NULL, and NULL <> 'armed' aborts. That is why
-- gym_awards needs no separate FK to event_gyms — which in turn keeps the merge cascade
-- simple.
CREATE TRIGGER IF NOT EXISTS gym_award_armed_only BEFORE INSERT ON gym_awards
  WHEN COALESCE((SELECT status FROM event_gyms WHERE event_id = NEW.event_id), '') <> 'armed'
  BEGIN SELECT RAISE(ABORT, 'gym is not armed'); END;

-- A settled gym is immutable: its ledger is closed and its attendees have already been
-- shown what they got.
CREATE TRIGGER IF NOT EXISTS gym_award_settled_frozen BEFORE UPDATE ON gym_awards
  WHEN (SELECT status FROM event_gyms WHERE event_id = OLD.event_id) = 'settled'
  BEGIN SELECT RAISE(ABORT, 'this gym is settled'); END;
CREATE TRIGGER IF NOT EXISTS gym_award_settled_nodelete BEFORE DELETE ON gym_awards
  WHEN (SELECT status FROM event_gyms WHERE event_id = OLD.event_id) = 'settled'
  BEGIN SELECT RAISE(ABORT, 'this gym is settled'); END;

-- Terms freeze once armed. See the event_gyms header for why this is the difference
-- between a published promise and a bait-and-switch.
CREATE TRIGGER IF NOT EXISTS gym_terms_frozen
  BEFORE UPDATE OF mode, flat_xp, bounties_json, recipient_cap ON event_gyms
  WHEN OLD.status <> 'draft'
  BEGIN SELECT RAISE(ABORT, 'gym terms are frozen once the gym is armed'); END;

-- ── claiming a scraped event ───────────────────────────────────────────────────
-- Most of the catalog is scraped and has no host, so it has no gym — that default is
-- correct by construction, because opening a gym requires requireHost() and requireHost()
-- is false whenever host_user_id IS NULL. A real organiser finding their own event here
-- should be able to take it over; what must be impossible is taking over an event you
-- didn't run.
--
-- The retro-claim attack — "claim 200 past events, open gyms, mint XP for my friends" —
-- dies for free, and this is the best single argument for the presence FK above: awards
-- require `event_presence` rows, those only exist from a live geofenced scan inside the
-- event's window, and a past event has none. Budget 0. No trigger, no special case in the
-- reviewer, no policy sentence anyone has to remember. Do not "relax" that FK to
-- `checkins` without re-reading this paragraph.
CREATE TABLE IF NOT EXISTS event_claims (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  evidence    TEXT NOT NULL,                     -- what makes them the organiser
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (event_id, user_id),
  CHECK ((status = 'pending') = (reviewed_at IS NULL))
);
-- Exactly one approved claim per event. A partial unique index, so "two owners" is
-- unrepresentable rather than something every reviewer has to remember.
CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_owner ON event_claims(event_id) WHERE status = 'approved';
