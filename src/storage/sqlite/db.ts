import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { env } from "../../config/env";

export type Db = Database.Database;

export function openDb(path: string = env.DATABASE_PATH): Db {
  const abs = resolve(process.cwd(), path);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new Database(abs);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}
