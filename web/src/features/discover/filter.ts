/**
 * Pure filtering logic for Discover — extracted so the world's-best filtering is
 * unit-testable with a fixed `now` (no clock flakiness). The component wires these
 * to React state; the math lives here.
 */
export type DateKey = "today" | "weekend" | "7d" | "30d" | "upcoming" | "all";
export type TimeKey = "any" | "morning" | "afternoon" | "evening";
export const DAY = 86400000;

/** Does an event fall inside the selected date window (or explicit trip range)? */
export function inDateWindow(startUtc: string, key: DateKey, trip: { from: string; to: string } | null, now: number = Date.now()): boolean {
  const t = new Date(startUtc).getTime();
  if (trip) return t >= new Date(trip.from).getTime() && t <= new Date(trip.to).getTime() + DAY;
  if (key === "all") return true;
  if (t < now - 6 * 3600000) return false; // hide events that ended >6h ago
  if (key === "upcoming") return true;
  if (key === "today") return t <= now - (now % DAY) + DAY;
  if (key === "7d") return t <= now + 7 * DAY;
  if (key === "30d") return t <= now + 30 * DAY;
  if (key === "weekend") {
    const day = new Date(startUtc).getDay();
    return (day === 5 || day === 6 || day === 0) && t <= now + 9 * DAY;
  }
  return true;
}

/** Bucket an event's local start hour into a coarse time-of-day. */
export function timeOfDay(startUtc: string, tz: string): TimeKey {
  try {
    const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date(startUtc)));
    if (h < 12) return "morning";
    if (h < 17) return "afternoon";
    return "evening";
  } catch {
    return "any";
  }
}

export interface FilterState {
  date: DateKey;
  time: TimeKey;
  cats: Set<string>;
  q: string;
  free: boolean;
  trip: { from: string; to: string } | null;
}

/** Apply every facet except the category chips (used for live facet counts). */
export function baseFilter(events: any[], s: Omit<FilterState, "cats">, now: number = Date.now()): any[] {
  const terms = s.q.trim() ? s.q.toLowerCase().split(/\s+/) : [];
  return events.filter((e) => {
    if (!inDateWindow(e.startUtc, s.date, s.trip, now)) return false;
    if (s.time !== "any" && timeOfDay(e.startUtc, e.timezone) !== s.time) return false;
    if (s.free && e.isFree !== true) return false;
    if (terms.length) {
      const hay = `${e.title} ${e.organizer || ""} ${e.venueName || ""} ${e.description || ""}`.toLowerCase();
      if (!terms.every((term) => hay.includes(term))) return false;
    }
    return true;
  });
}

/** Category facet counts over an already base-filtered list, most-common first. */
export function categoryCounts(events: any[]): [string, number][] {
  const m = new Map<string, number>();
  for (const e of events) for (const c of e.categories || []) m.set(c, (m.get(c) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Curated founder/AI communities we let people browse by source id → display name.
 *  (Only these get a chip; the broad Eventbrite/Meetup/discover sweeps don't.) */
export const COMMUNITY_LABELS: Record<string, string> = {
  "cerebral-valley": "Cerebral Valley",
  "luma-yc": "Y Combinator",
  "luma-agihouse": "AGI House",
  "luma-frontiertower": "Frontier Tower",
  "luma-spc": "South Park Commons",
  "luma-shack15": "SHACK15",
  "luma-foundersinc": "Founders Inc",
};

/** How many events each curated community has, over an already base-filtered list.
 *  An event counts once per community even if that community appears twice in its
 *  merged sources. Most-common first. */
export function communityCounts(events: any[]): [string, number][] {
  const m = new Map<string, number>();
  for (const e of events) {
    const seen = new Set<string>();
    for (const s of e.sources || []) {
      const id = s?.sourceId;
      if (id && COMMUNITY_LABELS[id] && !seen.has(id)) {
        seen.add(id);
        m.set(id, (m.get(id) || 0) + 1);
      }
    }
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Final list: apply category + community filters (OR within each) + sort. */
export function applyCategoryAndSort(base: any[], cats: Set<string>, sort: "soonest" | "interesting", communities?: Set<string>): any[] {
  let r = cats.size ? base.filter((e) => (e.categories || []).some((c: string) => cats.has(c))) : base;
  if (communities && communities.size) r = r.filter((e) => (e.sources || []).some((s: any) => communities.has(s?.sourceId)));
  return [...r].sort((a, b) => (sort === "interesting" ? (b.interestScore ?? -1) - (a.interestScore ?? -1) : String(a.startUtc).localeCompare(String(b.startUtc))));
}
