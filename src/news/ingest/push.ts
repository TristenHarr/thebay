/**
 * Stories harvested on a residential IP and pushed to the Worker.
 *
 * Some sources refuse Cloudflare's egress, not us. OpenAlex returns 200 to a
 * laptop and 429 to the Worker on the same query, because a Worker shares an
 * outbound IP with everyone else on the platform and lands in someone else's
 * rate-limit bucket. The `mailto` polite-pool parameter doesn't help — the
 * bucket is per-IP. This is the same reason the events scraper runs locally
 * against Eventbrite, so it gets the same answer: harvest here, push there.
 *
 * The endpoint is a WRITE surface, so it is deliberately narrow:
 *
 *  - Bearer-gated with INGEST_TOKEN, like every other admin route.
 *  - Origins are ALLOWLISTED. A leaked token can add papers; it cannot forge a
 *    `bay` story, which is what a human submission looks like. Push carries no
 *    author identity and can never mint one.
 *  - Every field is validated and bounded before it reaches SQL, and the batch
 *    itself is capped, so a malformed or hostile payload is rejected whole
 *    rather than half-applied.
 */
import { z } from "zod";

/**
 * zod's .url() only checks that `new URL()` parses, which happily accepts
 * `javascript:` and `data:`. The renderer's safeUrl() would refuse to emit those
 * as an href, but a hostile scheme should never reach storage in the first
 * place — defence in depth, and a test caught this before it shipped.
 */
const httpUrl = z
  .string()
  .url()
  .max(2000)
  .refine((u) => {
    const p = ((): string => { try { return new URL(u).protocol; } catch { return ""; } })();
    return p === "http:" || p === "https:";
  }, "must be http(s)");

/**
 * Origins the push endpoint may write. Only sources the Worker genuinely cannot
 * reach itself belong here — this is a workaround for network topology, not a
 * general-purpose insert API. Adding an origin here widens what a stolen token
 * can publish, so it should stay boring.
 */
export const PUSHABLE_ORIGINS = ["research"] as const;

/** Max stories per request. One institution's week is ~10; this is generous. */
export const MAX_PUSH_BATCH = 200;

export const PushedStorySchema = z.object({
  origin: z.enum(PUSHABLE_ORIGINS),
  externalId: z.string().min(1).max(200),
  title: z.string().min(3).max(200),
  url: httpUrl.nullable(),
  externalUrl: httpUrl.nullable(),
  points: z.number().int().min(0).max(10_000_000).nullable(),
  comments: z.number().int().min(0).max(10_000_000).nullable(),
  // Must parse as a real instant; a bad date would sort the whole feed wrong.
  createdAt: z.string().refine((s) => Number.isFinite(Date.parse(s)), "not a date"),
  author: z.string().max(200).nullable(),
  topics: z.array(z.string().max(40)).max(8),
});

export const PushPayloadSchema = z.object({
  stories: z.array(PushedStorySchema).max(MAX_PUSH_BATCH),
});

export type PushedStory = z.infer<typeof PushedStorySchema>;
