import type { CanonicalEvent } from "../models/event";
import { UNKNOWN_CITY } from "../models/source";
import { contentHash } from "./fingerprint";

/** Prefer a non-null, longer value. */
function richer(a: string | null, b: string | null): string | null {
  if (!b) return a;
  if (!a) return b;
  return b.length > a.length ? b : a;
}

function minIso(a: string, b: string): string {
  return a <= b ? a : b;
}
function maxIso(a: string, b: string): string {
  return a >= b ? a : b;
}

/**
 * Merge `incoming` into `existing`, keeping the existing identity, user flags,
 * and any tags. Deterministic and idempotent so re-runs converge. `contentHash`
 * is recomputed from the merged content so a materially richer description
 * flags the event for re-tagging.
 */
export function mergeEvents(
  existing: CanonicalEvent,
  incoming: CanonicalEvent,
): CanonicalEvent {
  const sources = [...existing.sources];
  for (const s of incoming.sources) {
    if (!sources.some((x) => x.sourceId === s.sourceId && x.url === s.url)) {
      sources.push(s);
    }
  }

  const categories = Array.from(
    new Set([...existing.categories, ...incoming.categories]),
  );

  const merged: CanonicalEvent = {
    ...existing,
    description: richer(existing.description, incoming.description),
    endUtc: existing.endUtc ?? incoming.endUtc,
    venueName: existing.venueName ?? incoming.venueName,
    address: richer(existing.address, incoming.address),
    organizer: existing.organizer ?? incoming.organizer,
    imageUrl: existing.imageUrl ?? incoming.imageUrl,
    isFree: existing.isFree ?? incoming.isFree,
    priceText: existing.priceText ?? incoming.priceText,
    city: existing.city !== UNKNOWN_CITY ? existing.city : incoming.city,
    timezone:
      existing.city !== UNKNOWN_CITY ? existing.timezone : incoming.timezone,
    categories,
    sources,
    firstSeenAt: minIso(existing.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: maxIso(existing.lastSeenAt, incoming.lastSeenAt),
    starred: existing.starred || incoming.starred,
    hidden: existing.hidden,
  };

  merged.contentHash = contentHash(merged);
  return merged;
}
