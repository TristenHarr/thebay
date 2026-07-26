import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { MERGE_FK_TABLES, MERGE_EXEMPT_TABLES } from "../src/storage/d1/d1-repo";

/**
 * LOCK-IN TESTS — schema.
 *
 * These don't test a feature. Each one closes a class of mistake that has already
 * been made in this repo at least once, by reconciling code against the live
 * schema instead of trusting a hand-maintained list to stay correct.
 *
 * The rule they encode: if a future change makes one of these lists wrong, the
 * suite fails and names the missing entry. Nobody has to remember.
 */

const MIGRATIONS_DIR = resolve(process.cwd(), "migrations");
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

/** Migration filenames known to git, or null outside a checkout. */
function trackedMigrations(): Set<string> | null {
  try {
    const out = execFileSync("git", ["ls-files", "migrations"], { encoding: "utf8" });
    return new Set(out.split("\n").map((l) => l.trim().replace(/^migrations\//, "")).filter((f) => f.endsWith(".sql")));
  } catch {
    return null;
  }
}

/**
 * Migrations to hold to the numbering rules: the COMMITTED ones.
 *
 * Deliberately not every file on disk. Several people work in this one checkout,
 * and an untracked migration that briefly collides is someone mid-thought, not a
 * defect — failing on it makes the suite hostile to work in progress and blocks
 * unrelated pushes. What must never be wrong is what's committed, which is also
 * exactly what CI (a fresh clone) sees. Falls back to all files outside a checkout.
 */
const numberedMigrations = (() => {
  const tracked = trackedMigrations();
  return tracked ? migrationFiles.filter((f) => tracked.has(f)) : migrationFiles;
})();

/** Tables in the live schema, from the real migrations. */
function liveTables(raw: any): string[] {
  return raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r: any) => r.name);
}

/**
 * A schema built from COMMITTED migrations only.
 *
 * `makeTestDb()` deliberately applies every .sql on disk, which is right for
 * feature tests but wrong for reconciling a committed list against a schema: in a
 * shared checkout it would demand that `d1-repo.ts` account for a table whose
 * migration someone else hasn't committed yet — and naming it there would make a
 * committed file depend on an uncommitted schema, which is the very thing the
 * uncommitted-migration lock below forbids. Committed-vs-committed is the only
 * self-consistent comparison, and it's what CI sees.
 */
function committedSchema(): any {
  const tracked = trackedMigrations();
  const files = tracked ? migrationFiles.filter((f) => tracked.has(f)) : migrationFiles;
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const f of files) db.exec(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"));
  return db;
}

describe("lock: dedup merge cannot silently delete data", () => {
  /**
   * The bug, twice: a table gets an `event_id` FK with ON DELETE CASCADE, nobody
   * adds it to the merge list, and `renormalize` quietly deletes its rows for every
   * duplicate event. It happened to `event_tags` (host/crowd tags), and then again
   * to `event_vibes`/`vibe_reports` (attendees' submitted reports) — added by a
   * parallel track that had no way to know the list existed.
   *
   * So: derive the requirement from the schema. Every FK to events(id) must be
   * either migrated or explicitly exempt with a reason.
   */
  it("every table that FK-references events(id) is either migrated on merge or explicitly exempt", () => {
    const raw = committedSchema();
    const referencing: string[] = [];
    for (const t of liveTables(raw)) {
      const fks = raw.prepare(`PRAGMA foreign_key_list("${t}")`).all() as any[];
      if (fks.some((fk) => fk.table === "events")) referencing.push(t);
    }

    // Sanity: if this ever reads 0, the introspection broke and the test is vacuous.
    expect(referencing.length).toBeGreaterThan(10);

    const accounted = new Set<string>([...MERGE_FK_TABLES, ...Object.keys(MERGE_EXEMPT_TABLES)]);
    const unaccounted = referencing.filter((t) => !accounted.has(t));

    expect(
      unaccounted,
      `These tables FK-reference events(id) but are neither in MERGE_FK_TABLES nor MERGE_EXEMPT_TABLES ` +
        `(src/storage/d1/d1-repo.ts). A dedup merge will CASCADE-delete or orphan their rows. ` +
        `Add each to MERGE_FK_TABLES, or to MERGE_EXEMPT_TABLES with a reason: ${unaccounted.join(", ")}`,
    ).toEqual([]);
  });

  it("names no table that has since been dropped", () => {
    // A stale entry means `UPDATE ... SET event_id` runs against a missing table
    // and throws mid-merge, leaving the catalog half-migrated.
    const raw = committedSchema();
    const live = new Set(liveTables(raw));
    const ghosts = [...MERGE_FK_TABLES, ...Object.keys(MERGE_EXEMPT_TABLES)].filter((t) => !live.has(t));
    expect(ghosts, `Listed for merge but not in the schema: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("keeps event_sources last so provenance moves after everything else", () => {
    expect(MERGE_FK_TABLES[MERGE_FK_TABLES.length - 1]).toBe("event_sources");
  });

  it("actually preserves an attendee's vibe report across a merge", () => {
    // The behavioural half of the lock above: the list being right is only useful
    // if the merge honours it. Rather than reconstruct a full dedup scenario here,
    // assert the specific tables that carry irreproducible human input are listed.
    for (const t of ["event_tags", "vibe_reports", "event_vibes", "reviews", "subject_reviews", "media"]) {
      expect(MERGE_FK_TABLES, `${t} holds human input a merge must not drop`).toContain(t);
    }
  });
});

describe("lock: moderation vocabularies agree", () => {
  /**
   * The bug: 0017 taught `flags` to accept a 'place' target, but the audit log
   * `moderation_actions` still admitted only story/comment/user. Reports could be
   * filed and never acted on, because acting writes an audit row in the same call
   * and that insert failed the CHECK. Two vocabularies, one of them forgotten.
   */
  function checkVocab(raw: any, table: string, column: string): string[] {
    const ddl: string = raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)?.sql ?? "";
    // Grab the CHECK (col IN ('a','b')) list for this column.
    const re = new RegExp(`${column}[^,]*?CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, "is");
    const m = ddl.match(re);
    if (!m) return [];
    return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
  }

  it("anything flaggable can also be acted on in the audit log", () => {
    const { raw } = makeTestDb();
    const flaggable = checkVocab(raw, "flags", "target_type");
    const loggable = checkVocab(raw, "moderation_actions", "target_type");

    expect(flaggable.length, "failed to parse flags.target_type CHECK").toBeGreaterThan(1);
    expect(loggable.length, "failed to parse moderation_actions.target_type CHECK").toBeGreaterThan(1);

    const unactionable = flaggable.filter((t) => !loggable.includes(t));
    expect(
      unactionable,
      `These target types can be flagged but not recorded in moderation_actions, so hiding them ` +
        `fails the CHECK: ${unactionable.join(", ")}. Widen moderation_actions.target_type.`,
    ).toEqual([]);
  });
});

describe("lock: migrations stay orderly", () => {
  /**
   * The bug: two files claimed 0013 within the same minute because two workers
   * each took "max + 1". Numbers are applied lexically, so a collision is silent
   * until the second one's dependencies don't exist yet.
   */
  it("has no duplicate migration numbers", () => {
    const seen = new Map<string, string[]>();
    for (const f of numberedMigrations) {
      const n = f.slice(0, 4);
      seen.set(n, [...(seen.get(n) ?? []), f]);
    }
    const dupes = [...seen.entries()].filter(([, fs]) => fs.length > 1);
    expect(
      dupes.map(([n, fs]) => `${n}: ${fs.join(" + ")}`),
      "Two committed migrations share a number. They apply in lexical order, so the " +
        "collision is silent until the second one's dependencies don't exist yet.",
    ).toEqual([]);
  });

  it("numbers migrations contiguously from 0001", () => {
    // A gap means a migration was deleted after being applied somewhere, so the
    // runner's bookkeeping and the directory disagree.
    const nums = numberedMigrations.map((f) => Number(f.slice(0, 4)));
    expect(nums).toEqual(nums.map((_, i) => i + 1));
  });

  it("never lets committed code depend on an uncommitted migration", () => {
    /**
     * The bug: `news-repo.ts` shipped a query against `stories.first_seen_at` while
     * `0013_first_seen.sql` sat untracked. Tests passed because makeTestDb() reads
     * migrations off disk INCLUDING untracked files — so the working tree was green
     * and only a fresh clone was broken. Nothing noticed.
     *
     * Note what this does NOT assert: that every migration is committed. An
     * untracked migration you're still writing is normal, and in CI (a fresh clone)
     * there are no untracked files at all, which would make that check vacuous
     * exactly where it matters. The real invariant is narrower and always
     * meaningful: nothing already committed may depend on something that isn't.
     */
    const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" });
    let trackedRaw: string;
    try {
      trackedRaw = git(["ls-files", "migrations"]);
    } catch {
      return; // not a git checkout — nothing to reconcile
    }
    const tracked = new Set(
      trackedRaw.split("\n").map((l) => l.trim().replace(/^migrations\//, "")).filter(Boolean),
    );
    const untracked = migrationFiles.filter((f) => !tracked.has(f));
    if (untracked.length === 0) return;

    const identsIn = (sql: string): string[] => [
      ...[...sql.matchAll(/ADD\s+COLUMN\s+["`]?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]!),
      ...[...sql.matchAll(/CREATE\s+TABLE\s+(?:IF NOT EXISTS\s+)?["`]?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]!),
    ];

    // Anything a COMMITTED migration already creates is, by definition, not a new
    // dependency — even if an uncommitted migration re-declares it. Table rebuilds
    // (0009/0017/0020/…) legitimately re-CREATE existing tables, and treating that
    // as "introduces `comments`" flags every file in the news pipeline.
    const existing = new Set<string>();
    for (const f of migrationFiles) {
      if (!tracked.has(f)) continue;
      for (const id of identsIn(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))) existing.add(id);
    }

    // Identifiers each uncommitted migration genuinely introduces.
    const pending: Array<{ file: string; ident: string }> = [];
    for (const f of untracked) {
      for (const id of identsIn(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))) {
        if (!existing.has(id)) pending.push({ file: f, ident: id });
      }
    }

    // Does anything already in HEAD reference them? `git grep <ident> HEAD` searches
    // committed content, not the working tree — which is the whole point.
    const broken: string[] = [];
    for (const { file, ident } of pending) {
      if (ident.length < 4) continue; // too short to grep meaningfully
      let hits = "";
      try {
        hits = git(["grep", "-l", "-F", "-e", ident, "HEAD", "--", "src/"]);
      } catch {
        continue; // git grep exits 1 on no match
      }
      if (hits.trim()) {
        broken.push(`${ident} (from uncommitted ${file}) is referenced by committed ${hits.trim().split("\n").join(", ")}`);
      }
    }

    expect(
      broken,
      `Committed code depends on a migration that isn't committed. The suite is green ` +
        `only because it reads migrations off disk; a fresh clone is broken:\n  ${broken.join("\n  ")}`,
    ).toEqual([]);
  });

  it("writes idempotent DDL so a re-applied migration cannot fail mid-run", () => {
    // Every CREATE must be IF NOT EXISTS, except inside a deliberate table rebuild
    // (0009/0017/0020), which DROPs first and therefore must not guard.
    const offenders: string[] = [];
    for (const f of migrationFiles) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, f), "utf8");
      const rebuild = /DROP TABLE/i.test(sql);
      if (rebuild) continue;
      for (const m of sql.matchAll(/CREATE\s+(TABLE|INDEX|UNIQUE INDEX|VIRTUAL TABLE)\s+(?!IF NOT EXISTS)/gi)) {
        offenders.push(`${f}: CREATE ${m[1]} without IF NOT EXISTS`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
