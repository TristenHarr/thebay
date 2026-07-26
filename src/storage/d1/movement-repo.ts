import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import { haversineKm } from "../../core/geofence";
import { encode } from "../../core/geohash";
import { segmentXp, DAILY_MOVEMENT_XP_CAP } from "../../core/xp/movement";
import { XpRepo } from "./xp-repo";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();
const MOVE_PRECISION = 6; // ~1.2km cell — matches the map's cell param (shadows/places)

/**
 * MovementRepo — "mobbing": the server-authoritative movement→XP loop + the trail
 * and tracker telemetry. On each ping it measures distance from the user's previous
 * point (haversine — the client's claimed distance is never trusted), awards capped
 * XP via {@link XpRepo}, and logs speed + a flag for implausible jumps. Movement is
 * SEMI-CHEATABLE (spoofers still earn) but every grant is recorded so the admin
 * tracker can see who's teleporting. Recent rows are your fading breadcrumb trail.
 */
export class MovementRepo {
  constructor(private db: D1Database) {}

  /** Accept a movement ping. Returns the segment's distance, awarded XP, speed + flag. */
  async ping(userId: string, lat: number, lng: number, scope = "public", atIso: string = nowIso()): Promise<{ dist: number; xp: number; mps: number; flagged: boolean; cappedToday: boolean; cell: string }> {
    const atMs = new Date(atIso).getTime();
    const last = await this.db.prepare("SELECT lat, lng, at FROM movement_log WHERE user_id = ? ORDER BY at DESC LIMIT 1").bind(userId).first<Row>();
    const dist = last ? haversineKm(last.lat, last.lng, lat, lng) * 1000 : 0;
    const dt = last ? atMs - new Date(last.at).getTime() : 0;
    const seg = segmentXp(dist, dt);

    // Daily cap — sum today's awarded movement XP, award only what's left.
    const day = atIso.slice(0, 10);
    const todays = await this.db.prepare("SELECT COALESCE(SUM(xp),0) AS n FROM movement_log WHERE user_id = ? AND substr(at,1,10) = ?").bind(userId, day).first<Row>();
    const remaining = Math.max(0, DAILY_MOVEMENT_XP_CAP - Number(todays?.n ?? 0));
    const award = Math.min(seg.xp, remaining);

    const id = ulid();
    const cell = encode(lat, lng, MOVE_PRECISION);
    await this.db
      .prepare("INSERT INTO movement_log (id, user_id, lat, lng, cell, at, dist_m, mps, xp, flagged, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, userId, lat, lng, cell, atIso, Math.round(dist), seg.mps, award, seg.flagged ? 1 : 0, scope)
      .run();
    if (award > 0) await new XpRepo(this.db).grant(userId, "movement", award, `movement:${id}`, { dist: Math.round(dist), mps: seg.mps });

    return { dist: Math.round(dist), xp: award, mps: seg.mps, flagged: seg.flagged, cappedToday: remaining <= 0, cell };
  }

  /** The living map: recent PUBLIC-scope dots in the visible cells, ANONYMIZED
   *  (one per user — their latest point). Friends/group-scoped pings stay private
   *  here — only the pinger's own trail + (later) their chosen echelon see those. */
  async liveDots(cells: string[], sinceIso: string): Promise<Array<{ lat: number; lng: number }>> {
    if (!cells.length) return [];
    const ph = cells.map(() => "?").join(",");
    const r = await this.db
      .prepare(
        `SELECT m.lat AS lat, m.lng AS lng FROM movement_log m
          WHERE m.scope = 'public' AND m.at >= ? AND m.cell IN (${ph})
            AND m.at = (SELECT MAX(m2.at) FROM movement_log m2 WHERE m2.user_id = m.user_id AND m2.at >= ?)
          LIMIT 500`,
      )
      .bind(sinceIso, ...cells, sinceIso)
      .all<Row>();
    return (r.results ?? []).map((x) => ({ lat: x.lat, lng: x.lng }));
  }

  /** A user's recent breadcrumb trail (the fading polyline), oldest→newest. */
  async trail(userId: string, sinceIso: string): Promise<Array<{ lat: number; lng: number; at: string }>> {
    const r = await this.db.prepare("SELECT lat, lng, at FROM movement_log WHERE user_id = ? AND at >= ? ORDER BY at ASC").bind(userId, sinceIso).all<Row>();
    return (r.results ?? []).map((x) => ({ lat: x.lat, lng: x.lng, at: x.at }));
  }

  /** Admin tracker: per-user movement summary since `sinceIso` (who's earning, who's flagged). */
  async tracker(sinceIso: string, limit = 100): Promise<Array<{ userId: string; displayName: string; handle: string; xp: number; distance: number; maxMps: number; flags: number; pings: number; lastAt: string }>> {
    const r = await this.db
      .prepare(
        `SELECT m.user_id AS userId, u.display_name AS displayName, u.handle AS handle,
                COALESCE(SUM(m.xp),0) AS xp, COALESCE(SUM(m.dist_m),0) AS distance,
                COALESCE(MAX(m.mps),0) AS maxMps, COALESCE(SUM(m.flagged),0) AS flags,
                COUNT(*) AS pings, MAX(m.at) AS lastAt
           FROM movement_log m JOIN users u ON u.id = m.user_id
          WHERE m.at >= ?
          GROUP BY m.user_id ORDER BY xp DESC LIMIT ?`,
      )
      .bind(sinceIso, limit)
      .all<Row>();
    return (r.results ?? []).map((x) => ({
      userId: x.userId, displayName: x.displayName, handle: x.handle,
      xp: Number(x.xp), distance: Math.round(Number(x.distance)), maxMps: Number(x.maxMps),
      flags: Number(x.flags), pings: Number(x.pings), lastAt: x.lastAt,
    }));
  }

  /** GC old pings — trails fade (cron backstop). Returns rows removed. */
  async deleteOld(beforeIso: string): Promise<number> {
    const r: any = await this.db.prepare("DELETE FROM movement_log WHERE at < ?").bind(beforeIso).run();
    return r.meta?.changes ?? 0;
  }
}
