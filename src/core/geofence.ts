/**
 * Geo/time-fenced media suggestion (pure). Given the events a user RSVP'd to and a
 * photo/video's location + capture time, suggest the event it most likely belongs
 * to — "these look like they're from Founders Gathering, attach?". No I/O.
 */

export interface FenceEvent {
  id: string;
  startUtc: string;
  endUtc?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}
export interface MediaPoint {
  lat: number | null | undefined;
  lng: number | null | undefined;
  takenAt: string;
}

const RADIUS_KM = 1.5; // "at the venue"
const PRE_MS = 2 * 3600 * 1000; // arrive up to 2h early
const POST_MS = 3 * 3600 * 1000; // linger up to 3h after

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** The best matching event (nearest in space among time-overlapping venues), or null. */
export function suggestEventForMedia(events: FenceEvent[], m: MediaPoint): FenceEvent | null {
  if (m.lat == null || m.lng == null) return null;
  const t = Date.parse(m.takenAt);
  if (Number.isNaN(t)) return null;

  let best: FenceEvent | null = null;
  let bestKm = Infinity;
  for (const e of events) {
    if (e.latitude == null || e.longitude == null) continue;
    const start = Date.parse(e.startUtc);
    const end = e.endUtc ? Date.parse(e.endUtc) : start + 4 * 3600 * 1000;
    if (t < start - PRE_MS || t > end + POST_MS) continue;
    const km = haversineKm(m.lat, m.lng, e.latitude, e.longitude);
    if (km <= RADIUS_KM && km < bestKm) {
      best = e;
      bestKm = km;
    }
  }
  return best;
}
