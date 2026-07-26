/**
 * Standard base-32 geohash — the pure, deterministic core of the location-sharded
 * live layer ("shadows"). Used by the repo (assign a shadow to a cell), the Durable
 * Object routing (one DO per cell), and the client (which cells to subscribe to /
 * aggregate). No I/O, so it's identical on the Worker and in the browser.
 *
 * Precision ≈ cell size: p4 ≈ 39×20km, p5 ≈ 5×5km, p6 ≈ 1.2×0.6km, p7 ≈ 150×150m.
 */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export interface Bbox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/** Encode a point to a geohash of `precision` characters. */
export function encode(lat: number, lng: number, precision = 6): string {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let hash = "";
  let bit = 0;
  let bits = 0;
  let even = true; // even bits split longitude, odd bits split latitude
  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { bit = (bit << 1) | 1; lngMin = mid; } else { bit = bit << 1; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { bit = (bit << 1) | 1; latMin = mid; } else { bit = bit << 1; latMax = mid; }
    }
    even = !even;
    if (++bits === 5) {
      hash += BASE32[bit];
      bits = 0;
      bit = 0;
    }
  }
  return hash;
}

/** The lat/lng box a geohash cell covers. */
export function decodeBbox(cell: string): Bbox {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let even = true;
  for (const ch of cell) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    for (let mask = 16; mask >= 1; mask >>= 1) {
      const on = (idx & mask) !== 0;
      if (even) {
        const mid = (lngMin + lngMax) / 2;
        if (on) lngMin = mid; else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (on) latMin = mid; else latMax = mid;
      }
      even = !even;
    }
  }
  return { minLat: latMin, maxLat: latMax, minLng: lngMin, maxLng: lngMax };
}

/** The up-to-8 cells surrounding `cell` (same precision). Computed by stepping the
 *  cell's centre by ±one cell in each direction and re-encoding — simple and robust
 *  near edges (a Set de-dups any coincidences). */
export function neighbors(cell: string): string[] {
  const b = decodeBbox(cell);
  const latC = (b.minLat + b.maxLat) / 2;
  const lngC = (b.minLng + b.maxLng) / 2;
  const dLat = b.maxLat - b.minLat;
  const dLng = b.maxLng - b.minLng;
  const out = new Set<string>();
  for (const i of [-1, 0, 1]) {
    for (const j of [-1, 0, 1]) {
      if (i === 0 && j === 0) continue;
      out.add(encode(latC + i * dLat, lngC + j * dLng, cell.length));
    }
  }
  out.delete(cell);
  return [...out];
}

/** Every cell of `precision` that overlaps `bbox` — used to turn a map viewport
 *  into the set of Durable Objects to subscribe to (or coarse cells to aggregate). */
export function cellsInBbox(bbox: Bbox, precision: number): string[] {
  const probe = decodeBbox(encode(bbox.minLat, bbox.minLng, precision));
  const dLat = probe.maxLat - probe.minLat;
  const dLng = probe.maxLng - probe.minLng;
  const cells = new Set<string>();
  for (let lat = bbox.minLat; lat <= bbox.maxLat + dLat / 2; lat += dLat) {
    for (let lng = bbox.minLng; lng <= bbox.maxLng + dLng / 2; lng += dLng) {
      cells.add(encode(lat, lng, precision));
    }
  }
  return [...cells];
}
