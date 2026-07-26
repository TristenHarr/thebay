import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import { encode, cellsInBbox } from "../../core/geohash";
import { haversineKm } from "../../core/geofence";
import { trustScore, freshness, type Freshness } from "../../core/places/trust";
import { parseFields, coerceAttrs, parseAttrs, slugifyKindId, serializeFields, type FieldSpec, type Attrs } from "../../core/places/fields";
import { POINTS } from "../../../shared/schema";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

/** ~150m cells: fine enough that a viewport query is cheap, coarse enough that a
 *  city block is one or two cells. */
export const PLACE_PRECISION = 7;
/** Distinct votes that flip a proposed kind to `active`. Deliberately low — the
 *  cost of a wrong kind is a dead layer nobody switches on; the cost of a high
 *  bar is that nobody can ever add one. */
export const RATIFY_VOTES = 3;
/** D1 rejects a statement with >100 bound parameters. */
const CHUNK = 90;
/** Bound the fan-out of a viewport read however far the user zoomed out. */
const MAX_CELLS = 400;

export interface PlaceKind {
  id: string;
  label: string;
  emoji: string;
  color: string | null;
  category: string | null;
  fields: FieldSpec[];
  halfLifeHours: number;
  status: "proposed" | "active" | "retired";
  proposedBy: string | null;
  votes: number;
  createdAt: string;
}

export interface Place {
  id: string;
  kindId: string;
  name: string | null;
  lat: number;
  lng: number;
  geohash: string;
  attrs: Record<string, unknown>;
  address: string | null;
  origin: "crowd" | "import" | "event";
  externalRef: string | null;
  createdBy: string | null;
  confirms: number;
  disputes: number;
  lastConfirmedAt: string | null;
  hidden: boolean;
  createdAt: string;
}
export interface PlaceWithKind extends Place {
  kind: { id: string; label: string; emoji: string; color: string | null; category: string | null; halfLifeHours: number; fields: FieldSpec[] };
  trust: number;
  freshness: Freshness;
  /** Only set by `nearby()`. */
  km?: number;
}

export interface PlaceInput {
  kindId: string;
  name?: string | null;
  lat: number;
  lng: number;
  address?: string | null;
  attrs?: unknown;
  createdBy?: string | null;
  origin?: "crowd" | "import" | "event";
  externalRef?: string | null;
}
export interface KindProposal {
  label: string;
  emoji: string;
  color?: string | null;
  category?: string | null;
  halfLifeHours?: number | null;
  fields?: unknown;
}
export type Verdict = "confirm" | "dispute" | "update" | "tip";
export interface ReportInput {
  verdict: Verdict;
  attrs?: unknown;
  body?: string | null;
  lat?: number | null;
  lng?: number | null;
}
export interface ImportItem {
  externalRef: string;
  kindId: string;
  name?: string | null;
  lat: number;
  lng: number;
  address?: string | null;
  attrs?: Record<string, unknown> | null;
}

const chunks = <T>(xs: T[], n = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * PlacesRepo — the crowd-sourced city map.
 *
 * Thin by design: the taxonomy's rules live in the SQL (0016: one vote per
 * person, UNIQUE external_ref, a kind with pins can't be deleted), the maths
 * lives in `src/core/places` (trust decay, parking legality, the declarative
 * field coercion), and this class is the join between them.
 *
 * Reads are public and cheap: a viewport is a bounded set of geohash prefixes.
 * Writes are Bay-GPS + proximity gated in the route, exactly like shadows.
 */
export class PlacesRepo {
  constructor(private db: D1Database) {}

  /* ── the taxonomy ───────────────────────────────────────────────────────── */

  /** Kinds, active-only by default — a proposed kind is not a map layer yet. */
  async listKinds(opts: { status?: "active" | "proposed" | "retired" | "all" } = {}): Promise<PlaceKind[]> {
    const status = opts.status ?? "active";
    const res =
      status === "all"
        ? await this.db.prepare("SELECT * FROM place_kinds ORDER BY status, votes DESC, id").all<Row>()
        : await this.db.prepare("SELECT * FROM place_kinds WHERE status = ? ORDER BY votes DESC, id").bind(status).all<Row>();
    return (res.results ?? []).map(hydrateKind);
  }

  async getKind(id: string): Promise<PlaceKind | null> {
    const r = await this.db.prepare("SELECT * FROM place_kinds WHERE id = ?").bind(id).first<Row>();
    return r ? hydrateKind(r) : null;
  }

  /**
   * Propose a kind. It starts `proposed` with the proposer's own vote already
   * counted — you always back your own idea, and it saves a round trip.
   */
  async proposeKind(userId: string, input: KindProposal, atIso: string = nowIso()): Promise<PlaceKind> {
    const id = slugifyKindId(input.label);
    const emoji = (input.emoji ?? "").trim();
    if (!id) throw new Error("that label doesn't make a usable kind id");
    if (!emoji) throw new Error("a kind needs an emoji — it is the whole map icon");
    if (await this.getKind(id)) throw new Error("that kind already exists");
    const half = Number.isFinite(input.halfLifeHours as number) && (input.halfLifeHours as number) > 0 ? Math.trunc(input.halfLifeHours as number) : 720;
    const fields = parseFields(input.fields);
    await this.db
      .prepare(
        `INSERT INTO place_kinds (id, label, emoji, color, category, fields_json, half_life_hours, status, proposed_by, votes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, 0, ?)`,
      )
      .bind(id, String(input.label).trim().slice(0, 60), emoji.slice(0, 8), input.color ?? null, input.category ?? null, serializeFields(fields), half, userId, atIso)
      .run();
    await this.voteKind(id, userId, RATIFY_VOTES, atIso);
    return (await this.getKind(id))!;
  }

  /**
   * Back a proposed kind. One vote per person is enforced by the PK, so a
   * re-vote is a silent no-op. Crossing the threshold flips it to `active`
   * exactly once (the UPDATE is guarded on the old status).
   */
  async voteKind(kindId: string, userId: string, threshold = RATIFY_VOTES, atIso: string = nowIso()): Promise<{ votes: number; status: string; ratified: boolean }> {
    await this.db.prepare("INSERT OR IGNORE INTO place_kind_votes (kind_id, user_id, created_at) VALUES (?, ?, ?)").bind(kindId, userId, atIso).run();
    const c = await this.db.prepare("SELECT COUNT(*) AS n FROM place_kind_votes WHERE kind_id = ?").bind(kindId).first<Row>();
    const votes = Number(c?.n ?? 0);
    await this.db.prepare("UPDATE place_kinds SET votes = ? WHERE id = ?").bind(votes, kindId).run();
    let ratified = false;
    if (votes >= threshold) {
      const r: any = await this.db.prepare("UPDATE place_kinds SET status = 'active' WHERE id = ? AND status = 'proposed'").bind(kindId).run();
      ratified = (r.meta?.changes ?? 0) > 0;
    }
    const k = await this.getKind(kindId);
    return { votes, status: k?.status ?? "proposed", ratified };
  }

  /* ── pins ───────────────────────────────────────────────────────────────── */

  /** Drop a pin. Attrs are coerced to the kind's declared `fields_json`, so a
   *  client can never store under a key the kind never declared. */
  async createPlace(input: PlaceInput, atIso: string = nowIso()): Promise<Place> {
    const kind = await this.getKind(input.kindId);
    if (!kind || kind.status !== "active") throw new Error("no such place kind (or it isn't ratified yet)");
    if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) throw new Error("a place needs coordinates");
    const id = ulid();
    const geohash = encode(input.lat, input.lng, PLACE_PRECISION);
    const attrs = coerceAttrs(kind.fields, input.attrs);
    await this.db
      .prepare(
        `INSERT INTO places (id, kind_id, name, lat, lng, geohash, attrs_json, address, origin, external_ref, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, kind.id, input.name?.trim() || null, input.lat, input.lng, geohash, JSON.stringify(attrs), input.address ?? null, input.origin ?? "crowd", input.externalRef ?? null, input.createdBy ?? null, atIso)
      .run();
    return (await this.getPlaceRow(id))!;
  }

  async getPlace(id: string, at: string | Date = new Date()): Promise<PlaceWithKind | null> {
    const r = await this.db
      .prepare(`SELECT p.*, k.label AS k_label, k.emoji AS k_emoji, k.color AS k_color, k.category AS k_category,
                       k.half_life_hours AS k_half, k.fields_json AS k_fields
                  FROM places p JOIN place_kinds k ON k.id = p.kind_id WHERE p.id = ?`)
      .bind(id)
      .first<Row>();
    return r ? hydrate(r, at) : null;
  }

  /** Every visible pin in a set of geohash cells (a map viewport). Cells may be
   *  of mixed precision; each precision becomes one chunked prefix query. */
  async inCells(cells: string[], opts: { kindIds?: string[]; at?: string | Date } = {}): Promise<PlaceWithKind[]> {
    const at = opts.at ?? new Date();
    const clean = [...new Set((cells ?? []).map((c) => String(c || "").trim().toLowerCase()).filter(Boolean))].slice(0, MAX_CELLS);
    if (!clean.length) return [];
    const byLen = new Map<number, string[]>();
    for (const c of clean) byLen.set(c.length, [...(byLen.get(c.length) ?? []), c]);

    const kindIds = (opts.kindIds ?? []).filter(Boolean).slice(0, 20);
    const seen = new Map<string, PlaceWithKind>();
    for (const [len, group] of byLen) {
      // Reserve params for the prefix length + the kind filter, then chunk the rest.
      const budget = CHUNK - 1 - kindIds.length;
      for (const part of chunks(group, Math.max(1, budget))) {
        const kindSql = kindIds.length ? ` AND p.kind_id IN (${kindIds.map(() => "?").join(",")})` : "";
        const res = await this.db
          .prepare(
            `SELECT p.*, k.label AS k_label, k.emoji AS k_emoji, k.color AS k_color, k.category AS k_category,
                    k.half_life_hours AS k_half, k.fields_json AS k_fields
               FROM places p JOIN place_kinds k ON k.id = p.kind_id
              WHERE p.hidden = 0 AND substr(p.geohash, 1, ?) IN (${part.map(() => "?").join(",")})${kindSql}`,
          )
          .bind(len, ...part, ...kindIds)
          .all<Row>();
        for (const r of res.results ?? []) seen.set(r.id, hydrate(r, at));
      }
    }
    return [...seen.values()].sort((a, b) => b.trust - a.trust || (a.id < b.id ? -1 : 1));
  }

  /** Pins within `km` of a point, nearest-cell-first then exact haversine. */
  async nearby(lat: number, lng: number, km: number, opts: { kindIds?: string[]; at?: string | Date } = {}): Promise<PlaceWithKind[]> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    const radius = Math.min(50, Math.max(0.05, Number.isFinite(km) ? km : 1));
    const dLat = radius / 111;
    const dLng = radius / Math.max(1, 111 * Math.cos((lat * Math.PI) / 180));
    const bbox = { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
    // Finest precision whose cell count stays sane for this radius.
    let cells: string[] = [];
    for (const p of [7, 6, 5, 4, 3]) {
      cells = cellsInBbox(bbox, p);
      if (cells.length <= 120) break;
    }
    const found = await this.inCells(cells, opts);
    return found
      .map((p) => ({ ...p, km: haversineKm(lat, lng, p.lat, p.lng) }))
      .filter((p) => p.km <= radius)
      .sort((a, b) => a.km - b.km);
  }

  async setHidden(id: string, hidden: boolean): Promise<void> {
    await this.db.prepare("UPDATE places SET hidden = ? WHERE id = ?").bind(hidden ? 1 : 0, id).run();
  }

  /* ── confirm / dispute / update / tip ───────────────────────────────────── */

  /**
   * A human touched this pin. `confirm`/`dispute` move the trust counters (and a
   * confirm resets the freshness clock, which is what actually keeps the map
   * true); `update` merges coerced attrs; `tip` is the perishable live signal.
   */
  async report(placeId: string, userId: string, input: ReportInput, atIso: string = nowIso()): Promise<{ id: string; confirms: number; disputes: number }> {
    const place = await this.getPlace(placeId, atIso);
    if (!place) throw new Error("no such place");
    const id = ulid();
    const attrs = input.verdict === "update" ? coerceAttrs(place.kind.fields, input.attrs) : (input.attrs ?? null);
    const stmts: any[] = [
      this.db
        .prepare("INSERT INTO place_reports (id, place_id, user_id, verdict, attrs_json, body, lat, lng, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, placeId, userId, input.verdict, attrs === null ? null : JSON.stringify(attrs), input.body?.trim() || null, input.lat ?? null, input.lng ?? null, atIso),
    ];
    if (input.verdict === "confirm" || input.verdict === "dispute") {
      // RECOMPUTED from DISTINCT users, never `confirms + 1`. An increment lets one
      // person tap "still here" fifty times and drive trust to fifty; counting
      // distinct vouchers makes that unrepresentable while still letting the same
      // person re-confirm next week — which is the point, since re-confirming is
      // what advances `last_confirmed_at` and keeps the pin fresh. Self-healing
      // too: the cached counters can't drift from the reports that justify them.
      // (Someone who both confirms and disputes counts on both sides; disputes
      // weigh 1.5×, so a flip-flopper nets toward "don't trust this".)
      stmts.push(
        this.db
          .prepare(
            `UPDATE places SET
               confirms = (SELECT COUNT(DISTINCT user_id) FROM place_reports WHERE place_id = ? AND verdict = 'confirm'),
               disputes = (SELECT COUNT(DISTINCT user_id) FROM place_reports WHERE place_id = ? AND verdict = 'dispute'),
               last_confirmed_at = COALESCE((SELECT MAX(created_at) FROM place_reports WHERE place_id = ? AND verdict = 'confirm'), last_confirmed_at)
             WHERE id = ?`,
          )
          .bind(placeId, placeId, placeId, placeId),
      );
    } else if (input.verdict === "update") {
      const merged = { ...place.attrs, ...(attrs as Attrs) };
      stmts.push(this.db.prepare("UPDATE places SET attrs_json = ? WHERE id = ?").bind(JSON.stringify(merged), placeId));
    }
    await this.db.batch(stmts);
    const after = await this.db.prepare("SELECT confirms, disputes FROM places WHERE id = ?").bind(placeId).first<Row>();
    return { id, confirms: Number(after?.confirms ?? 0), disputes: Number(after?.disputes ?? 0) };
  }

  /** The report stream on a pin's detail sheet (newest first). */
  async recentReports(placeId: string, limit = 20): Promise<Array<{ id: string; verdict: Verdict; body: string | null; attrs: Record<string, unknown>; createdAt: string; author: { id: string; displayName: string; handle: string; avatarKey: string | null } }>> {
    const res = await this.db
      .prepare(
        `SELECT r.*, u.display_name AS a_name, u.handle AS a_handle, u.avatar_key AS a_avatar
           FROM place_reports r JOIN users u ON u.id = r.user_id
          WHERE r.place_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
      )
      .bind(placeId, Math.min(100, Math.max(1, limit)))
      .all<Row>();
    return (res.results ?? []).map((r) => ({
      id: r.id,
      verdict: r.verdict,
      body: r.body ?? null,
      attrs: parseAttrs(r.attrs_json),
      createdAt: r.created_at,
      author: { id: r.user_id, displayName: r.a_name, handle: r.a_handle, avatarKey: r.a_avatar ?? null },
    }));
  }

  /** `tip` reports for a set of pins, newest first — the input to the decayed
   *  block-level difficulty signal (src/core/places/parking). */
  async tipsFor(placeIds: string[], limitPerPlace = 40): Promise<Map<string, Array<{ createdAt: string; attrs: Record<string, unknown> }>>> {
    const out = new Map<string, Array<{ createdAt: string; attrs: Record<string, unknown> }>>();
    const ids = [...new Set((placeIds ?? []).filter(Boolean))];
    if (!ids.length) return out;
    for (const part of chunks(ids)) {
      const res = await this.db
        .prepare(`SELECT place_id, attrs_json, created_at FROM place_reports WHERE verdict = 'tip' AND place_id IN (${part.map(() => "?").join(",")}) ORDER BY created_at DESC`)
        .bind(...part)
        .all<Row>();
      for (const r of res.results ?? []) {
        const list = out.get(r.place_id) ?? [];
        if (list.length < limitPerPlace) list.push({ createdAt: r.created_at, attrs: parseAttrs(r.attrs_json) });
        out.set(r.place_id, list);
      }
    }
    return out;
  }

  /* ── import + moderation + points ───────────────────────────────────────── */

  /**
   * Upsert imported pins keyed on `external_ref` (UNIQUE in 0016, so re-running
   * the importer is idempotent by construction). Follows the house source
   * convention: a bad row is SKIPPED and counted, never a reason to abort the
   * run. Chunked so a 30k-row DataSF pull never breaches D1's parameter cap.
   */
  async importPlaces(items: ImportItem[], atIso: string = nowIso()): Promise<{ inserted: number; updated: number; skipped: number }> {
    const kinds = new Map((await this.listKinds({ status: "all" })).map((k) => [k.id, k]));
    const good: Array<ImportItem & { geohash: string; attrs: Attrs }> = [];
    let skipped = 0;
    const refs = new Set<string>();
    for (const it of items ?? []) {
      const ref = String(it?.externalRef ?? "").trim();
      const kind = kinds.get(it?.kindId ?? "");
      if (!ref || refs.has(ref) || !kind || kind.status === "retired" || !Number.isFinite(it.lat) || !Number.isFinite(it.lng)) { skipped++; continue; }
      refs.add(ref);
      good.push({ ...it, externalRef: ref, geohash: encode(it.lat, it.lng, PLACE_PRECISION), attrs: coerceAttrs(kind.fields, it.attrs) });
    }
    if (!good.length) return { inserted: 0, updated: 0, skipped };

    // Which refs already exist? (Chunked IN — 30k refs would blow the cap.)
    const existing = new Set<string>();
    for (const part of chunks(good.map((g) => g.externalRef))) {
      const res = await this.db.prepare(`SELECT external_ref FROM places WHERE external_ref IN (${part.map(() => "?").join(",")})`).bind(...part).all<Row>();
      for (const r of res.results ?? []) existing.add(r.external_ref);
    }

    const stmts = good.map((g) =>
      this.db
        .prepare(
          `INSERT INTO places (id, kind_id, name, lat, lng, geohash, attrs_json, address, origin, external_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)
           ON CONFLICT(external_ref) DO UPDATE SET
             kind_id = excluded.kind_id, name = excluded.name, lat = excluded.lat, lng = excluded.lng,
             geohash = excluded.geohash, attrs_json = excluded.attrs_json, address = excluded.address`,
        )
        .bind(ulid(), g.kindId, g.name?.trim() || null, g.lat, g.lng, g.geohash, JSON.stringify(g.attrs), g.address ?? null, g.externalRef, atIso),
    );
    for (const part of chunks(stmts, 200)) await this.db.batch(part);

    const updated = good.filter((g) => existing.has(g.externalRef)).length;
    return { inserted: good.length - updated, updated, skipped };
  }

  /** Report a pin to the moderation queue. One flag per person (PK in 0008/0017),
   *  and — per the house rule — a flag never hides anything by itself. */
  async flag(placeId: string, userId: string, reason = "other", atIso: string = nowIso()): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO flags (target_type, target_id, user_id, reason, created_at) VALUES ('place', ?, ?, ?, ?)")
      .bind(placeId, userId, reason, atIso)
      .run();
  }

  /** Points for pinning a resource. Dedup-keyed on the pin, so delete-and-repin
   *  can't farm and a replayed request is free. */
  async recordPlaceCreated(userId: string, placeId: string): Promise<void> {
    await this.award(userId, "place", `place:${placeId}`);
  }
  /** A smaller point for keeping the map true — once per person per pin. */
  async recordPlaceConfirmed(userId: string, placeId: string): Promise<void> {
    await this.award(userId, "place_confirm", `place_confirm:${placeId}:${userId}`);
  }

  private async award(userId: string, kind: keyof typeof POINTS, dedupKey: string): Promise<void> {
    await this.db
      .prepare("INSERT OR IGNORE INTO points_ledger (id, user_id, kind, points, event_id, dedup_key, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)")
      .bind(ulid(), userId, kind, POINTS[kind], dedupKey, nowIso())
      .run();
  }

  /** The venue anchor for "parking near this event" — coordinates + the start
   *  instant legality is judged at. Null when the event doesn't exist. */
  async eventVenue(eventId: string): Promise<{ id: string; title: string; venueName: string | null; address: string | null; startUtc: string; timezone: string; lat: number | null; lng: number | null } | null> {
    const r = await this.db
      .prepare("SELECT id, title, venue_name, address, start_utc, timezone, latitude, longitude FROM events WHERE id = ?")
      .bind(eventId)
      .first<Row>();
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      venueName: r.venue_name ?? null,
      address: r.address ?? null,
      startUtc: r.start_utc,
      timezone: r.timezone,
      lat: typeof r.latitude === "number" ? r.latitude : null,
      lng: typeof r.longitude === "number" ? r.longitude : null,
    };
  }

  private async getPlaceRow(id: string): Promise<Place | null> {
    const r = await this.db.prepare("SELECT * FROM places WHERE id = ?").bind(id).first<Row>();
    return r ? basePlace(r) : null;
  }
}

/* ── hydration ─────────────────────────────────────────────────────────────── */

function hydrateKind(r: Row): PlaceKind {
  return {
    id: r.id,
    label: r.label,
    emoji: r.emoji,
    color: r.color ?? null,
    category: r.category ?? null,
    fields: parseFields(r.fields_json),
    halfLifeHours: Number(r.half_life_hours),
    status: r.status,
    proposedBy: r.proposed_by ?? null,
    votes: Number(r.votes ?? 0),
    createdAt: r.created_at,
  };
}

function basePlace(r: Row): Place {
  return {
    id: r.id,
    kindId: r.kind_id,
    name: r.name ?? null,
    lat: r.lat,
    lng: r.lng,
    geohash: r.geohash,
    attrs: parseAttrs(r.attrs_json),
    address: r.address ?? null,
    origin: r.origin,
    externalRef: r.external_ref ?? null,
    createdBy: r.created_by ?? null,
    confirms: Number(r.confirms ?? 0),
    disputes: Number(r.disputes ?? 0),
    lastConfirmedAt: r.last_confirmed_at ?? null,
    hidden: !!r.hidden,
    createdAt: r.created_at,
  };
}

/** A joined place row → the API shape, with trust evaluated at `at`. */
function hydrate(r: Row, at: string | Date): PlaceWithKind {
  const p = basePlace(r);
  const halfLifeHours = Number(r.k_half);
  const vouch = { confirms: p.confirms, disputes: p.disputes, createdAt: p.createdAt, lastConfirmedAt: p.lastConfirmedAt, halfLifeHours };
  return {
    ...p,
    kind: {
      id: p.kindId,
      label: r.k_label,
      emoji: r.k_emoji,
      color: r.k_color ?? null,
      category: r.k_category ?? null,
      halfLifeHours,
      fields: parseFields(r.k_fields),
    },
    trust: trustScore(vouch, at),
    freshness: freshness(vouch, at),
  };
}
