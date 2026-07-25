/**
 * A tiny D1Database-compatible shim over better-sqlite3, so we can unit-test the
 * D1 repositories in plain Node vitest against the REAL schema — real FK / CHECK /
 * UNIQUE enforcement, real json_each, real ON CONFLICT. It implements exactly the
 * subset of the D1 API the repos use: prepare().bind().all()/first()/run() + batch().
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * D1 rejects a statement with more than 100 bound parameters. better-sqlite3 does
 * NOT — it happily takes hundreds — so an unchunked `IN (?,?,…)` passes every
 * test and then 500s in production. That exact gap took the live news front page
 * down for signed-in readers while every anonymous smoke check stayed green.
 *
 * Enforcing the real limit here makes the whole bug class fail loudly in tests.
 * Chunk at 90 (the convention in D1Repo) if you hit this.
 */
const D1_MAX_BOUND_PARAMS = 100;

class Stmt {
  args: any[] = [];
  constructor(public db: Database.Database, public sql: string) {}
  bind(...args: any[]) {
    if (args.length > D1_MAX_BOUND_PARAMS) {
      throw new Error(
        `D1_ERROR: too many SQL variables — ${args.length} bound parameters exceeds D1's limit of ${D1_MAX_BOUND_PARAMS}. ` +
        `Chunk this query (see D1Repo.chunk / NewsRepo.attachSources).`,
      );
    }
    this.args = args;
    return this;
  }
  async all<T = any>() { return { results: this.db.prepare(this.sql).all(...this.args) as T[], success: true, meta: {} }; }
  async first<T = any>() { const r = this.db.prepare(this.sql).get(...this.args); return (r ?? null) as T | null; }
  async run() { const i = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: i.changes } }; }
  execSync() { return this.db.prepare(this.sql).run(...this.args); }
}

export class SqliteD1 {
  constructor(public db: Database.Database) {}
  prepare(sql: string) { return new Stmt(this.db, sql); }
  async batch(stmts: Stmt[]) {
    const tx = this.db.transaction((ss: Stmt[]) => ss.map((s) => s.execSync()));
    return tx(stmts);
  }
  async exec(sql: string) { this.db.exec(sql); return { count: 0, duration: 0 }; }
}

/** Fresh in-memory DB with ALL migrations applied (in order) + FKs enforced. */
export function makeTestDb(): { d1: any; raw: Database.Database } {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const dir = resolve(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(resolve(dir, f), "utf8"));
  }
  return { d1: new SqliteD1(raw) as any, raw };
}
