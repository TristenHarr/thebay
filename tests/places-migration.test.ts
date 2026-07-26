import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 0016 creates the crowd taxonomy; 0017 widens `flags.target_type` to include
 * 'place'. SQLite cannot ALTER a CHECK, so 0017 is a TABLE REBUILD — the same
 * shape that silently deleted every comment and vote on thebay.news when 0009
 * did it naively (see tests/news-migration.test.ts). `flags` has no children,
 * but it holds every abuse report on the site, so "did the rows survive?" gets
 * a test either way.
 */

const MIGRATIONS = resolve(process.cwd(), "migrations");
const files = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

/** A DB with every migration applied up to (not including) `stopPrefix`. */
function dbUpTo(stopPrefix: string) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const f of files()) {
    if (f.startsWith(stopPrefix)) break;
    db.exec(readFileSync(resolve(MIGRATIONS, f), "utf8"));
  }
  return db;
}
const apply = (db: Database.Database, prefix: string) =>
  db.exec(readFileSync(resolve(MIGRATIONS, files().find((f) => f.startsWith(prefix))!), "utf8"));

function seedUser(db: Database.Database, id = "u1", email = "a@x.com", handle = "ann") {
  db.prepare(
    "INSERT INTO users (id,email,handle,display_name,social_enabled,created_at,updated_at) VALUES (?,?,?,?,1,'2026-01-01','2026-01-01')",
  ).run(id, email, handle, "Ann");
}

function seedFlags(db: Database.Database) {
  seedUser(db);
  seedUser(db, "u2", "b@x.com", "bob");
  db.prepare(
    "INSERT INTO stories (id,kind,title,url,url_hash,slug,author_id,origin,created_at) VALUES ('s1','link','T','https://e.com/1','h1','t','u1','bay','2026-07-01')",
  ).run();
  db.prepare("INSERT INTO comments (id,story_id,author_id,body,depth,created_at) VALUES ('c1','s1','u1','hi',0,'2026-07-01')").run();
  db.prepare("INSERT INTO flags (target_type,target_id,user_id,reason,created_at) VALUES ('story','s1','u1','spam','2026-07-02')").run();
  db.prepare("INSERT INTO flags (target_type,target_id,user_id,reason,created_at) VALUES ('story','s1','u2','abuse','2026-07-03')").run();
  db.prepare("INSERT INTO flags (target_type,target_id,user_id,reason,created_at) VALUES ('comment','c1','u2','off_topic','2026-07-04')").run();
}
const allFlags = (db: Database.Database) =>
  db.prepare("SELECT target_type,target_id,user_id,reason,created_at FROM flags ORDER BY created_at").all();

describe("0016 — the crowd taxonomy", () => {
  const db = () => {
    const d = dbUpTo("0017");
    seedUser(d);
    return d;
  };

  it("seeds day-one kinds, active, each with an emoji and a half-life", () => {
    const d = db();
    const rows = d.prepare("SELECT id, emoji, status, half_life_hours FROM place_kinds").all() as any[];
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) {
      expect(r.emoji).toBeTruthy();
      expect(r.status).toBe("active");
      expect(r.half_life_hours).toBeGreaterThan(0);
    }
    const parking = rows.find((r) => r.id === "parking");
    expect(parking).toBeTruthy();
    // Parking legality rots in hours; the generic default is a month.
    expect(parking.half_life_hours).toBeLessThan(48);
    d.close();
  });

  it("gives every seeded kind a valid declarative form schema (fields_json)", () => {
    const d = db();
    const rows = d.prepare("SELECT id, fields_json FROM place_kinds").all() as any[];
    for (const r of rows) {
      const fields = JSON.parse(r.fields_json);
      expect(Array.isArray(fields)).toBe(true);
      for (const f of fields) {
        expect(typeof f.key).toBe("string");
        expect(typeof f.label).toBe("string");
        expect(["bool", "enum", "int", "text"]).toContain(f.type);
        if (f.type === "enum") expect(Array.isArray(f.options)).toBe(true);
      }
    }
    expect(JSON.parse((rows.find((r) => r.id === "parking") as any).fields_json).map((f: any) => f.key)).toContain("sweepDay");
    d.close();
  });

  it("makes a duplicate kind vote unrepresentable (PK), and a kind vote needs a real kind", () => {
    const d = db();
    d.prepare("INSERT INTO place_kind_votes (kind_id,user_id,created_at) VALUES ('parking','u1','2026-07-01')").run();
    expect(() =>
      d.prepare("INSERT INTO place_kind_votes (kind_id,user_id,created_at) VALUES ('parking','u1','2026-07-02')").run(),
    ).toThrow(/UNIQUE|PRIMARY/i);
    expect(() =>
      d.prepare("INSERT INTO place_kind_votes (kind_id,user_id,created_at) VALUES ('nope','u1','2026-07-02')").run(),
    ).toThrow(/FOREIGN KEY/i);
    d.close();
  });

  it("rejects an unknown status / origin / verdict at the schema level", () => {
    const d = db();
    expect(() =>
      d.prepare("INSERT INTO place_kinds (id,label,emoji,status,created_at) VALUES ('x','X','❓','maybe','2026-07-01')").run(),
    ).toThrow(/CHECK/i);
    d.prepare(
      "INSERT INTO places (id,kind_id,name,lat,lng,geohash,origin,created_at) VALUES ('p1','parking','Spot',37.77,-122.41,'9q8yy','crowd','2026-07-01')",
    ).run();
    expect(() =>
      d.prepare(
        "INSERT INTO places (id,kind_id,lat,lng,geohash,origin,created_at) VALUES ('p2','parking',37.77,-122.41,'9q8yy','vibes','2026-07-01')",
      ).run(),
    ).toThrow(/CHECK/i);
    expect(() =>
      d.prepare(
        "INSERT INTO place_reports (id,place_id,user_id,verdict,created_at) VALUES ('r1','p1','u1','shrug','2026-07-01')",
      ).run(),
    ).toThrow(/CHECK/i);
    d.close();
  });

  it("makes re-import idempotent by construction — external_ref is UNIQUE", () => {
    const d = db();
    const ins = (id: string) =>
      d.prepare(
        "INSERT INTO places (id,kind_id,lat,lng,geohash,origin,external_ref,created_at) VALUES (?,'parking',37.77,-122.41,'9q8yy','import','datasf:meter:1','2026-07-01')",
      ).run(id);
    ins("p1");
    expect(() => ins("p2")).toThrow(/UNIQUE/i);
    d.close();
  });

  it("cascades reports away with their place, but keeps a place when its author leaves", () => {
    const d = db();
    d.prepare(
      "INSERT INTO places (id,kind_id,lat,lng,geohash,origin,created_by,created_at) VALUES ('p1','parking',37.77,-122.41,'9q8yy','crowd','u1','2026-07-01')",
    ).run();
    d.prepare("INSERT INTO place_reports (id,place_id,user_id,verdict,created_at) VALUES ('r1','p1','u1','confirm','2026-07-01')").run();
    d.prepare("DELETE FROM users WHERE id='u1'").run();
    expect((d.prepare("SELECT created_by FROM places WHERE id='p1'").get() as any).created_by).toBeNull();
    expect((d.prepare("SELECT COUNT(*) n FROM place_reports").get() as any).n).toBe(0); // user CASCADE
    d.prepare(
      "INSERT INTO places (id,kind_id,lat,lng,geohash,origin,created_at) VALUES ('p2','parking',37.7,-122.4,'9q8yy','crowd','2026-07-01')",
    ).run();
    seedUser(d, "u3", "c@x.com", "cara");
    d.prepare("INSERT INTO place_reports (id,place_id,user_id,verdict,created_at) VALUES ('r2','p2','u3','confirm','2026-07-01')").run();
    d.prepare("DELETE FROM places WHERE id='p2'").run();
    expect((d.prepare("SELECT COUNT(*) n FROM place_reports").get() as any).n).toBe(0); // place CASCADE
    d.close();
  });

  it("refuses to delete a kind that still has places (no orphan pins)", () => {
    const d = db();
    d.prepare(
      "INSERT INTO places (id,kind_id,lat,lng,geohash,origin,created_at) VALUES ('p1','parking',37.77,-122.41,'9q8yy','crowd','2026-07-01')",
    ).run();
    expect(() => d.prepare("DELETE FROM place_kinds WHERE id='parking'").run()).toThrow(/FOREIGN KEY/i);
    d.close();
  });
});

describe("0017 — widening flags.target_type to include 'place'", () => {
  it("preserves EVERY existing flag row across the table rebuild", () => {
    const d = dbUpTo("0017");
    seedFlags(d);
    const before = allFlags(d);
    expect(before.length).toBe(3);
    apply(d, "0017");
    expect(allFlags(d)).toEqual(before);
    d.close();
  });

  it("keeps the one-flag-per-person-per-item primary key after the rebuild", () => {
    const d = dbUpTo("0017");
    seedFlags(d);
    apply(d, "0017");
    expect(() =>
      d.prepare("INSERT INTO flags (target_type,target_id,user_id,reason,created_at) VALUES ('story','s1','u1','spam','2026-07-09')").run(),
    ).toThrow(/UNIQUE|PRIMARY/i);
    // INSERT OR IGNORE (what the repo uses) must still be a silent no-op.
    d.prepare("INSERT OR IGNORE INTO flags (target_type,target_id,user_id,reason,created_at) VALUES ('story','s1','u1','spam','2026-07-09')").run();
    expect(allFlags(d).length).toBe(3);
    d.close();
  });

  it("rejects a 'place' flag BEFORE the migration and accepts it after", () => {
    const d = dbUpTo("0017");
    seedFlags(d);
    d.prepare(
      "INSERT INTO places (id,kind_id,lat,lng,geohash,origin,created_at) VALUES ('p1','parking',37.77,-122.41,'9q8yy','crowd','2026-07-01')",
    ).run();
    const flagPlace = () =>
      d.prepare("INSERT INTO flags (target_type,target_id,user_id,reason,created_at) VALUES ('place','p1','u1','spam','2026-07-05')").run();
    expect(flagPlace).toThrow(/CHECK/i);
    apply(d, "0017");
    expect(flagPlace).not.toThrow();
    expect(allFlags(d).length).toBe(4);
    d.close();
  });

  it("still rejects a target type nobody defined", () => {
    const d = dbUpTo("0017");
    seedFlags(d);
    apply(d, "0017");
    expect(() =>
      d.prepare("INSERT INTO flags (target_type,target_id,user_id,reason,created_at) VALUES ('spaceship','x','u1','spam','2026-07-05')").run(),
    ).toThrow(/CHECK/i);
    d.close();
  });

  it("leaves no scaffolding behind and keeps the target index", () => {
    const d = dbUpTo("0017");
    seedFlags(d);
    apply(d, "0017");
    const temp = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '_mig17%'").all();
    expect(temp).toEqual([]);
    const idx = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_flags_target'").all();
    expect(idx.length).toBe(1);
    d.close();
  });
});
