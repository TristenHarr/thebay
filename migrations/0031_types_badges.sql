-- FOUNDER TYPES and HOST-MINTED BADGES — the Pokémon layer.
--
-- Types are what you are; badges are what a gym leader gave you. Both are identity, and
-- neither is money: see the two headers below for why that separation is load-bearing rather
-- than stylistic.
--
-- ## Where the type chart came from
--
-- Not invented. `tag_vocab` already carries an `audience:` facet — founders, investors,
-- engineers, designers, recruiters, students — and every event archetype in `src/core/vibe.ts`
-- already predicts a `crowd` mix over that same vocabulary plus `operators`. So the types are
-- the union of the two, with `investors` split into `vc` and `angel` because that is the first
-- thing anybody actually wants to know about an investor. The seeds below and
-- `src/core/types/chart.ts` are reconciled by tests/founder-types.test.ts.

-- ── the type chart ────────────────────────────────────────────────────────────
-- `place_kinds`' structure, deliberately: a type is a slug, a label, an emoji and a colour, so
-- a tenth type is a ROW and not a redeploy of the card renderer. `emoji` and `color` are NOT
-- NULL for the reason place_kinds gives about icons — a type with no colour has no card.
--
-- `status`/`proposed_by`/`votes` exist so crowd ratification is a later ROUTE rather than a
-- later MIGRATION. Voting is NOT shipped: nine types is a design decision, not a crowd
-- decision, and the seeds are 'active' from birth. The columns are here because getting the
-- taxonomy wrong later should be cheap.
CREATE TABLE IF NOT EXISTS founder_types (
  id          TEXT PRIMARY KEY,                  -- 'founder' | 'vc' | 'angel' | …
  label       TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  color       TEXT NOT NULL,
  blurb       TEXT,
  -- Which crowd bucket this type counts as, for the affinity chart. Mirrors the keys the
  -- vibe archetypes use, so "is this room mine?" is answered from real catalog data.
  crowd_key   TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','retired')),
  proposed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  votes       INTEGER NOT NULL DEFAULT 0 CHECK (votes >= 0),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_founder_types_status ON founder_types(status, sort);

INSERT OR IGNORE INTO founder_types (id,label,emoji,color,blurb,crowd_key,sort,status,created_at) VALUES
  ('founder',   'Founder',    '🚀','#f97316','Building the thing.',              'founders',  1,'active','2026-07-26T00:00:00Z'),
  ('engineer',  'Engineer',   '⚙️','#3b82f6','Ships the thing.',                 'engineers', 2,'active','2026-07-26T00:00:00Z'),
  ('vc',        'VC',         '💰','#22c55e','Deploys other people''s money.',   'investors', 3,'active','2026-07-26T00:00:00Z'),
  ('angel',     'Angel',      '😇','#eab308','Writes their own cheques.',        'investors', 4,'active','2026-07-26T00:00:00Z'),
  ('operator',  'Operator',   '🛠️','#a855f7','Makes the machine run.',           'operators', 5,'active','2026-07-26T00:00:00Z'),
  ('designer',  'Designer',   '🎨','#ec4899','Decides how it feels.',            'designers', 6,'active','2026-07-26T00:00:00Z'),
  ('researcher','Researcher', '🔬','#06b6d4','Works on what isn''t known yet.',  'students',  7,'active','2026-07-26T00:00:00Z'),
  ('student',   'Student',    '🎓','#14b8a6','Here to learn and meet people.',   'students',  8,'active','2026-07-26T00:00:00Z'),
  ('recruiter', 'Recruiter',  '🧲','#8b8b9a','Hiring.',                          'recruiters',9,'active','2026-07-26T00:00:00Z');

-- ── what you are ──────────────────────────────────────────────────────────────
-- One primary type and one optional secondary — Pokémon's rule, and the limit at which a card
-- stays readable. Deliberately NOT a free tag table: `match_prefs.interests_json` already
-- holds open-ended tags and does that job well. A type is a CLOSED vocabulary with foreign-key
-- integrity and vouching, which is a different set of invariants.
--
-- SELF-DECLARED, never derived. Inferring identity from `founderStats` would mean deriving
-- "is a VC" from a word-boundary regex over a free-text interests field — confidently wrong,
-- and unfixable by the person it describes.
CREATE TABLE IF NOT EXISTS founder_identity (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  type_id     TEXT NOT NULL REFERENCES founder_types(id),
  type2_id    TEXT REFERENCES founder_types(id),
  declared_at TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (type2_id IS NULL OR type2_id <> type_id)
);

-- ── "yes, they really are an investor" ────────────────────────────────────────
-- One vouch per voucher per person, and you cannot vouch for yourself — `network_invites`'
-- self-vouch CHECK restated, for the same reason: a gate you can walk through alone is
-- decorative.
--
-- A vouch is A TICK ON A CARD AND NOTHING ELSE. It grants no XP, no gym budget, no access, no
-- ranking. The moment a type pays, everybody becomes whichever type pays, and the single most
-- damaging lie available here is "I'm an investor" — a claim no profile field can check.
-- tests/founder-types.test.ts greps the economy to prove it stays that way.
CREATE TABLE IF NOT EXISTS founder_type_vouches (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voucher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type_id    TEXT NOT NULL REFERENCES founder_types(id),
  -- Where you met. SET NULL so a merged or deleted event never erases the vouch itself.
  event_id   TEXT REFERENCES events(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, voucher_id),
  CHECK (voucher_id <> user_id)
);
CREATE INDEX IF NOT EXISTS idx_vouch_user ON founder_type_vouches(user_id, type_id);

-- ── the gym leader's ceremony ─────────────────────────────────────────────────
-- A host mints badges for their own event and hands them out: "Best Demo", "Stayed Till The
-- End", "Brought Three Friends".
--
-- **There is deliberately NO `xp` column.** If a badge paid, the gym budget from
-- migrations/0028 would be bypassable through badges and the entire anti-inflation bound
-- would be decorative. A badge is provenance and cosmetics; a BOUNTY is money; a bounty may
-- ATTACH a badge (`gym_awards.badge_id`) and that is the only join between them.
--
-- `emoji` and `color` NOT NULL, again: the card is the product.
CREATE TABLE IF NOT EXISTS gym_badges (
  id         TEXT PRIMARY KEY,                   -- ULID; contains no ':' — see the trigger
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  host_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  slug       TEXT NOT NULL,
  label      TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  color      TEXT NOT NULL,
  blurb      TEXT,
  -- Set by a human via moderation. A hidden badge stops rendering but is never deleted: the
  -- grant is a true record of something a host actually did.
  hidden_at  TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_gym_badges_event ON gym_badges(event_id);

-- ── the namespace, enforced ───────────────────────────────────────────────────
-- `achievements.kind` is free text with no catalog table, and the canonical trophies are bare
-- slugs ('first_review', 'local_legend', 'connector'). So the rule is simply: a canonical kind
-- contains NO COLON, and 'gym:' is the only reserved namespace. A host badge grant is
-- 'gym:<ULID>', and a ULID contains no colon and is globally unique — so a host badge can
-- never equal, prefix-match or shadow a canonical trophy, and the trophy engine cannot
-- accidentally squat the namespace either.
--
-- tests/trophy-catalog.test.ts asserts the other half: that no trophy id ever contains ':'.
CREATE TRIGGER IF NOT EXISTS achievement_namespace BEFORE INSERT ON achievements
  WHEN NEW.kind LIKE '%:%' AND NEW.kind NOT LIKE 'gym:%'
  BEGIN SELECT RAISE(ABORT, 'namespaced achievement kinds are reserved: use gym:<badgeId>'); END;
