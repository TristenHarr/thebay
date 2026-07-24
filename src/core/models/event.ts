import { z } from "zod";
import type { Category } from "./category";

/**
 * RawEvent — what a source adapter emits before normalization. Loosely typed
 * on purpose: adapters map wildly different payloads onto this shape, and the
 * pipeline validates + normalizes downstream.
 */
export const RawEventSchema = z.object({
  sourceId: z.string(),
  sourceType: z.string(),
  externalId: z.string().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  startRaw: z.union([z.string(), z.date()]),
  endRaw: z.union([z.string(), z.date()]).optional(),
  timezoneHint: z.string().optional(),
  venueName: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  url: z.string().min(1),
  organizer: z.string().optional(),
  isFree: z.boolean().optional(),
  priceText: z.string().optional(),
  imageUrl: z.string().optional(),
  raw: z.unknown().optional(),
});
export type RawEvent = z.infer<typeof RawEventSchema>;

export interface EventSourceRef {
  sourceId: string;
  sourceType: string;
  externalId?: string;
  url: string;
}

export type TagSource = "ai" | "keyword" | null;

/**
 * CanonicalEvent — the normalized, deduped, stored form.
 */
export interface CanonicalEvent {
  id: string; // ULID
  fingerprint: string;
  title: string;
  description: string | null;
  startUtc: string; // ISO-8601 UTC
  endUtc: string | null;
  timezone: string; // IANA
  venueName: string | null;
  address: string | null;
  city: string; // resolved city id, or "unknown"
  url: string;
  organizer: string | null;
  isFree: boolean | null;
  priceText: string | null;
  imageUrl: string | null;
  latitude?: number | null; // geocoded (M6); optional so pre-geocode events are valid
  longitude?: number | null;

  categories: Category[];
  interestScore: number | null; // 0-100
  interestReason: string | null;
  tagSource: TagSource;
  contentHash: string; // hash of tag-relevant fields (cache key)
  taggedHash: string | null; // contentHash at the time it was last tagged

  sources: EventSourceRef[]; // provenance across dedup merges
  firstSeenAt: string;
  lastSeenAt: string;
  starred: boolean;
  hidden: boolean;
}
