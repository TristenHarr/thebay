import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRepository } from "../storage";
import type { CanonicalEvent } from "../core/models/event";
import { inBay } from "../core/geo";

const CACHE = resolve(process.cwd(), "data/geocode-cache.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Location key so we geocode each distinct venue once, ever. */
const keyOf = (e: CanonicalEvent) => `${(e.venueName || "").trim()}|${(e.address || "").trim()}|${e.city}`.toLowerCase();

/** A clean geocoder query: prefer a street address, strip phone/suite/floor noise
 *  that wrecks matching, else fall back to the venue name. Photon is Bay-biased. */
function buildQuery(e: CanonicalEvent): string {
  const a = (e.address || "")
    .replace(/ph\s*no.*$/i, "")
    .replace(/\b(suite|ste|#|fl(oor)?|unit)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/,\s*$/, "");
  const base = a && /\d/.test(a) ? a : (e.venueName || a || "").trim();
  return base.replace(/\s+/g, " ") + ", CA";
}

// `inBay` (shared with the bulletin board + itinerary) rejects matches outside the
// greater Bay Area — a generic query can otherwise resolve to another state.

/** One geocoding lookup via Photon (komoot's free OSM geocoder — no key, lenient
 *  rate limit), biased toward the Bay. Returns null on miss / out-of-bounds. */
async function geocode(query: string): Promise<{ lat: number; lng: number } | null> {
  const url = `https://photon.komoot.io/api?limit=1&lang=en&lat=37.6&lon=-122.3&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: { "user-agent": "thebay.events/1.0 (hello@thebay.events)" } });
    if (!res.ok) return null;
    const j = (await res.json()) as { features?: Array<{ geometry?: { coordinates?: [number, number] } }> };
    const c = j.features?.[0]?.geometry?.coordinates;
    if (!Array.isArray(c) || c.length < 2) return null;
    const [lng, lat] = c;
    return inBay(lat, lng) ? { lat, lng } : null;
  } catch {
    return null;
  }
}

/** `eventers geocode` — backfill upcoming-event coordinates, cached + rate-limited,
 *  then push them to the live D1 via /api/admin/geocode so the map has real pins. */
export async function geocodeCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { url: { type: "string" }, token: { type: "string" }, days: { type: "string" }, limit: { type: "string" } },
    allowPositionals: true,
  });
  const baseUrl = (values.url as string) || process.env.INGEST_URL || "http://localhost:8787";
  const token = (values.token as string) || process.env.INGEST_TOKEN;
  const days = Number(values.days || 45);
  const limit = Number(values.limit || 200); // cap new lookups per run (Nominatim is ~1/s)

  const cache: Record<string, { lat: number; lng: number } | null> = existsSync(CACHE)
    ? JSON.parse(readFileSync(CACHE, "utf8"))
    : {};

  const repo = createRepository();
  let events: CanonicalEvent[];
  try {
    const res = await repo.queryEvents({
      from: new Date().toISOString(),
      to: new Date(Date.now() + days * 86400000).toISOString(),
      limit: 100_000,
      sort: "start",
    });
    events = res.events;
  } finally {
    repo.close();
  }

  // distinct geocodable locations, most-common first
  const buckets = new Map<string, { e: CanonicalEvent; count: number }>();
  for (const e of events) {
    if (!e.venueName && !e.address) continue;
    const k = keyOf(e);
    const b = buckets.get(k);
    if (b) b.count++;
    else buckets.set(k, { e, count: 1 });
  }
  const todo = [...buckets.entries()].filter(([k]) => !(k in cache)).sort((a, b) => b[1].count - a[1].count).slice(0, limit);
  console.log(`${buckets.size} distinct venues (${events.length} upcoming events); geocoding ${todo.length} new (cached: ${Object.keys(cache).length})…`);

  let done = 0;
  for (const [k, { e }] of todo) {
    cache[k] = await geocode(buildQuery(e));
    done++;
    if (done % 25 === 0) { console.log(`  …${done}/${todo.length}`); mkdirSync(resolve(process.cwd(), "data"), { recursive: true }); writeFileSync(CACHE, JSON.stringify(cache)); }
    await sleep(800); // polite pacing for Photon
  }
  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache));

  // map every event onto its cached coords
  const items: Array<{ id: string; lat: number; lng: number }> = [];
  for (const e of events) {
    if (!e.venueName && !e.address) continue;
    const c = cache[keyOf(e)];
    if (c) items.push({ id: e.id, lat: c.lat, lng: c.lng });
  }
  console.log(`${items.length} events have coordinates.`);

  if (!token) { console.log("No token — set --token / INGEST_TOKEN to push coords to the live map."); return; }
  const url = baseUrl.replace(/\/+$/, "") + "/api/admin/geocode";
  let pushed = 0;
  for (let i = 0; i < items.length; i += 500) {
    const slice = items.slice(i, i + 500);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ items: slice }),
        });
        if (res.ok) { pushed += slice.length; break; }
      } catch {
        /* transient network error — retry */
      }
      await sleep(1000);
    }
  }
  console.log(`Pushed coordinates for ${pushed} events → ${baseUrl}`);
}
