/**
 * Outbound link builders for the itinerary — turn an event into every useful
 * link a founder needs to actually get there and make a day of it: directions,
 * transit, rideshare, parking, food & things nearby, and the event's own site.
 * Pure functions, unit-tested. This is the "Bay Area bulletin board" wiring.
 */
export interface EventLike {
  title: string;
  venueName?: string | null;
  address?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  url?: string | null;
  organizer?: string | null;
}

const enc = encodeURIComponent;

/** Best location string for maps: prefer a human address, else coords. */
export function locationQuery(e: EventLike): string {
  const parts = [e.venueName, e.address, e.city].filter(Boolean).join(", ");
  if (parts) return parts;
  if (e.latitude != null && e.longitude != null) return `${e.latitude},${e.longitude}`;
  return e.title;
}
function destParam(e: EventLike): string {
  if (e.latitude != null && e.longitude != null) return `${e.latitude},${e.longitude}`;
  return locationQuery(e);
}

export function mapLink(e: EventLike): string {
  return `https://www.google.com/maps/search/?api=1&query=${enc(locationQuery(e))}`;
}
export function directionsLink(e: EventLike, mode: "transit" | "driving" | "walking" | "bicycling" = "transit"): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${enc(destParam(e))}&travelmode=${mode}`;
}
export function rideshareLinks(e: EventLike): { uber: string; lyft: string } {
  if (e.latitude != null && e.longitude != null) {
    return {
      uber: `https://m.uber.com/ul/?action=setPickup&dropoff[latitude]=${e.latitude}&dropoff[longitude]=${e.longitude}&dropoff[nickname]=${enc(e.venueName || e.title)}`,
      lyft: `https://lyft.com/ride?id=lyft&destination[latitude]=${e.latitude}&destination[longitude]=${e.longitude}`,
    };
  }
  return { uber: "https://m.uber.com/", lyft: "https://www.lyft.com/rider" };
}
export function parkingLink(e: EventLike): string {
  return `https://www.google.com/maps/search/?api=1&query=${enc(`parking near ${e.venueName || locationQuery(e)}`)}`;
}
export function foodNearbyLink(e: EventLike): string {
  return `https://www.google.com/maps/search/?api=1&query=${enc(`restaurants near ${e.venueName || locationQuery(e)}`)}`;
}
export function thingsNearbyLink(e: EventLike): string {
  return `https://www.google.com/maps/search/?api=1&query=${enc(`things to do near ${e.venueName || locationQuery(e)}`)}`;
}

/** Bay Area transit hub — the always-useful links, independent of a single event. */
export const BAY_TRANSIT: { name: string; url: string }[] = [
  { name: "511 Bay Area", url: "https://511.org/" },
  { name: "BART", url: "https://www.bart.gov/planner" },
  { name: "Caltrain", url: "https://www.caltrain.com/schedules" },
  { name: "Muni", url: "https://www.sfmta.com/getting-around" },
  { name: "Clipper", url: "https://www.clippercard.com/" },
];

/** Everything for one event, as labeled link chips (destination / transport / eat / do / event). */
export function eventLinks(e: EventLike): { section: "Destination" | "Transport" | "Eat & do" | "Event"; label: string; url: string }[] {
  const ride = rideshareLinks(e);
  const out: { section: any; label: string; url: string }[] = [
    { section: "Destination", label: "📍 Map", url: mapLink(e) },
    { section: "Transport", label: "🚆 Transit", url: directionsLink(e, "transit") },
    { section: "Transport", label: "🚗 Drive", url: directionsLink(e, "driving") },
    { section: "Transport", label: "🅿️ Parking", url: parkingLink(e) },
    { section: "Transport", label: "🚕 Uber", url: ride.uber },
    { section: "Transport", label: "Lyft", url: ride.lyft },
    { section: "Eat & do", label: "🍽 Food nearby", url: foodNearbyLink(e) },
    { section: "Eat & do", label: "✨ Things to do", url: thingsNearbyLink(e) },
  ];
  if (e.url) out.push({ section: "Event", label: "🔗 Event page", url: e.url });
  return out;
}
