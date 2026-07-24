import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

export interface MediaInput {
  eventId?: string;
  kind: "photo" | "video";
  imageId?: string;
  streamId?: string;
  r2Key?: string;
  lat?: number;
  lng?: number;
  takenAt?: string;
  caption?: string;
}
export interface Media {
  id: string;
  userId: string;
  eventId: string | null;
  kind: "photo" | "video";
  imageId: string | null;
  streamId: string | null;
  lat: number | null;
  lng: number | null;
  takenAt: string | null;
  caption: string | null;
  createdAt: string;
}
const toMedia = (r: Row): Media => ({
  id: r.id,
  userId: r.user_id,
  eventId: r.event_id ?? null,
  kind: r.kind,
  imageId: r.image_id ?? null,
  streamId: r.stream_id ?? null,
  lat: r.lat ?? null,
  lng: r.lng ?? null,
  takenAt: r.taken_at ?? null,
  caption: r.caption ?? null,
  createdAt: r.created_at,
});

/** MediaRepo — photos & videos (Cloudflare Images/Stream ids) with geo/time and tags. */
export class MediaRepo {
  constructor(private db: D1Database) {}

  async addMedia(userId: string, m: MediaInput): Promise<string> {
    const id = ulid();
    await this.db
      .prepare(
        `INSERT INTO media (id, user_id, event_id, kind, image_id, stream_id, r2_key, lat, lng, taken_at, caption, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, userId, m.eventId ?? null, m.kind, m.imageId ?? null, m.streamId ?? null, m.r2Key ?? null, m.lat ?? null, m.lng ?? null, m.takenAt ?? null, m.caption ?? null, nowIso())
      .run();
    return id;
  }
  async setMediaMeta(userId: string, mediaId: string, patch: { eventId?: string; caption?: string; lat?: number; lng?: number }): Promise<void> {
    const sets: string[] = [];
    const vals: any[] = [];
    const map: Record<string, any> = { event_id: patch.eventId, caption: patch.caption, lat: patch.lat, lng: patch.lng };
    for (const [col, v] of Object.entries(map)) if (v !== undefined) { sets.push(`${col} = ?`); vals.push(v); }
    if (!sets.length) return;
    await this.db.prepare(`UPDATE media SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).bind(...vals, mediaId, userId).run();
  }
  async listUserMedia(userId: string): Promise<Media[]> {
    const res = await this.db.prepare("SELECT * FROM media WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all<Row>();
    return (res.results ?? []).map(toMedia);
  }
  async listEventMedia(eventId: string): Promise<Media[]> {
    const res = await this.db.prepare("SELECT * FROM media WHERE event_id = ? ORDER BY created_at DESC").bind(eventId).all<Row>();
    return (res.results ?? []).map(toMedia);
  }
  /** Does this user own this media? (Only the owner may tag people in it.) */
  async isOwner(userId: string, mediaId: string): Promise<boolean> {
    const r = await this.db.prepare("SELECT 1 FROM media WHERE id = ? AND user_id = ?").bind(mediaId, userId).first();
    return !!r;
  }
  async tagUser(mediaId: string, userId: string): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO media_tags (media_id, user_id) VALUES (?, ?)").bind(mediaId, userId).run();
  }
  async mediaTags(mediaId: string): Promise<Array<{ id: string; displayName: string; handle: string }>> {
    const res = await this.db
      .prepare("SELECT u.id, u.display_name AS displayName, u.handle FROM media_tags t JOIN users u ON u.id = t.user_id WHERE t.media_id = ?")
      .bind(mediaId)
      .all<Row>();
    return (res.results ?? []) as any;
  }
}
