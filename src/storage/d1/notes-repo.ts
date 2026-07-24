import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

export interface Note {
  id: string;
  lat: number;
  lng: number;
  body: string;
  createdAt: string;
  author: string;
  handle: string;
}

/** NotesRepo — the map bulletin board. Thin data access; the Bay-Area gate lives
 *  in the route (via src/core/geo). */
export class NotesRepo {
  constructor(private db: D1Database) {}

  async post(authorId: string, lat: number, lng: number, body: string, atIso: string = nowIso()): Promise<string> {
    const id = ulid();
    await this.db
      .prepare("INSERT INTO notes (id, author_id, lat, lng, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, authorId, lat, lng, body, atIso)
      .run();
    return id;
  }

  /** Most recent notes, with the author's name/handle. */
  async recent(limit = 200): Promise<Note[]> {
    const r = await this.db
      .prepare(
        `SELECT n.id, n.lat, n.lng, n.body, n.created_at, u.display_name AS author, u.handle
           FROM notes n JOIN users u ON u.id = n.author_id
          ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return (r.results ?? []).map((x) => ({ id: x.id, lat: x.lat, lng: x.lng, body: x.body, createdAt: x.created_at, author: x.author, handle: x.handle }));
  }
}
