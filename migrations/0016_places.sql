-- The crowd-sourced city map: parking, work spots, water, restrooms — and a
-- taxonomy the crowd itself proposes and ratifies.
--
-- The design bet: WE DO NOT KNOW what resources this city needs pinned. A fixed
-- enum of kinds would be wrong within a month, and every correction would be a
-- migration + a deploy. So `place_kinds` is DATA, proposed by users and ratified
-- by votes, and each kind carries `fields_json` — a tiny declarative form schema
-- ([{key,label,type:'bool'|'enum'|'int'|'text',options?}]). A newly ratified kind
-- therefore gets the right input form, the right detail sheet and the right map
-- icon with ZERO new code. `emoji` is the entire icon system.
--
-- Freshness is the other half. A confirmation is a statement about a moment, not
-- a fact forever: "there's parking on this block" is worthless six hours later,
-- while "this café has free wifi" holds for months. Hence `half_life_hours` PER
-- KIND, feeding the pure decay in src/core/places/trust.ts.

-- ── the taxonomy ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS place_kinds (
  id              TEXT PRIMARY KEY,               -- slug, e.g. 'parking'
  label           TEXT NOT NULL,
  emoji           TEXT NOT NULL,                  -- the map icon. Not optional: a
                                                  -- kind with no icon is unpinnable.
  color           TEXT,
  category        TEXT,                           -- loose grouping for the layer switcher
  -- Declarative form schema for this kind's attrs. See the module doc above.
  fields_json     TEXT NOT NULL DEFAULT '[]',
  -- How fast a confirmation of this kind rots. Parking: hours. Wifi: months.
  half_life_hours INTEGER NOT NULL DEFAULT 720 CHECK (half_life_hours > 0),
  status          TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','retired')),
  proposed_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  votes           INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_place_kinds_status ON place_kinds(status, votes DESC);

-- One ratification vote per person per kind — stacking is unrepresentable, so no
-- handler has to remember to check.
CREATE TABLE IF NOT EXISTS place_kind_votes (
  kind_id    TEXT NOT NULL REFERENCES place_kinds(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind_id, user_id)
);

-- ── the pins ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS places (
  id                TEXT PRIMARY KEY,             -- ULID
  -- No ON DELETE: a kind with live pins cannot be deleted (retire it instead).
  kind_id           TEXT NOT NULL REFERENCES place_kinds(id),
  name              TEXT,
  lat               REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng               REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
  geohash           TEXT NOT NULL,                -- src/core/geohash, precision 7 (~150m)
  attrs_json        TEXT NOT NULL DEFAULT '{}',   -- values for the kind's fields_json
  address           TEXT,
  origin            TEXT NOT NULL DEFAULT 'crowd' CHECK (origin IN ('crowd','import','event')),
  -- Stable id at the upstream source ('datasf:meter:596-00180'). UNIQUE, so a
  -- re-import is idempotent by construction rather than by careful code.
  external_ref      TEXT UNIQUE,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirms          INTEGER NOT NULL DEFAULT 0,
  disputes          INTEGER NOT NULL DEFAULT 0,
  last_confirmed_at TEXT,
  hidden            INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_places_geohash ON places(geohash);
CREATE INDEX IF NOT EXISTS idx_places_kind    ON places(kind_id, hidden);

-- Every human touch on a pin: 'confirm'/'dispute' move the trust counters,
-- 'update' proposes new attrs, 'tip' is the live signal (parking difficulty,
-- minutes-to-find). lat/lng record where the reporter stood — the proximity
-- gate is enforced in the route, and this is the audit trail for it.
CREATE TABLE IF NOT EXISTS place_reports (
  id         TEXT PRIMARY KEY,                    -- ULID
  place_id   TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verdict    TEXT NOT NULL CHECK (verdict IN ('confirm','dispute','update','tip')),
  attrs_json TEXT,
  body       TEXT,
  lat        REAL,
  lng        REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_place_reports_place ON place_reports(place_id, created_at DESC);

-- ── day-one kinds ─────────────────────────────────────────────────────────────
-- Seeded active so the map isn't empty and the DataSF import has somewhere to
-- land. Everything after this is the crowd's to propose. INSERT OR IGNORE keeps
-- the migration re-runnable and never clobbers a live edit.
INSERT OR IGNORE INTO place_kinds (id, label, emoji, color, category, fields_json, half_life_hours, status, created_at) VALUES
  ('parking', 'Parking', '🅿️', '#3b82f6', 'car', json('[
      {"key":"type","label":"Type","type":"enum","options":["street","garage","lot"]},
      {"key":"meterHours","label":"Meter hours","type":"text"},
      {"key":"rppZone","label":"Permit zone (RPP)","type":"text"},
      {"key":"sweepDay","label":"Street sweeping day","type":"enum","options":["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]},
      {"key":"sweepWindow","label":"Sweeping window","type":"text"},
      {"key":"priceHint","label":"Price","type":"text"},
      {"key":"evCharging","label":"EV charging","type":"bool"},
      {"key":"maxHeight","label":"Max height (ft)","type":"int"}
    ]'), 6, 'active', '2026-07-26T00:00:00.000Z'),
  ('wifi', 'Free wifi', '📶', '#10b981', 'work', json('[
      {"key":"network","label":"Network name","type":"text"},
      {"key":"password","label":"Password needed","type":"bool"},
      {"key":"purchase","label":"Purchase required","type":"bool"},
      {"key":"speed","label":"Speed (Mbps)","type":"int"}
    ]'), 2160, 'active', '2026-07-26T00:00:00.000Z'),
  ('work_spot', 'Work spot', '💻', '#8b5cf6', 'work', json('[
      {"key":"outlets","label":"Outlets","type":"enum","options":["none","few","plenty"]},
      {"key":"noise","label":"Noise","type":"enum","options":["silent","low","buzzy","loud"]},
      {"key":"seating","label":"Seats","type":"int"},
      {"key":"laptopsOk","label":"Laptops welcome","type":"bool"},
      {"key":"hours","label":"Hours","type":"text"}
    ]'), 720, 'active', '2026-07-26T00:00:00.000Z'),
  ('restroom', 'Public restroom', '🚻', '#f59e0b', 'basics', json('[
      {"key":"access","label":"Access","type":"enum","options":["public","customers","code"]},
      {"key":"changingTable","label":"Changing table","type":"bool"},
      {"key":"accessible","label":"Wheelchair accessible","type":"bool"},
      {"key":"hours","label":"Hours","type":"text"}
    ]'), 720, 'active', '2026-07-26T00:00:00.000Z'),
  ('water', 'Drinking water', '🚰', '#06b6d4', 'basics', json('[
      {"key":"bottleFiller","label":"Bottle filler","type":"bool"},
      {"key":"working","label":"Currently working","type":"bool"}
    ]'), 720, 'active', '2026-07-26T00:00:00.000Z');
