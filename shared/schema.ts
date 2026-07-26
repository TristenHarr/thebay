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
  // Shadows (the live board). A daily cast is cheap presence; a real connection you
  // made in person is the prize; a reaction received is a nudge. All dedup-keyed so
  // delete-and-repost can't farm them.
  shadow: 4, connection: 15, reaction: 2,
  // Vibes. Reading a room you actually attended is worth less than reviewing it but
  // more than a shadow — and it only pays when the check-in verifies you were there.
  vibe_report: 8,
  // The crowd city map. Pinning a resource is real work that helps strangers, so
  // it pays like a review; keeping a pin true is a tap, so it pays like a comment.
  // Both dedup-keyed on the pin — delete-and-repin can't farm them.
  place: 10, place_confirm: 3,
  // The scrape network. Turning up and completing a job is cheap presence, so it pays
  // like a daily shadow. Finding an event nobody had is the real contribution, so it
  // pays like a vibe report. Corroborating somebody else's find pays like keeping a map
  // pin true — less than discovering, but never zero, because a network where verifying
  // is unpaid stops verifying. Authoring a recipe that survives the audit is the highest
  // leverage thing a contributor can do, so it pays just under hosting.
  scrape_job: 4, scrape_find: 8, scrape_confirm: 3, recipe: 40,
} as const;
export type PointKind = keyof typeof POINTS;

// ── thebay.news ───────────────────────────────────────────────────────────────

/** Where a story came from. `bay` = submitted by a human here. */
export const StoryOriginSchema = z.enum(["bay", "hn", "lobsters", "rss", "event", "github", "sec", "reddit", "research", "fda", "crates"]);
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
export const NewsFeedSourceSchema = z.enum(["bay", "all", "hn", "lobsters", "rss", "event", "github", "sec", "reddit", "research", "fda", "crates"]);
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

// ── mobbing / movement (the Trails game) ───────────────────────────────────────
/** Who can see you move: everyone (anonymized dots), just friends, or a group/event
 *  "mob" (an IRL live-stream you dump into a place). Recorded per ping. */
export const MovementScopeSchema = z.string().max(64).regex(/^(public|friends|group:[A-Za-z0-9_-]{1,40})$/);
export const MovementPingSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  scope: MovementScopeSchema.default("public"),
});
export type MovementPing = z.infer<typeof MovementPingSchema>;

/** Collect an XP orb — the client sends the orb's self-describing id + where it is
 *  standing; the server re-derives the orb and verifies proximity before granting. */
export const OrbPickupSchema = z.object({
  orbId: z.string().max(64),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type OrbPickup = z.infer<typeof OrbPickupSchema>;

/** Scan someone's catch QR to add them to your founder Pokédex. */
export const CatchScanSchema = z.object({ token: z.string().min(8).max(80) });
export type CatchScan = z.infer<typeof CatchScanSchema>;

// ── founder crawls (planned, shareable routes) ─────────────────────────────────
export const CrawlStopSchema = z.object({ name: z.string().min(1).max(80), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
export const CrawlCreateSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  isPublic: z.boolean().optional(),
  stops: z.array(CrawlStopSchema).min(2).max(12),
});
export type CrawlCreate = z.infer<typeof CrawlCreateSchema>;
export const CrawlCheckpointSchema = z.object({ stopIdx: z.number().int().min(0).max(50), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

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

/* ─────────────────────── the scrape network (see migrations/0022) ─────────── */

/**
 * What a client can do. `residential` is conspicuously ABSENT: it is derived
 * server-side from the request's egress ASN, never claimed, because a claimed
 * capability is just a request to be given the work that needs it.
 */
export const WorkerCapabilitySchema = z.enum([
  "fetch", // plain HTTP. Every client has it.
  "browser", // a real headless browser (Playwright) — JSON-LD behind JS, infinite scroll
  "dom", // a real logged-in browser tab (the extension) — the sources that block us
]);
export type WorkerCapability = z.infer<typeof WorkerCapabilitySchema>;

export const ClientKindSchema = z.enum(["cli", "extension", "web", "app"]);

/** A GPS fix the caller asserts. Bay-bounds and proximity are checked server-side. */
export const FixSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/**
 * What the scanner captured. Not one code — a run of consecutive frames off the
 * ambassador's screen, which is what makes a screenshot or a replayed video useless
 * (see src/core/net/handshake.ts). `max(64)` because a generous camera may report
 * more frames than we require and extra evidence is welcome.
 */
export const HandshakeFrameSchema = z.object({
  step: z.number().int().nonnegative(),
  code: z.string().min(4).max(32),
});

export const NetJoinSchema = FixSchema.extend({
  sessionId: z.string().min(1).max(64),
  frames: z.array(HandshakeFrameSchema).min(2).max(64),
});

export const ClientRegisterSchema = z.object({
  kind: ClientKindSchema,
  label: z.string().max(80).optional(),
  capabilities: z.array(WorkerCapabilitySchema).max(8).default(["fetch"]),
});

export const MEMBER_TIERS = ["probation", "trusted", "core"] as const;
export type MemberTier = (typeof MEMBER_TIERS)[number];

/* ─────────────────────── ranking / the learning loop (0024) ────────────────── */

/** The ranked surfaces. Each trains its own weight vector — an event feed and a news
 *  front page have genuinely different engagement economics, and one shared model
 *  would just learn their average. */
export const RANK_SURFACES = ["events", "news", "shadows"] as const;
export const RankSurfaceSchema = z.enum(RANK_SURFACES);
export type RankSurface = z.infer<typeof RankSurfaceSchema>;

/**
 * Feedback the client is the only witness to.
 *
 * Everything else we learn from is already a row somewhere (`rsvps`, `checkins`,
 * `story_votes`, `comments`, `shadow_reactions`, `match_actions`) and is joined in by
 * the labelling job — so this endpoint deliberately carries ONLY the two signals no
 * server-side table can see.
 */
export const RankFeedbackKindSchema = z.enum(["open", "dismiss"]);
export type RankFeedbackKind = z.infer<typeof RankFeedbackKindSchema>;

export const RankFeedbackSchema = z.object({
  surface: RankSurfaceSchema,
  itemId: z.string().min(1).max(64),
  kind: RankFeedbackKindSchema,
});
export type RankFeedback = z.infer<typeof RankFeedbackSchema>;

/**
 * There is deliberately NO client-supplied impression schema.
 *
 * An impression's training value is its feature vector, and only the server knows that —
 * it is what the server scored the candidate with. A client that posted impressions could
 * only ever send ids and positions, which would log rows that are all zeros and quietly
 * poison the training set with examples that contain no signal. So impressions are
 * recorded by the serving path (`GET /api/events/foryou`), and the client's only job is
 * the feedback below, which is the one thing the server genuinely cannot observe.
 */

/** Asking for work. `max` is a hint — the coordinator's politeness budget decides. */
export const LeaseRequestSchema = z.object({
  max: z.number().int().min(1).max(10).default(3),
});

/** One fetch a client made, reported back. Weak evidence, real forensics — nobody's
 *  reputation moves on a receipt, but a Date header and a byte count are cheap to
 *  report honestly and awkward to fake consistently. */
export const ScrapeReceiptSchema = z.object({
  url: z.string().max(2000),
  status: z.number().int().min(0).max(999).optional(),
  bytes: z.number().int().nonnegative().optional(),
  serverDate: z.string().max(64).optional(),
  etag: z.string().max(200).optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
});

/**
 * What a worker submits. `RawEvent`s, NOT canonical events: the server normalises,
 * fingerprints and keys them itself, so a client cannot choose which existing event its
 * data merges into and cannot lie about a hash it never computed. Validated loosely here
 * and strictly by `RawEventSchema` per item, so one malformed entry costs one entry.
 */
export const SubmitSchema = z.object({
  leaseId: z.string().min(1).max(64),
  items: z.array(z.unknown()).max(2000),
  receipts: z.array(ScrapeReceiptSchema).max(200).optional(),
  /** The client's own digest. Compared only to spot a client bug — never scored. */
  digest: z.string().max(64).optional(),
});

/* ─────────────────────── gyms: hosts as gym leaders (0028) ────────────────── */

/**
 * How a host declares what their event pays.
 *
 *   none        — "I'm not awarding XP." A legitimate public declaration, not an absence.
 *   flat        — the same amount to everyone who verifiably showed up, prorated if the
 *                 room outgrew the budget (see core/gym/policy.ts → flatAllocation).
 *   discretion  — the host decides per person, capped by dwell and the halving ladder.
 *   bounty      — named feats at declared prices.
 */
export const GYM_MODES = ["none", "flat", "discretion", "bounty"] as const;
export const GymModeSchema = z.enum(GYM_MODES);

/** A named feat with a price. Per-event and ephemeral by design — "best demo tonight" is
 *  one host's ceremony, not a global vocabulary. */
export const GymBountySchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  xp: z.number().int().min(1).max(1000),
  badgeSlug: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const GymPolicySchema = z
  .object({
    mode: GymModeSchema,
    flatXp: z.number().int().min(0).max(1000).default(0),
    bounties: z.array(GymBountySchema).max(12).default([]),
  })
  .refine((p) => p.mode !== "flat" || p.flatXp > 0, { path: ["flatXp"], message: "a flat gym must pay something" })
  .refine((p) => p.mode !== "bounty" || p.bounties.length > 0, { path: ["bounties"], message: "a bounty gym needs at least one bounty" });

export const GymAwardSchema = z.object({
  userId: z.string().min(1).max(64),
  /** Omitted for a bounty ⇒ the bounty's declared price. */
  xp: z.number().int().min(1).max(1000).optional(),
  bountyKey: z.string().max(40).optional(),
  note: z.string().max(200).optional(),
});

/**
 * Bulk "flat to everyone". Capped at 80 rows, not 100: the D1-over-SQLite test shim
 * enforces D1's 100-bound-parameter limit and throws, and a bulk award binds several
 * parameters per row. 80 keeps the whole batch comfortably inside it.
 */
export const GymAwardBulkSchema = z.object({
  awards: z.array(GymAwardSchema).min(1).max(80),
});

/** A revoke must say why — the reason is shown to the person losing the XP. */
export const GymRevokeSchema = z.object({
  reason: z.string().min(1).max(200),
});

/** Claiming presence at the door. The secret rides in the URL fragment, never the query. */
export const PresenceClaimSchema = FixSchema.extend({
  codeId: z.string().min(1).max(64),
  secret: z.string().min(20).max(200),
});

/** A real organiser taking over a scraped event. */
export const EventClaimSchema = z.object({
  evidence: z.string().min(10).max(1000),
});

/**
 * A proposed scraper recipe. `type` must name an adapter that already exists and `params`
 * are validated by that adapter's own schema — so a recipe configures existing code and can
 * never introduce any. The host is DERIVED server-side, never accepted here: we refuse to
 * schedule what we cannot rate-limit, and letting a caller name the host would let them name
 * a budget that isn't theirs.
 */
export const RecipeProposalSchema = z.object({
  sourceId: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase id, letters/numbers/dashes"),
  type: z.string().min(1).max(40),
  params: z.record(z.string(), z.unknown()),
  windowMs: z.number().int().min(60_000).max(7 * 86_400_000).optional(),
  notes: z.string().max(500).optional(),
});

/* ──────────────── founder types + host badges (migrations/0031) ───────────── */

/**
 * What you are. The wire accepts any string rather than a fixed enum, on purpose: the
 * vocabulary lives in `founder_types` so a tenth type is a row, and the FK is what rejects a
 * made-up id. A client one deploy behind must degrade to a generic chip, not a 400.
 */
export const FounderIdentitySchema = z
  .object({
    typeId: z.string().min(1).max(32),
    type2Id: z.string().min(1).max(32).nullable().optional(),
  })
  .refine((v) => !v.type2Id || v.type2Id !== v.typeId, { path: ["type2Id"], message: "pick two different types" });

/** "Yes, they really are an investor." A tick on a card — never XP, budget or access. */
export const FounderVouchSchema = z.object({
  typeId: z.string().min(1).max(32),
  eventId: z.string().max(64).optional(),
});

/** A gym leader minting their own ceremony. No XP field — see migrations/0031's header. */
export const GymBadgeMintSchema = z.object({
  label: z.string().min(1).max(40),
  emoji: z.string().min(1).max(8),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  blurb: z.string().max(140).optional(),
});

export const GymBadgeAwardSchema = z.object({
  userId: z.string().min(1).max(64),
});
