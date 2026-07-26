/**
 * Migration 0009 rebuilds `stories` and `story_sources` to widen the origin
 * CHECK. Rebuilding a table that children reference with ON DELETE CASCADE is
 * genuinely dangerous: the obvious version of this migration silently deleted
 * every comment and vote on the site, and nothing about the SQL looked wrong.
 *
 * These tests are the reason that was caught, so they stay.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

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

function seed(db: Database.Database) {
  db.prepare(
    "INSERT INTO users (id,email,handle,display_name,social_enabled,created_at,updated_at) VALUES ('u1','a@x.com','ann','Ann',1,'2026-01-01','2026-01-01')",
  ).run();
  const origins = ["bay", "hn", "lobsters", "rss", "event"];
  for (let i = 0; i < 25; i++) {
    db.prepare(
      "INSERT INTO stories (id,kind,title,url,url_hash,slug,author_id,origin,vote_count,comment_count,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(`s${i}`, "link", `Story ${i}`, `https://ex.com/${i}`, `h${i}`, `story-${i}`, "u1", origins[i % 5], i, i * 2, "2026-07-01");
    db.prepare("INSERT INTO story_sources (story_id,origin,external_id,external_points,fetched_at) VALUES (?,?,?,?,?)")
      .run(`s${i}`, origins[i % 5], `e${i}`, i * 10, "2026-07-01");
    db.prepare("INSERT INTO story_votes (story_id,user_id,created_at) VALUES (?,?,?)").run(`s${i}`, "u1", "2026-07-01");
  }
  db.prepare("INSERT INTO comments (id,story_id,author_id,body,depth,created_at) VALUES ('c1','s1','u1','top',0,'2026-07-01')").run();
  db.prepare("INSERT INTO comments (id,story_id,parent_id,author_id,body,depth,created_at) VALUES ('c2','s1','c1','u1','reply',1,'2026-07-01')").run();
  db.prepare("INSERT INTO comment_votes (comment_id,user_id,created_at) VALUES ('c1','u1','2026-07-01')").run();
}

const counts = (db: Database.Database) => ({
  stories: (db.prepare("SELECT COUNT(*) n FROM stories").get() as any).n,
  sources: (db.prepare("SELECT COUNT(*) n FROM story_sources").get() as any).n,
  votes: (db.prepare("SELECT COUNT(*) n FROM story_votes").get() as any).n,
  comments: (db.prepare("SELECT COUNT(*) n FROM comments").get() as any).n,
  commentVotes: (db.prepare("SELECT COUNT(*) n FROM comment_votes").get() as any).n,
  points: (db.prepare("SELECT SUM(vote_count) s FROM stories").get() as any).s,
});

const apply9 = (db: Database.Database) =>
  db.exec(readFileSync(resolve(MIGRATIONS, files().find((f) => f.startsWith("0009"))!), "utf8"));

/** Migrations that rebuild `stories` — the dangerous shape. Detected, not listed,
 *  so a future one is covered the moment it lands. */
const rebuildMigrations = () =>
  files().filter((f) => /DROP TABLE stories/i.test(readFileSync(resolve(MIGRATIONS, f), "utf8")));

describe("0009 — widening the origin CHECK", () => {
  it("preserves EVERY row, including comments and votes", () => {
    // The naive rebuild loses these to ON DELETE CASCADE when `stories` is dropped.
    const db = dbUpTo("0009");
    seed(db);
    const before = counts(db);
    apply9(db);
    expect(counts(db)).toEqual(before);
    db.close();
  });

  it("keeps comment threading intact across the rebuild", () => {
    const db = dbUpTo("0009");
    seed(db);
    apply9(db);
    expect((db.prepare("SELECT parent_id FROM comments WHERE id='c2'").get() as any).parent_id).toBe("c1");
    db.close();
  });

  it("accepts the new origins and still rejects unknown ones", () => {
    const db = dbUpTo("0009");
    seed(db);
    apply9(db);
    for (const o of ["github", "sec"]) {
      db.prepare("INSERT INTO stories (id,kind,title,url,url_hash,slug,origin,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(`n_${o}`, "link", "New", `https://ex.com/${o}`, `nh${o}`, `n-${o}`, o, "2026-07-25");
    }
    expect((db.prepare("SELECT COUNT(*) n FROM stories WHERE origin IN ('github','sec')").get() as any).n).toBe(2);
    expect(() =>
      db.prepare("INSERT INTO stories (id,kind,title,url,url_hash,slug,origin,created_at) VALUES ('bad','link','x','https://x','bh','b','martian','2026-07-25')").run(),
    ).toThrow();
    db.close();
  });

  it("leaves cascades working afterwards", () => {
    const db = dbUpTo("0009");
    seed(db);
    apply9(db);
    db.prepare("DELETE FROM stories WHERE id='s1'").run();
    expect((db.prepare("SELECT COUNT(*) n FROM comments WHERE story_id='s1'").get() as any).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM story_sources WHERE story_id='s1'").get() as any).n).toBe(0);
    db.close();
  });

  it("cleans up its scratch tables", () => {
    const db = dbUpTo("0009");
    seed(db);
    apply9(db);
    expect((db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '_mig9%'").get() as any).n).toBe(0);
    db.close();
  });

  it("rebuilds the indexes it dropped", () => {
    const db = dbUpTo("0009");
    seed(db);
    apply9(db);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as any[]).map((r) => r.name);
    for (const want of ["idx_stories_url_hash", "idx_stories_created", "idx_story_sources_ext", "idx_comments_story"]) {
      expect(idx, `missing ${want}`).toContain(want);
    }
    db.close();
  });

  it("still enforces one-story-per-link after the rebuild", () => {
    const db = dbUpTo("0009");
    seed(db);
    apply9(db);
    expect(() =>
      db.prepare("INSERT INTO stories (id,kind,title,url,url_hash,slug,origin,created_at) VALUES ('dupe','link','x','https://ex.com/1','h1','d','bay','2026-07-25')").run(),
    ).toThrow(/UNIQUE/);
    db.close();
  });
});

describe("EVERY table-rebuild migration preserves data", () => {
  // 0009 and 0010 both drop and recreate `stories`, which cascades into
  // comments, votes and sources. This finds them by content rather than by
  // name, so the next one is covered automatically.
  for (const file of rebuildMigrations()) {
    it(`${file} keeps every row`, () => {
      const db = dbUpTo(file.slice(0, 4));
      seed(db);
      const before = counts(db);
      db.exec(readFileSync(resolve(MIGRATIONS, file), "utf8"));
      expect(counts(db), `${file} lost rows`).toEqual(before);
      expect((db.prepare("SELECT parent_id FROM comments WHERE id='c2'").get() as any).parent_id).toBe("c1");
      expect((db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '_mig%'").get() as any).n).toBe(0);
      db.close();
    });
  }

  it("finds more than one — the detection actually works", () => {
    expect(rebuildMigrations().length).toBeGreaterThanOrEqual(2);
  });
});
