import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import { encode } from "../../core/geohash";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();
const DAY_MS = 24 * 3600 * 1000;
export const SHADOW_PRECISION = 6; // ~1.2km cell — one Durable Object per cell.

export type ShadowKind = "thought" | "photo" | "voice" | "video" | "connection";
export interface ShadowInput {
  lat: number;
  lng: number;
  kind: ShadowKind;
  body?: string | null;
  mediaKey?: string | null;
  streamId?: string | null;
  connectionUserId?: string | null;
}
export interface Shadow {
  id: string;
  authorId: string;
  lat: number;
  lng: number;
  cell: string;
  kind: ShadowKind;
  body: string | null;
  mediaKey: string | null;
  streamId: string | null;
  connectionUserId: string | null;
  createdAt: string;
  expiresAt: string;
  author: { id: string; displayName: string; handle: string; avatarKey: string | null };
  reactions: Record<string, number>;
}

/**
 * ShadowsRepo — the ephemeral, location-sharded board. Every shadow expires 24h
 * after posting; one active per author (a new post replaces the old); each shadow
 * is stamped with a geohash cell so it routes to that cell's Durable Object. D1 is
 * the durable backstop + the source for the zoomed-out heat aggregate; the live
 * path is served by the per-cell DOs.
 */
export class ShadowsRepo {
  constructor(private db: D1Database) {}

  /** Post a shadow, replacing the author's previous one (1-per-account). Returns the
   *  new id/cell and the replaced shadow (so the caller can evict it from its cell DO). */
  async post(authorId: string, input: ShadowInput, atIso: string = nowIso()): Promise<{ id: string; cell: string; expiresAt: string; replaced: { id: string; cell: string } | null }> {
    const cell = encode(input.lat, input.lng, SHADOW_PRECISION);
    const expiresAt = new Date(new Date(atIso).getTime() + DAY_MS).toISOString();
    const old = await this.db.prepare("SELECT id, cell FROM shadows WHERE author_id = ?").bind(authorId).first<Row>();
    const id = ulid();
    const stmts: any[] = [];
    if (old) stmts.push(this.db.prepare("DELETE FROM shadows WHERE author_id = ?").bind(authorId));
    stmts.push(
      this.db
        .prepare(
          `INSERT INTO shadows (id, author_id, lat, lng, cell, kind, body, media_key, stream_id, connection_user_id, mod_status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)`,
        )
        .bind(id, authorId, input.lat, input.lng, cell, input.kind, input.body ?? null, input.mediaKey ?? null, input.streamId ?? null, input.connectionUserId ?? null, atIso, expiresAt),
    );
    await this.db.batch(stmts);
    return { id, cell, expiresAt, replaced: old ? { id: old.id, cell: old.cell } : null };
  }

  /** Active (non-expired, moderation-ok) shadows in one cell — the live/backstop read. */
  async activeInCell(cell: string, now: Date = new Date()): Promise<Shadow[]> {
    const res = await this.db
      .prepare(
        `SELECT s.*, u.display_name AS author_name, u.handle AS author_handle, u.avatar_key AS author_avatar
           FROM shadows s JOIN users u ON u.id = s.author_id
          WHERE s.cell = ? AND s.expires_at > ? AND s.mod_status = 'ok'
          ORDER BY s.created_at DESC, s.id DESC`,
      )
      .bind(cell, now.toISOString())
      .all<Row>();
    const rows = res.results ?? [];
    return this.hydrate(rows);
  }

  /** Active shadows across several cells (a map viewport). */
  async activeInCells(cells: string[], now: Date = new Date()): Promise<Shadow[]> {
    if (!cells.length) return [];
    const ph = cells.map(() => "?").join(",");
    const res = await this.db
      .prepare(
        `SELECT s.*, u.display_name AS author_name, u.handle AS author_handle, u.avatar_key AS author_avatar
           FROM shadows s JOIN users u ON u.id = s.author_id
          WHERE s.cell IN (${ph}) AND s.expires_at > ? AND s.mod_status = 'ok'
          ORDER BY s.created_at DESC, s.id DESC`,
      )
      .bind(...cells, now.toISOString())
      .all<Row>();
    return this.hydrate(res.results ?? []);
  }

  /** Zoomed-out heat: active-shadow counts grouped by a coarse geohash prefix. Cheap
   *  + edge-cacheable, so the whole-Bay view never fans out per-shadow. */
  async heat(precision: number, now: Date = new Date()): Promise<Array<{ cell: string; count: number }>> {
    const res = await this.db
      .prepare(`SELECT substr(cell, 1, ?) AS c, COUNT(*) AS n FROM shadows WHERE expires_at > ? AND mod_status = 'ok' GROUP BY c`)
      .bind(precision, now.toISOString())
      .all<Row>();
    return (res.results ?? []).map((r) => ({ cell: r.c, count: Number(r.n) }));
  }

  async react(shadowId: string, userId: string, emoji: string): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO shadow_reactions (shadow_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)").bind(shadowId, userId, emoji, nowIso()).run();
  }
  async unreact(shadowId: string, userId: string, emoji: string): Promise<void> {
    await this.db.prepare("DELETE FROM shadow_reactions WHERE shadow_id = ? AND user_id = ? AND emoji = ?").bind(shadowId, userId, emoji).run();
  }
  /** A user reports a shadow → hide it (pending) for re-audit. */
  async report(shadowId: string): Promise<void> {
    await this.db.prepare("UPDATE shadows SET mod_status = 'pending' WHERE id = ? AND mod_status <> 'blocked'").bind(shadowId).run();
  }
  async setModeration(shadowId: string, status: "pending" | "ok" | "blocked", reason: string | null = null): Promise<void> {
    await this.db.prepare("UPDATE shadows SET mod_status = ?, mod_reason = ? WHERE id = ?").bind(status, reason, shadowId).run();
  }
  /** Delete your own shadow. Returns whether a row was removed. */
  async deleteOwn(shadowId: string, userId: string): Promise<boolean> {
    const r: any = await this.db.prepare("DELETE FROM shadows WHERE id = ? AND author_id = ?").bind(shadowId, userId).run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /** The active shadow an author currently holds (for the composer / DO eviction). */
  async activeByAuthor(authorId: string, now: Date = new Date()): Promise<{ id: string; cell: string } | null> {
    const r = await this.db.prepare("SELECT id, cell FROM shadows WHERE author_id = ? AND expires_at > ?").bind(authorId, now.toISOString()).first<Row>();
    return r ? { id: r.id, cell: r.cell } : null;
  }

  /** Hard-delete everything past its 24h — the cron GC backstop. Returns media
   *  references so the caller can also delete the R2 objects / Stream videos. */
  async deleteExpired(now: Date = new Date()): Promise<{ ids: string[]; mediaKeys: string[]; streamIds: string[] }> {
    const iso = now.toISOString();
    const res = await this.db.prepare("SELECT id, media_key, stream_id FROM shadows WHERE expires_at <= ?").bind(iso).all<Row>();
    const rows = res.results ?? [];
    const ids = rows.map((r) => r.id as string);
    if (ids.length) await this.db.prepare("DELETE FROM shadows WHERE expires_at <= ?").bind(iso).run();
    return {
      ids,
      mediaKeys: rows.map((r) => r.media_key).filter(Boolean),
      streamIds: rows.map((r) => r.stream_id).filter(Boolean),
    };
  }

  private async hydrate(rows: Row[]): Promise<Shadow[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => "?").join(",");
    const rx = await this.db.prepare(`SELECT shadow_id, emoji, COUNT(*) AS n FROM shadow_reactions WHERE shadow_id IN (${ph}) GROUP BY shadow_id, emoji`).bind(...ids).all<Row>();
    const byShadow = new Map<string, Record<string, number>>();
    for (const r of rx.results ?? []) {
      const m = byShadow.get(r.shadow_id) ?? {};
      m[r.emoji] = Number(r.n);
      byShadow.set(r.shadow_id, m);
    }
    return rows.map((r) => ({
      id: r.id,
      authorId: r.author_id,
      lat: r.lat,
      lng: r.lng,
      cell: r.cell,
      kind: r.kind,
      body: r.body ?? null,
      mediaKey: r.media_key ?? null,
      streamId: r.stream_id ?? null,
      connectionUserId: r.connection_user_id ?? null,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      author: { id: r.author_id, displayName: r.author_name, handle: r.author_handle, avatarKey: r.author_avatar ?? null },
      reactions: byShadow.get(r.id) ?? {},
    }));
  }
}
