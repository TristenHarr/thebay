import { ulid } from "ulid";
import type { RawEvent, CanonicalEvent, EventSourceRef } from "../models/event";
import { type CityDef, UNKNOWN_CITY } from "../models/source";
import { resolveTimes } from "./datetime";
import { cleanText, escapeRegExp } from "./text";
import { fingerprint, contentHash } from "../dedup/fingerprint";

interface CityMatcher {
  id: string;
  timezone: string;
  re: RegExp;
}

export type Normalizer = (raw: RawEvent, now: Date) => CanonicalEvent | null;

/**
 * Build a normalizer bound to a set of cities. Precompiles alias matchers so
 * per-event city resolution is cheap.
 */
export function createNormalizer(cities: CityDef[]): Normalizer {
  const matchers: CityMatcher[] = cities.map((c) => {
    const terms = [c.label, ...c.aliases]
      .filter(Boolean)
      .map(escapeRegExp)
      .sort((a, b) => b.length - a.length);
    return {
      id: c.id,
      timezone: c.timezone,
      re: new RegExp(`\\b(${terms.join("|")})\\b`, "i"),
    };
  });
  const defaultTz = cities[0]?.timezone ?? "UTC";

  function resolveCity(
    ...texts: (string | undefined | null)[]
  ): { id: string; timezone: string } | null {
    const hay = texts.filter(Boolean).join(" · ");
    if (!hay) return null;
    for (const m of matchers) if (m.re.test(hay)) return { id: m.id, timezone: m.timezone };
    return null;
  }

  return (raw, now): CanonicalEvent | null => {
    const title = cleanText(raw.title);
    if (!title || !raw.url) return null;

    const city = resolveCity(raw.city, raw.address, raw.venueName);
    const cityId = city?.id ?? UNKNOWN_CITY;
    const cityTz = city?.timezone ?? defaultTz;

    const times = resolveTimes({
      startRaw: raw.startRaw,
      endRaw: raw.endRaw ?? null,
      timezoneHint: raw.timezoneHint ?? null,
      cityTimezone: cityTz,
    });
    if (!times) return null;

    const nowIso = now.toISOString();
    const description = cleanText(raw.description ?? null);
    const organizer = cleanText(raw.organizer ?? null);

    const ref: EventSourceRef = {
      sourceId: raw.sourceId,
      sourceType: raw.sourceType,
      externalId: raw.externalId,
      url: raw.url,
    };

    const categories: string[] = [];
    const event: CanonicalEvent = {
      id: ulid(),
      fingerprint: "",
      title,
      description,
      startUtc: times.startUtc,
      endUtc: times.endUtc,
      timezone: times.timezone,
      venueName: cleanText(raw.venueName ?? null),
      address: cleanText(raw.address ?? null),
      city: cityId,
      url: raw.url,
      organizer,
      isFree: raw.isFree ?? null,
      priceText: cleanText(raw.priceText ?? null),
      imageUrl: raw.imageUrl ?? null,
      categories,
      interestScore: null,
      interestReason: null,
      tagSource: null,
      contentHash: "",
      taggedHash: null,
      sources: [ref],
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      starred: false,
      hidden: false,
    };

    event.fingerprint = fingerprint({
      title: event.title,
      startUtc: event.startUtc,
      timezone: event.timezone,
      city: event.city,
    });
    event.contentHash = contentHash({
      title: event.title,
      description: event.description,
      organizer: event.organizer,
      categories: event.categories,
    });
    return event;
  };
}
