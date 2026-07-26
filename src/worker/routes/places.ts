import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireIngestToken } from "../middleware/bearer";
import { PlacesRepo, RATIFY_VOTES, type PlaceWithKind } from "../../storage/d1/places-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { inBay } from "../../core/geo";
import { haversineKm } from "../../core/geofence";
import { canIParkHere, parkingDifficulty, rankParking, type ParkingAttrs } from "../../core/places/parking";
import {
  PlaceCreateSchema,
  PlaceFlagSchema,
  PlaceKindProposeSchema,
  PlaceReportSchema,
  PlacesImportSchema,
} from "../../core/places/schema";

/**
 * The crowd-sourced city map: parking, work spots, water, restrooms — and a
 * taxonomy the crowd proposes and ratifies itself (migrations/0016).
 *
 * Reads are public and cheap: a viewport is a bounded set of geohash cells, the
 * same shape shadows uses. Writes are signed in, Bay-GPS-gated AND
 * proximity-gated: you cannot pin a resource you are not standing next to, and
 * you cannot confirm one from across the bridge. That single rule is what makes
 * the data worth trusting, and it's POST /api/notes with one extra check.
 *
 * The `parking` kind gets first-class treatment because it's the pain point that
 * makes anyone open this at all: every parking pin carries a legality sentence
 * evaluated in Pacific wall-clock (src/core/places/parking), and events get a
 * ranked "where do I actually park for this" list.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new PlacesRepo(c.env.DB);

/** Bounds a viewport read (one prefix query per distinct precision). */
const MAX_CELLS = 128;
const CELL_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,9}$/; // base32 geohash alphabet
/**
 * How far from a pin you may be and still count as "there". Wide enough for GPS
 * drift, a garage entrance on the far corner and standing across the street;
 * narrow enough that you can't map a neighbourhood from your couch.
 */
export const PROXIMITY_KM = 1;
/** Default walk radius for "parking near this venue". */
const PARKING_RADIUS_KM = 1.2;

const KIND_PARKING = "parking";

/** Attach the parking legality sentence to a pin, when it is one. */
function withParking(p: PlaceWithKind, at: string | Date) {
  if (p.kindId !== KIND_PARKING) return p;
  return { ...p, parking: canIParkHere({ attrs: p.attrs as ParkingAttrs }, at) };
}

export function placesRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  /* ── the taxonomy ─────────────────────────────────────────────────────────── */

  // The map's layers. Active-only by default: a proposed kind is a ballot, not a
  // layer. `?status=proposed` drives the voting screen.
  app.get("/api/place-kinds", async (c) => {
    const q = c.req.query("status");
    const status = q === "proposed" || q === "retired" || q === "all" ? q : "active";
    return c.json({ kinds: await repo(c).listKinds({ status }), ratifyVotes: RATIFY_VOTES });
  });

  // Propose a kind. This is the whole point: users decide what this city needs
  // pinned, and `fields` is the declarative form the new kind gets for free.
  app.post("/api/place-kinds", requireAuth, async (c) => {
    const parsed = PlaceKindProposeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad proposal", issues: parsed.error.issues.slice(0, 5) }, 400);
    try {
      const kind = await repo(c).proposeKind(c.get("user")!.id, parsed.data);
      return c.json({ ok: true, kind, ratifyVotes: RATIFY_VOTES });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "could not propose that kind";
      return c.json({ error: msg }, /already exists/.test(msg) ? 409 : 400);
    }
  });

  // Back a proposal. One vote per person (PK), and crossing the threshold flips
  // the kind live — no operator in the loop.
  app.post("/api/place-kinds/:id/vote", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!(await repo(c).getKind(id))) return c.json({ error: "no such kind" }, 404);
    const res = await repo(c).voteKind(id, c.get("user")!.id);
    return c.json({ ok: true, ...res, ratifyVotes: RATIFY_VOTES });
  });

  /* ── reading the map ──────────────────────────────────────────────────────── */

  // A viewport: `?cells=9q8yy,9q8yz&kinds=parking,wifi`.
  app.get("/api/places", optionalAuth, async (c) => {
    const raw = (c.req.query("cells") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const cells = [...new Set(raw)].filter((x) => CELL_RE.test(x)).slice(0, MAX_CELLS);
    if (!cells.length) return c.json({ places: [] });
    const kindIds = (c.req.query("kinds") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const at = new Date();
    const places = await repo(c).inCells(cells, { kindIds, at });
    return c.json({ places: places.map((p) => withParking(p, at)) });
  });

  // "What's around me": `?lat=&lng=&km=&kinds=`. Registered before /:id so the
  // literal path wins.
  app.get("/api/places/near", optionalAuth, async (c) => {
    const lat = Number(c.req.query("lat"));
    const lng = Number(c.req.query("lng"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return c.json({ error: "lat and lng are required" }, 400);
    const km = Number(c.req.query("km"));
    const kindIds = (c.req.query("kinds") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const at = new Date();
    const places = await repo(c).nearby(lat, lng, Number.isFinite(km) ? km : 1, { kindIds, at });
    return c.json({ places: places.map((p) => withParking(p, at)) });
  });

  // A pin's detail sheet: the pin, its report stream, the decayed live difficulty
  // signal, and (for parking) the legality sentence right now.
  app.get("/api/places/:id", optionalAuth, async (c) => {
    const id = c.req.param("id");
    const at = new Date();
    const r = repo(c);
    const place = await r.getPlace(id, at);
    if (!place) return c.json({ error: "no such place" }, 404);
    const [reports, tips] = await Promise.all([r.recentReports(id), r.tipsFor([id])]);
    return c.json({
      place,
      reports,
      difficulty: parkingDifficulty(tips.get(id) ?? [], at, place.kind.halfLifeHours),
      parking: place.kindId === KIND_PARKING ? canIParkHere({ attrs: place.attrs as ParkingAttrs }, at) : null,
    });
  });

  /* ── writing to the map (you have to be there) ────────────────────────────── */

  // Drop a pin. Signed in + physically in the Bay + within walking distance of
  // the pin itself.
  app.post("/api/places", requireAuth, async (c) => {
    const parsed = PlaceCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad place", issues: parsed.error.issues.slice(0, 5) }, 400);
    const b = parsed.data;
    if (!inBay(b.lat, b.lng)) return c.json({ error: "you must be in the Bay Area to add a place" }, 403);
    const pinLat = b.pinLat ?? b.lat;
    const pinLng = b.pinLng ?? b.lng;
    if (!inBay(pinLat, pinLng) || haversineKm(b.lat, b.lng, pinLat, pinLng) > PROXIMITY_KM) {
      return c.json({ error: "you have to be standing next to a place to pin it" }, 403);
    }
    const uid = c.get("user")!.id;
    let place;
    try {
      place = await repo(c).createPlace({ kindId: b.kindId, name: b.name ?? null, address: b.address ?? null, attrs: b.attrs, lat: pinLat, lng: pinLng, createdBy: uid });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "could not add that place" }, 400);
    }
    try {
      await repo(c).recordPlaceCreated(uid, place.id);
    } catch {
      /* points are a bonus, never a reason to fail the pin */
    }
    return c.json({ ok: true, place });
  });

  // Confirm / dispute / update / tip — the mechanism that keeps the map true.
  // Same gate: in the Bay, and next to the pin you're vouching for.
  app.post("/api/places/:id/report", requireAuth, async (c) => {
    const parsed = PlaceReportSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad report", issues: parsed.error.issues.slice(0, 5) }, 400);
    const b = parsed.data;
    const id = c.req.param("id");
    const r = repo(c);
    const place = await r.getPlace(id);
    if (!place) return c.json({ error: "no such place" }, 404);
    if (!inBay(b.lat, b.lng)) return c.json({ error: "you must be in the Bay Area to report on a place" }, 403);
    if (haversineKm(b.lat, b.lng, place.lat, place.lng) > PROXIMITY_KM) {
      return c.json({ error: "you have to be at the place to report on it" }, 403);
    }
    const uid = c.get("user")!.id;
    const res = await r.report(id, uid, b);
    if (b.verdict === "confirm") {
      try {
        await r.recordPlaceConfirmed(uid, id);
      } catch {
        /* points are a bonus */
      }
    }
    return c.json({ ok: true, ...res });
  });

  // Report a pin to the moderation queue. Per the house rule, a flag is a signal
  // that sorts a human's queue — it never hides anything by itself, at any count.
  app.post("/api/places/:id/flag", requireAuth, async (c) => {
    const parsed = PlaceFlagSchema.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    const id = c.req.param("id");
    const r = repo(c);
    if (!(await r.getPlace(id))) return c.json({ error: "no such place" }, 404);
    await r.flag(id, c.get("user")!.id, (parsed.success ? parsed.data.reason : undefined) ?? "other");
    return c.json({ ok: true });
  });

  /* ── the reason anyone opens this: parking for an event ───────────────────── */

  // "Where do I actually park for this?" — ranked by distance × trust × legality
  // AT THE EVENT'S START TIME, with the crowd's live difficulty tips attached.
  app.get("/api/events/:id/parking", async (c) => {
    const eventId = c.req.param("id");
    const r = repo(c);
    const event = await r.eventVenue(eventId);
    if (!event) return c.json({ error: "no such event" }, 404);
    if (event.lat == null || event.lng == null) {
      return c.json({ event, options: [], note: "this event has no coordinates yet — it hasn't been geocoded" });
    }
    const km = Number(c.req.query("km"));
    const radiusKm = Number.isFinite(km) ? Math.min(5, Math.max(0.2, km)) : PARKING_RADIUS_KM;
    const candidates = await r.nearby(event.lat, event.lng, radiusKm, { kindIds: [KIND_PARKING], at: event.startUtc });
    const ranked = rankParking(
      candidates.map((p) => ({ ...p, attrs: p.attrs as ParkingAttrs, halfLifeHours: p.kind.halfLifeHours })),
      { lat: event.lat, lng: event.lng, at: event.startUtc, radiusKm, limit: 20 },
    );
    const tips = await r.tipsFor(ranked.map((p) => p.id));
    const now = new Date();
    return c.json({
      event,
      radiusKm,
      options: ranked.map((p) => ({ ...p, difficulty: parkingDifficulty(tips.get(p.id) ?? [], now, p.kind.halfLifeHours) })),
    });
  });

  /* ── seeding the map (operator only) ──────────────────────────────────────── */

  // The DataSF importer pushes here (src/cli/import-places.ts). Bearer-gated with
  // INGEST_TOKEN like every other admin endpoint. Idempotent on `external_ref`,
  // and — per the house source convention — bad rows are skipped and counted,
  // never a reason to fail the run.
  app.post("/api/admin/places-import", requireIngestToken, async (c) => {
    const parsed = PlacesImportSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload", issues: parsed.error.issues.slice(0, 5) }, 400);
    const items = parsed.data.places.map((p) => ({
      externalRef: String(p.externalRef ?? ""),
      kindId: String(p.kindId ?? ""),
      name: p.name ?? null,
      lat: typeof p.lat === "number" ? p.lat : NaN,
      lng: typeof p.lng === "number" ? p.lng : NaN,
      address: p.address ?? null,
      attrs: (p.attrs ?? null) as Record<string, unknown> | null,
    }));
    return c.json({ ok: true, ...(await repo(c).importPlaces(items)) });
  });

  return app;
}
