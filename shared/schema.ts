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

/** Body the local `push` POSTs to /api/admin/scrape-report after ingesting, so
 *  production can show when it last scraped and how much it got. */
export const ScrapeReportSchema = z.object({
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  trigger: z.string().max(40).optional(),
  eventsNew: z.number().int().nonnegative(),
  eventsUpdated: z.number().int().nonnegative(),
  sources: z
    .array(
      z.object({
        sourceId: z.string().max(80),
        status: z.string().max(40),
        rawCount: z.number().int().nonnegative().optional(),
        error: z.string().max(500).optional(),
        durationMs: z.number().int().nonnegative().optional(),
      }),
    )
    .max(500)
    .optional(),
});
export type ScrapeReport = z.infer<typeof ScrapeReportSchema>;

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
export type StoryId = Brand<string, "StoryId">;
export type CommentId = Brand<string, "CommentId">;

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
export const POINTS = {
  rsvp: 5, checkin: 20, photo: 15, review: 10, host: 50, intro: 25, mentor: 15,
  // thebay.news. Submitting is worth more than commenting, and voting is worth
  // nothing — paying for votes buys you vote-farming, not signal.
  submit: 10, comment: 3,
} as const;
export type PointKind = keyof typeof POINTS;

// ── thebay.news ───────────────────────────────────────────────────────────────

/** Where a story came from. `bay` = submitted by a human here. */
export const StoryOriginSchema = z.enum(["bay", "hn", "lobsters", "rss", "event", "github", "sec", "reddit"]);
export type StoryOrigin = z.infer<typeof StoryOriginSchema>;

export const StoryKindSchema = z.enum(["link", "text", "ask", "show"]);
export type StoryKind = z.infer<typeof StoryKindSchema>;

/** A submission. A link post needs a url; ask/show/text need a body. */
export const StorySubmitSchema = z
  .object({
    kind: StoryKindSchema.default("link"),
    title: z.string().min(3).max(200),
    url: z.string().url().max(2000).optional(),
    body: z.string().max(8000).optional(),
    eventId: z.string().max(64).optional(),
  })
  .refine((s) => (s.kind === "link" ? !!s.url : !!s.body || !!s.url), {
    message: "a link post needs a url; a text/ask/show post needs a body",
    path: ["url"],
  });
export type StorySubmit = z.infer<typeof StorySubmitSchema>;

export const CommentCreateSchema = z.object({
  body: z.string().min(1).max(8000),
  parentId: z.string().max(64).optional(),
});
export type CommentCreate = z.infer<typeof CommentCreateSchema>;

/** Feed query. `src` defaults to `bay` — OUR content is the front page; the
 *  aggregator view is a deliberate choice the reader makes, not the default. */
export const NewsFeedSourceSchema = z.enum(["bay", "all", "hn", "lobsters", "rss", "event", "github", "sec", "reddit"]);
export type NewsFeedSource = z.infer<typeof NewsFeedSourceSchema>;
export const NewsSortSchema = z.enum(["hot", "new", "top", "discussed"]);
export type NewsSort = z.infer<typeof NewsSortSchema>;
export const NewsFilterSchema = z.object({
  src: NewsFeedSourceSchema.default("bay"),
  sort: NewsSortSchema.default("hot"),
  topic: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});
export type NewsFilter = z.infer<typeof NewsFilterSchema>;

/** Proof-of-presence for a write. Posting, commenting and voting on thebay.news
 *  all require the actor to be physically in the Bay (src/core/geo.inBay). */
export const GeoAttestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type GeoAttest = z.infer<typeof GeoAttestSchema>;

// ── shadows (the ephemeral, location-sharded live board) ───────────────────────

/** A fleeting drop. `thought` needs text; media kinds carry an R2 key or Stream id;
 *  `connection` tags a person you just met. Everything expires 24h after posting. */
export const ShadowKindSchema = z.enum(["thought", "photo", "voice", "video", "connection"]);
export type ShadowKindT = z.infer<typeof ShadowKindSchema>;

/** The curated reaction palette — a small fixed set (not arbitrary emoji) so the
 *  live layer reads as a shared vocabulary, not a soup. */
export const SHADOW_REACTIONS = ["🔥", "👀", "💡", "🤝", "❤️", "😯"] as const;
export const ShadowReactSchema = z.object({
  emoji: z.enum(SHADOW_REACTIONS),
  on: z.boolean().default(true), // false → remove the reaction (toggle)
});
export type ShadowReact = z.infer<typeof ShadowReactSchema>;

/** Post a shadow. The route additionally enforces the Bay GPS gate (src/core/geo)
 *  and 1-per-account (a new post replaces your old). `refine` guarantees the kind's
 *  required content is present so a media shadow can't ship with nothing to show. */
export const ShadowPostSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    kind: ShadowKindSchema.default("thought"),
    body: z.string().max(280).optional(), // text, or a caption on a media shadow
    mediaKey: z.string().max(400).optional(), // R2 key (photo / voice)
    streamId: z.string().max(200).optional(), // Cloudflare Stream id (video)
    connectionUserId: z.string().max(64).optional(), // tagged person (connection)
  })
  .refine(
    (s) => {
      switch (s.kind) {
        case "thought":
          return !!s.body && s.body.trim().length > 0;
        case "photo":
        case "voice":
          return !!s.mediaKey;
        case "video":
          return !!s.streamId;
        case "connection":
          return !!s.connectionUserId;
      }
    },
    { message: "this shadow kind needs its content (text / media / person)", path: ["kind"] },
  );
export type ShadowPost = z.infer<typeof ShadowPostSchema>;

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
