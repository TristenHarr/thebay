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
export type Vars = { user: User };
