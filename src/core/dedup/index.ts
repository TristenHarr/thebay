import type { CanonicalEvent } from "../models/event";
import { localDay } from "../normalize/datetime";
import { hostOf, normalizeTitle } from "../normalize/text";
import { titleSimilarity } from "./similarity";
import { mergeEvents } from "./merge";

export { fingerprint, contentHash } from "./fingerprint";
export { mergeEvents } from "./merge";
export { titleSimilarity } from "./similarity";

const SIMILARITY_THRESHOLD = 0.85;

function sameVenue(a: CanonicalEvent, b: CanonicalEvent): boolean {
  if (!a.venueName || !b.venueName) return false;
  return normalizeTitle(a.venueName) === normalizeTitle(b.venueName);
}
function sameOrganizer(a: CanonicalEvent, b: CanonicalEvent): boolean {
  if (!a.organizer || !b.organizer) return false;
  return normalizeTitle(a.organizer) === normalizeTitle(b.organizer);
}
function sameHost(a: CanonicalEvent, b: CanonicalEvent): boolean {
  const ha = hostOf(a.url);
  const hb = hostOf(b.url);
  return !!ha && ha === hb;
}

/**
 * Two-stage dedup over a batch of freshly-normalized events:
 *  1. collapse exact fingerprint matches,
 *  2. fuzzy near-dup within each (city, local-day) bucket.
 */
export function dedupeWithinRun(events: CanonicalEvent[]): CanonicalEvent[] {
  // Stage 1: exact fingerprint.
  const byFp = new Map<string, CanonicalEvent>();
  for (const e of events) {
    const cur = byFp.get(e.fingerprint);
    byFp.set(e.fingerprint, cur ? mergeEvents(cur, e) : e);
  }

  // Stage 2: fuzzy near-dup, bounded to same city + day.
  const buckets = new Map<string, CanonicalEvent[]>();
  for (const e of byFp.values()) {
    const key = `${e.city}|${localDay(e.startUtc, e.timezone)}`;
    let arr = buckets.get(key);
    if (!arr) buckets.set(key, (arr = []));
    arr.push(e);
  }

  const result: CanonicalEvent[] = [];
  for (const bucket of buckets.values()) {
    const kept: CanonicalEvent[] = [];
    for (const e of bucket) {
      const match = kept.find(
        (m) =>
          titleSimilarity(m.title, e.title) >= SIMILARITY_THRESHOLD &&
          (sameVenue(m, e) || sameOrganizer(m, e) || sameHost(m, e)),
      );
      if (match) Object.assign(match, mergeEvents(match, e));
      else kept.push(e);
    }
    result.push(...kept);
  }
  return result;
}
