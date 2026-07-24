/**
 * Shared zod schemas — the single source of truth for data shapes crossing the
 * Worker⇄client (and Worker⇄local-scraper) boundary. Types are DERIVED from these
 * schemas, and every request/response is validated against them, so malformed
 * data can never reach a handler. This is the primary "pit of success" mechanism.
 *
 * (M0 covers the Event/ingest shapes; user/social schemas land alongside their
 * milestones.)
 */
import { z } from "zod";

export const EventSourceRefSchema = z.object({
  sourceId: z.string(),
  sourceType: z.string(),
  externalId: z.string().optional(),
  url: z.string(),
});

/** The canonical stored event, exactly as the local pipeline computes it. */
export const CanonicalEventSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  title: z.string().min(1),
  description: z.string().nullable(),
  startUtc: z.string(),
  endUtc: z.string().nullable(),
  timezone: z.string(),
  venueName: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string(),
  url: z.string(),
  organizer: z.string().nullable(),
  isFree: z.boolean().nullable(),
  priceText: z.string().nullable(),
  imageUrl: z.string().nullable(),
  categories: z.array(z.string()),
  interestScore: z.number().nullable(),
  interestReason: z.string().nullable(),
  tagSource: z.enum(["ai", "keyword"]).nullable(),
  contentHash: z.string(),
  taggedHash: z.string().nullable(),
  sources: z.array(EventSourceRefSchema),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  starred: z.boolean(),
  hidden: z.boolean(),
});

/** Body the local scraper POSTs to /api/admin/ingest. */
export const IngestPayloadSchema = z.object({
  events: z.array(CanonicalEventSchema).min(1).max(5000),
});
export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

/** Body the local geocoder POSTs to /api/admin/geocode (backfills event coords). */
export const GeocodePayloadSchema = z.object({
  items: z.array(z.object({ id: z.string(), lat: z.number(), lng: z.number() })).min(1).max(2000),
});

/* ─────────────────────────── identity & social ─────────────────────────── */

// Branded IDs — a UserId can never be passed where an EventId is expected.
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type UserId = Brand<string, "UserId">;
export type EventId = Brand<string, "EventId">;
export type GroupId = Brand<string, "GroupId">;

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  handle: z.string(),
  displayName: z.string(),
  avatarKey: z.string().nullable(),
  bio: z.string().nullable(),
  homeCity: z.string().nullable(),
  socialEnabled: z.boolean(),
  createdAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;

/** What other users may see — never the email. */
export const PublicProfileSchema = UserSchema.omit({ email: true });
export type PublicProfile = z.infer<typeof PublicProfileSchema>;

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

export const ProfileUpdateSchema = z.object({
  displayName: z.string().min(1).max(60).optional(),
  handle: z.string().regex(HANDLE_RE).optional(),
  bio: z.string().max(300).nullable().optional(),
  homeCity: z.string().max(60).nullable().optional(),
  socialEnabled: z.boolean().optional(),
});
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;

export const RsvpStatusSchema = z.enum(["going", "interested", "went", "none"]);
export type RsvpStatus = z.infer<typeof RsvpStatusSchema>;
export const RsvpBodySchema = z.object({ status: RsvpStatusSchema });

export const ReviewBodySchema = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().max(2000).optional(),
});

export const GroupCreateSchema = z.object({
  name: z.string().min(1).max(80),
  eventId: z.string().optional(),
});
export const MessageBodySchema = z.object({ body: z.string().min(1).max(2000) });

export const HostEventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  startUtc: z.string(),
  endUtc: z.string().optional(),
  venueName: z.string().max(200).optional(),
  address: z.string().max(300).optional(),
  city: z.string().max(60).optional(),
  url: z.string().url().optional(),
  imageUrl: z.string().url().optional(),
  isFree: z.boolean().optional(),
  priceText: z.string().max(100).optional(),
  categories: z.array(z.string()).max(8).optional(),
});
export type HostEvent = z.infer<typeof HostEventSchema>;

/** Points economy — server is the sole authority; each kind has a fixed value. */
export const POINTS = { rsvp: 5, checkin: 20, photo: 15, review: 10, host: 50, intro: 25, mentor: 15 } as const;
export type PointKind = keyof typeof POINTS;

/* ─────────────────────────── founder graph ───────────────────────────────── */

export const IntroRequestSchema = z.object({
  targetDesc: z.string().min(1).max(200),
  targetUserId: z.string().optional(),
});
export const MentorProfileSchema = z.object({
  topics: z.array(z.string().max(40)).max(12),
  availability: z.string().max(120).optional(),
  blurb: z.string().max(500).optional(),
  active: z.boolean().optional(),
});
export const MentorRequestSchema = z.object({ mentorId: z.string(), message: z.string().max(500).optional() });
export const MatchPrefsSchema = z.object({
  hasIdea: z.boolean().optional(),
  technical: z.boolean().optional(),
  commitment: z.string().max(40).optional(),
  radiusKm: z.number().int().positive().max(20000).optional(),
  interests: z.array(z.string().max(40)).max(20).optional(),
  looking: z.boolean().optional(),
});
export const MatchActionSchema = z.object({ action: z.enum(["invite", "save", "skip", "hide"]) });
export const CommunityCreateSchema = z.object({ name: z.string().min(1).max(80), kind: z.string().max(40).optional() });

/* ─────────────────────────── goals, check-in, review-gate ─────────────────── */

export const GoalVisibility = z.enum(["private", "friends", "public"]);
export const GoalCreateSchema = z.object({
  kind: z.enum(["overall", "event"]),
  eventId: z.string().optional(),
  title: z.string().min(1).max(140),
  metric: z.string().max(60).optional(),
  target: z.number().int().positive().optional(),
  visibility: GoalVisibility.optional(),
});
export const GoalUpdateSchema = z.object({
  title: z.string().min(1).max(140).optional(),
  status: z.enum(["active", "done", "archived"]).optional(),
  progress: z.number().int().min(0).optional(),
  visibility: GoalVisibility.optional(),
});
export const CheckinSchema = z.object({ token: z.string().min(1) });
/** Quick event-review survey (≤ a few taps). */
export const EventReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().max(2000).optional(),
});
