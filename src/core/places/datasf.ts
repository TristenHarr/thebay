import { inBay } from "../geo";

/**
 * DataSF (Socrata) → `places` — pure mapping, no I/O.
 *
 * The map has to be useful on day one, so it is seeded from the city's own open
 * data. Two rules shape this file:
 *
 *  1. **Dataset ids are RESOLVED AT RUNTIME, never hardcoded.** Socrata four-by-four
 *     ids change when a publisher re-publishes, and a hardcoded id that 404s is a
 *     silent empty import. `pickDataset` scores the catalog's own search results
 *     against the dataset name we're actually after.
 *  2. **Skip a bad row, never abort the run** (the house `SourceAdapter`
 *     convention, src/sources/types.ts). One meter with no coordinates must not
 *     cost us the other thirty thousand.
 *
 * Column names below were read off the live endpoints, not guessed:
 *   Parking Meters              — post_id, street_num, street_name, latitude/longitude,
 *                                 shape{Point}, cap_color, active_meter_flag
 *   Off-Street Parking (lots/garages) — globalid, objectid, the_geom{Point}, address_1,
 *                                 name2_1, g_l_1 ('G'|'L'), onehr_1, dailymax_1,
 *                                 monopen/monclose (HHMM), lotgone
 *   Street Sweeping Schedule    — blocksweepid, cnn, corridor, limits, blockside,
 *                                 weekday, fromhour, tohour, week1..week5, line{LineString}
 */

export type SocrataRow = Record<string, unknown>;

/** The item shape `POST /api/admin/places-import` accepts. */
export interface PlaceImportItem {
  externalRef: string;
  kindId: string;
  name?: string | null;
  lat: number;
  lng: number;
  address?: string | null;
  attrs?: Record<string, unknown> | null;
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
const numOf = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(str(v));
  return Number.isFinite(n) ? n : null;
};

/** "18 OTIS ST" → "18 Otis St" (DataSF shouts). */
export function titleCase(s: string): string {
  return str(s)
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

const normalize = (s: string): string => str(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface CatalogResult {
  resource?: { id?: string; name?: string };
  page_views?: { page_views_total?: number };
}

/**
 * Choose the dataset whose name best matches what we asked for. Deliberately
 * conservative: if nothing scores, return null and let the caller skip that
 * source rather than importing whatever happened to rank first (that's how you
 * end up seeding the parking layer with a revenue-transactions table).
 */
export function pickDataset(results: CatalogResult[] | null | undefined, expectName: string): { id: string; name: string } | null {
  const want = normalize(expectName);
  const wantWords = want.split(" ").filter(Boolean);
  let best: { id: string; name: string; score: number; views: number } | null = null;
  for (const r of results ?? []) {
    const id = str(r?.resource?.id);
    const name = str(r?.resource?.name);
    if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/i.test(id) || !name) continue;
    const n = normalize(name);
    let score = 0;
    if (n === want) score = 100;
    else if (n.includes(want)) score = 60;
    else if (wantWords.length && wantWords.every((w) => n.split(" ").includes(w))) score = 30;
    if (!score) continue;
    const views = numOf(r?.page_views?.page_views_total) ?? 0;
    if (!best || score > best.score || (score === best.score && views > best.views)) best = { id, name, score, views };
  }
  return best ? { id: best.id, name: best.name } : null;
}

/** Coordinates from whichever geometry shape this dataset happens to use. */
export function extractCoords(row: SocrataRow): { lat: number; lng: number } | null {
  const direct = { lat: numOf(row.latitude), lng: numOf(row.longitude) };
  if (direct.lat !== null && direct.lng !== null && inBay(direct.lat, direct.lng)) return { lat: direct.lat, lng: direct.lng };

  for (const key of ["shape", "the_geom", "point", "location", "geom", "line"]) {
    const g = row[key] as { type?: string; coordinates?: unknown } | undefined;
    const coords = g?.coordinates;
    if (!Array.isArray(coords) || !coords.length) continue;
    // Point: [lng, lat]. LineString (a swept block): use the midpoint vertex.
    const pair = typeof coords[0] === "number" ? (coords as number[]) : (coords[Math.floor(coords.length / 2)] as number[] | undefined);
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const lng = numOf(pair[0]);
    const lat = numOf(pair[1]);
    if (lat !== null && lng !== null && inBay(lat, lng)) return { lat, lng };
  }
  return null;
}

/** "500" / "2000" (HHMM) → "05:00" / "20:00". Null for 0 or junk. */
function hhmm(v: unknown): string | null {
  const n = numOf(v);
  if (n === null || n <= 0 || n > 2400) return null;
  const h = Math.floor(n / 100);
  const m = n % 100;
  if (h > 24 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "5" → "05:00" (the sweeping schedule stores whole hours). */
function hourLabel(v: unknown): string | null {
  const n = numOf(v);
  if (n === null || n < 0 || n > 24) return null;
  return `${String(Math.trunc(n)).padStart(2, "0")}:00`;
}

/**
 * A metered on-street space. Only ACTIVE, general-purpose meters: the dataset's
 * own note says active meters are `active_meter_flag` M or T, and the coloured
 * caps (red bus zone, yellow commercial loading, blue accessible) are not spaces
 * a founder looking for parking can use.
 */
export function meterToPlace(row: SocrataRow): PlaceImportItem | null {
  const postId = str(row.post_id);
  if (!postId) return null;
  const flag = str(row.active_meter_flag).toUpperCase();
  if (flag && !["M", "T"].includes(flag)) return null;
  const cap = str(row.cap_color).toLowerCase();
  if (cap && !["grey", "gray", "green", "-", "black", "silver"].includes(cap)) return null;
  const c = extractCoords(row);
  if (!c) return null;
  const street = titleCase([str(row.street_num), str(row.street_name)].filter(Boolean).join(" "));
  return {
    externalRef: `datasf:meter:${postId}`,
    kindId: "parking",
    name: street ? `${street} (meter)` : "Metered space",
    lat: c.lat,
    lng: c.lng,
    address: street || null,
    attrs: { type: "street" },
  };
}

/**
 * A garage or lot. `g_l_1` distinguishes them; `lotgone` marks a lot that no
 * longer exists (skip). Prices are dollars in this dataset — shown verbatim as a
 * hint, never computed with. Monday's hours stand in for the week (the dataset
 * carries seven pairs; the detail sheet is a hint, not a contract).
 */
export function offStreetToPlace(row: SocrataRow): PlaceImportItem | null {
  const ref = str(row.globalid) || str(row.objectid);
  if (!ref) return null;
  if ((numOf(row.lotgone) ?? 0) > 0) return null;
  const c = extractCoords(row);
  if (!c) return null;
  const address = titleCase(str(row.address_1));
  const name = titleCase(str(row.name2_1)) || address || "Off-street parking";
  const open = hhmm(row.monopen);
  const close = hhmm(row.monclose);
  const hourly = numOf(row.onehr_1);
  const daily = numOf(row.dailymax_1);
  const price = [
    hourly && hourly > 0 && hourly < 200 ? `$${hourly}/hr` : null,
    daily && daily > 0 && daily < 500 ? `$${daily}/day` : null,
  ].filter(Boolean).join(" · ");
  const attrs: Record<string, unknown> = { type: str(row.g_l_1).toUpperCase() === "L" ? "lot" : "garage" };
  if (open && close) attrs.hours = `${open}-${close}`;
  if (price) attrs.priceHint = price;
  return {
    externalRef: `datasf:offstreet:${ref}`,
    kindId: "parking",
    name,
    lat: c.lat,
    lng: c.lng,
    address: address || null,
    attrs,
  };
}

/**
 * A swept block-side. This is the row that makes `canIParkHere` genuinely useful:
 * the weekday, the window and the weeks-of-month it actually runs, which is
 * exactly what "Legal for 2h 15m, then street sweeping" is computed from.
 */
export function sweepingToPlace(row: SocrataRow): PlaceImportItem | null {
  const ref = str(row.blocksweepid) || str(row.cnn);
  if (!ref) return null;
  const from = hourLabel(row.fromhour);
  const to = hourLabel(row.tohour);
  const weekday = str(row.weekday);
  if (!from || !to || !weekday || from === to) return null;
  const c = extractCoords(row);
  if (!c) return null;
  const weeks = [1, 2, 3, 4, 5].filter((n) => (numOf(row[`week${n}`]) ?? 0) > 0);
  const corridor = titleCase(str(row.corridor));
  const limits = str(row.limits).replace(/\s+/g, " ").trim();
  const side = titleCase(str(row.blockside));
  const attrs: Record<string, unknown> = { type: "street", sweepDay: weekday, sweepWindow: `${from}-${to}` };
  // Absent ⇒ every week, so only record a partial schedule.
  if (weeks.length && weeks.length < 5) attrs.sweepWeeks = weeks;
  return {
    externalRef: `datasf:sweep:${ref}`,
    kindId: "parking",
    name: [corridor || "Street parking", side ? `${side} side` : null].filter(Boolean).join(" · "),
    lat: c.lat,
    lng: c.lng,
    address: limits ? `${corridor} between ${limits}` : corridor || null,
    attrs,
  };
}

export interface DataSfSource {
  key: string;
  /** What we send to the Socrata catalog search. */
  query: string;
  /** The dataset name we expect back — `pickDataset` scores against this. */
  expectName: string;
  map: (row: SocrataRow) => PlaceImportItem | null;
}

/** The three datasets that make the parking layer real. */
export const DATASF_SOURCES: DataSfSource[] = [
  { key: "meters", query: "parking meters", expectName: "Parking Meters", map: meterToPlace },
  { key: "offstreet", query: "off-street parking locations lots garages", expectName: "Off-Street Parking Locations", map: offStreetToPlace },
  { key: "sweeping", query: "street sweeping schedule", expectName: "Street Sweeping Schedule", map: sweepingToPlace },
];

/** Map a page of rows, counting (not throwing on) the ones we can't use. */
export function mapRows(source: DataSfSource, rows: SocrataRow[]): { items: PlaceImportItem[]; skipped: number } {
  const items: PlaceImportItem[] = [];
  let skipped = 0;
  for (const row of rows ?? []) {
    let item: PlaceImportItem | null = null;
    try {
      item = source.map(row);
    } catch {
      item = null; // a single malformed row is never a reason to abort the run
    }
    if (item) items.push(item);
    else skipped++;
  }
  return { items, skipped };
}
