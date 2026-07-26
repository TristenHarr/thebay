import type { D1Database, KVNamespace, R2Bucket, DurableObjectNamespace } from "@cloudflare/workers-types";
import type { User } from "../../shared/schema";

/** All Worker bindings + secrets. Secrets are optional so the Worker boots even
 *  before they're configured (auth routes degrade to a clear error). */
export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  OAUTH_STATE: KVNamespace;
  PHOTOS: R2Bucket;
  GROUP_ROOM: DurableObjectNamespace;
  /** thebay.news only: one realtime room per story (presence + comment fan-out).
   *  Typed with global fetch signatures for the same reason ASSETS is — the
   *  workers-types Request/Response clash with the globals otherwise. */
  NEWS_ROOM?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  /** Shadows: one realtime Durable Object per geohash cell (live fan-out + per-cell
   *  expiry). Optional so the Worker + tests boot without it — the HTTP API (D1) is
   *  the durable backstop, so shadows render even if the realtime layer is absent. */
  SHADOW_CELL?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  // Static assets. Global fetch signature to avoid the workers-types Fetcher clash.
  ASSETS: { fetch(request: Request): Promise<Response> };

  INGEST_TOKEN?: string;
  /** HMAC key for the scrape network's animated in-person handshake
   *  (src/core/net/handshake.ts). Frame codes are derived from it, never stored, so
   *  rotating it only invalidates sessions in flight (they live 30 seconds).
   *  Absent ⇒ /api/net/invite and /api/net/join 503: joining is the one thing that
   *  must not degrade to a weaker check when a secret is missing. */
  HANDSHAKE_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string; // magic-link email (optional; Cloudflare Email is an alt)
  EMAIL_FROM?: string;
  DEV_LOGIN?: string; // "1" enables the passwordless dev login (local/testing only)
  PUBLIC_ORIGIN?: string; // e.g. https://thebay.events (canonical for long-lived URLs)
  // thebay.news — the sibling Worker shares this Env shape and these bindings.
  /** Comma-separated handles allowed to moderate thebay.news. Config, not a
   *  DB column, so privilege can't be escalated by an application bug. */
  ADMIN_HANDLES?: string;
  /** Reddit OAuth (free "script" app). Absent = the Reddit source is skipped. */
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  NEWS_ORIGIN?: string; // e.g. https://thebay.news (canonical for rel=canonical/OG/sitemap)
  EVENTS_ORIGIN?: string; // where the news site links back to for events
  // Cloudflare Access (Zero Trust) login
  ACCESS_TEAM_DOMAIN?: string; // e.g. thebay.cloudflareaccess.com
  ACCESS_AUD?: string; // the Access application's AUD tag
  /** Optional stronger model for shadow moderation. Absent ⇒ Workers AI (env.AI)
   *  handles it; absent too ⇒ the deterministic hard-screen is the only gate. */
  OPENROUTER_MODERATION_KEY?: string;
  OPENROUTER_MODERATION_MODEL?: string;
  /** Platform OpenRouter key — event tagging, vibe prediction, query understanding,
   *  identity-match ranking. Absent ⇒ every one of those falls back to its
   *  deterministic core, so the site works fully without it. Distinct from the
   *  per-user BYO key in `agent_settings.ai_key`, which still wins where it's set. */
  OPENROUTER_API_KEY?: string;
  /** High-volume, latency-sensitive work: query parsing, bulk tagging. */
  OPENROUTER_MODEL_FAST?: string;
  /** Low-volume, quality-sensitive work: vibe prose, identity-match ranking. */
  OPENROUTER_MODEL_QUALITY?: string;
  /** Daily ceiling on platform-funded model spend. Absent ⇒ unguarded. A runaway
   *  loop is a billing incident, so this is enforced in `completeJson`, not at
   *  call sites. */
  LLM_DAILY_BUDGET_USD?: string;
  /**
   * Fraction of personalized feed renders whose head is randomized so the ranker can
   * learn from something other than its own prior (see `core/rank/explore.ts`).
   * Absent ⇒ `DEFAULT_EPSILON`. `"0"` turns exploration off entirely.
   *
   * A dial rather than a constant because it is the one part of the loop an operator may
   * need to change without a deploy: up during a cold start when there is nothing to
   * learn from, and straight to zero if a shuffled front page is ever the wrong thing to
   * be doing. Tests also pin it to 0 so an assertion about ordering is not a coin flip.
   */
  RANK_EPSILON?: string;
  /** Semantic event search. Typed structurally for the same reason AI/ASSETS are —
   *  `@cloudflare/workers-types` is not ambient here (tsconfig `types: ["node"]`).
   *  Absent ⇒ search degrades to FTS5 + keyword, which is still a big upgrade. */
  VECTORIZE?: {
    query(
      vector: number[],
      opts?: { topK?: number; filter?: Record<string, unknown>; returnMetadata?: boolean | string },
    ): Promise<{ matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
    upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>): Promise<unknown>;
    deleteByIds(ids: string[]): Promise<unknown>;
  };
  /** Offline map packs (PMTiles basemap + the pedestrian routing graph). Served
   *  with HTTP Range so the online map streams tiles from the same object the
   *  offline download installs. */
  TILES?: R2Bucket;
  // Media: Cloudflare Images / Stream (optional until configured)
  CF_ACCOUNT_ID?: string;
  IMAGES_TOKEN?: string;
  STREAM_TOKEN?: string;
  // Workers AI (optional — the AI brief/agent degrade to their deterministic core
  // when absent, so everything works without it).
  AI?: { run(model: string, input: unknown): Promise<any> };
  // Web push (VAPID) — optional; push opt-in is hidden until VAPID_PUBLIC_KEY is set.
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

/** Hono context variables set by auth middleware. */
export type Vars = {
  user: User;
  /** Set by `requireHost()` — the event the caller was just authorized to host, so a
   *  handler need not re-query what the middleware already resolved. */
  hostEventId: string;
};
