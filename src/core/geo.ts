/**
 * Bay Area geography — the single source of truth for "is this in the Bay?".
 * Used by the geocoder (reject out-of-region matches), the map bulletin board
 * (GPS gate for posting), and any itinerary/location logic. Pure, no I/O.
 */
export const BAY_BOUNDS = { minLat: 36.4, maxLat: 38.9, minLng: -123.6, maxLng: -121.0 } as const;

export function inBay(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat > BAY_BOUNDS.minLat && lat < BAY_BOUNDS.maxLat &&
    lng > BAY_BOUNDS.minLng && lng < BAY_BOUNDS.maxLng
  );
}
