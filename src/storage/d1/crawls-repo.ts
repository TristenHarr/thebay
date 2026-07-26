import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import { haversineKm } from "../../core/geofence";
import { XpRepo } from "./xp-repo";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();
export const CRAWL_STOP_XP = 15; // reaching a waypoint
export const CRAWL_FINISH_XP = 100; // completing the whole route
export const CRAWL_STOP_RADIUS_M = 80; // must be within ~80m of a stop to check it off

export interface CrawlStop {
  name: string;
  lat: number;
  lng: number;
}

/**
 * CrawlsRepo — "founder crawls": named, shareable routes you plan and mob together.
 * Reaching each stop is GPS-verified and must be sequential (no skipping ahead),
 * pays waypoint XP once, and finishing the route pays a bonus — all dedup-keyed via
 * {@link XpRepo} so re-walking a crawl can't farm it.
 */
export class CrawlsRepo {
  constructor(private db: D1Database) {}

  /** Plan a crawl (creator auto-joins). Needs ≥2 stops. Returns the crawl id. */
  async create(creatorId: string, c: { name: string; description?: string; isPublic?: boolean; stops: CrawlStop[] }): Promise<string> {
    const id = ulid();
    const ts = nowIso();
    const stmts: any[] = [
      this.db.prepare("INSERT INTO crawls (id, name, description, creator_id, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, c.name, c.description ?? null, creatorId, c.isPublic === false ? 0 : 1, ts),
      this.db.prepare("INSERT INTO crawl_participants (crawl_id, user_id, joined_at, progress) VALUES (?, ?, ?, 0)").bind(id, creatorId, ts),
    ];
    c.stops.forEach((s, i) => stmts.push(this.db.prepare("INSERT INTO crawl_stops (crawl_id, idx, name, lat, lng) VALUES (?, ?, ?, ?, ?)").bind(id, i, s.name, s.lat, s.lng)));
    await this.db.batch(stmts);
    return id;
  }

  /** Public crawls, newest first, with stop + participant counts. */
  async list(limit = 50): Promise<Array<{ id: string; name: string; description: string | null; creatorId: string; stops: number; walkers: number; createdAt: string }>> {
    const r = await this.db
      .prepare(
        `SELECT c.id, c.name, c.description, c.creator_id, c.created_at,
                (SELECT COUNT(*) FROM crawl_stops s WHERE s.crawl_id = c.id) AS stops,
                (SELECT COUNT(*) FROM crawl_participants p WHERE p.crawl_id = c.id) AS walkers
           FROM crawls c WHERE c.is_public = 1 ORDER BY c.created_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return (r.results ?? []).map((x) => ({ id: x.id, name: x.name, description: x.description ?? null, creatorId: x.creator_id, stops: Number(x.stops), walkers: Number(x.walkers), createdAt: x.created_at }));
  }

  /** A crawl's full detail: stops (in order) + participants with progress. */
  async get(crawlId: string): Promise<{ crawl: Row; stops: Row[]; participants: Row[] } | null> {
    const crawl = await this.db.prepare("SELECT id, name, description, creator_id AS creatorId, is_public AS isPublic, created_at AS createdAt FROM crawls WHERE id = ?").bind(crawlId).first<Row>();
    if (!crawl) return null;
    const stops = await this.db.prepare("SELECT idx, name, lat, lng FROM crawl_stops WHERE crawl_id = ? ORDER BY idx").bind(crawlId).all<Row>();
    const participants = await this.db
      .prepare("SELECT p.user_id AS userId, p.progress, p.finished_at AS finishedAt, u.display_name AS displayName, u.handle FROM crawl_participants p JOIN users u ON u.id = p.user_id WHERE p.crawl_id = ? ORDER BY p.progress DESC")
      .bind(crawlId)
      .all<Row>();
    return { crawl, stops: stops.results ?? [], participants: participants.results ?? [] };
  }

  async join(userId: string, crawlId: string): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO crawl_participants (crawl_id, user_id, joined_at, progress) VALUES (?, ?, ?, 0)").bind(crawlId, userId, nowIso()).run();
  }

  /** Check off the next stop — must be your current stop (sequential) AND you must be
   *  within range of it. Pays waypoint XP; finishing the route pays the bonus. */
  async checkpoint(userId: string, crawlId: string, stopIdx: number, lat: number, lng: number, atMs = Date.now()): Promise<{ status: "ok" | "not-joined" | "out-of-order" | "too-far" | "done"; progress?: number; finished?: boolean; xp?: number }> {
    const part = await this.db.prepare("SELECT progress, finished_at FROM crawl_participants WHERE crawl_id = ? AND user_id = ?").bind(crawlId, userId).first<Row>();
    if (!part) return { status: "not-joined" };
    if (part.finished_at) return { status: "done" };
    if (stopIdx !== part.progress) return { status: "out-of-order", progress: part.progress };
    const stop = await this.db.prepare("SELECT lat, lng FROM crawl_stops WHERE crawl_id = ? AND idx = ?").bind(crawlId, stopIdx).first<Row>();
    if (!stop) return { status: "out-of-order", progress: part.progress };
    if (haversineKm(lat, lng, stop.lat, stop.lng) * 1000 > CRAWL_STOP_RADIUS_M) return { status: "too-far", progress: part.progress };

    const progress = part.progress + 1;
    const total = Number((await this.db.prepare("SELECT COUNT(*) AS n FROM crawl_stops WHERE crawl_id = ?").bind(crawlId).first<Row>())?.n ?? 0);
    const finished = progress >= total;
    await this.db.prepare("UPDATE crawl_participants SET progress = ?, finished_at = ? WHERE crawl_id = ? AND user_id = ?").bind(progress, finished ? new Date(atMs).toISOString() : null, crawlId, userId).run();
    const xpRepo = new XpRepo(this.db);
    let xp = 0;
    if (await xpRepo.grant(userId, "crawl", CRAWL_STOP_XP, `crawl:${crawlId}:${userId}:${stopIdx}`, { crawl: crawlId, stop: stopIdx })) xp += CRAWL_STOP_XP;
    if (finished && (await xpRepo.grant(userId, "crawl", CRAWL_FINISH_XP, `crawl_finish:${crawlId}:${userId}`, { crawl: crawlId }))) xp += CRAWL_FINISH_XP;
    return { status: "ok", progress, finished, xp };
  }
}
