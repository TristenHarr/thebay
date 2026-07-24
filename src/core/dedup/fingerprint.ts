import { hash128 } from "../util/hash";
import { normalizeTitle } from "../normalize/text";
import { localDay } from "../normalize/datetime";
import type { Category } from "../models/category";

/**
 * Deterministic dedup key: normalized title + local day + city. Day-granularity
 * (in the event's local zone) absorbs door-vs-start time differences that the
 * same event often carries across two sources.
 */
export function fingerprint(e: {
  title: string;
  startUtc: string;
  timezone: string;
  city: string;
}): string {
  const day = localDay(e.startUtc, e.timezone);
  return hash128(`${normalizeTitle(e.title)}|${day}|${e.city}`);
}

/** Cache key over the fields the AI/keyword tagger actually reads. */
export function contentHash(e: {
  title: string;
  description: string | null;
  organizer: string | null;
  categories: Category[];
}): string {
  return hash128(
    [
      e.title,
      e.description ?? "",
      e.organizer ?? "",
      [...e.categories].sort().join(","),
    ].join("\n"),
  );
}
