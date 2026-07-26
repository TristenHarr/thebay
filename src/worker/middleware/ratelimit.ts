import type { Env } from "../env";
import { LIMITS, rateVerdict, waitMessage, type Limit } from "../../core/ratelimit";

/**
 * KV-counted rate limiting, shared by both Workers.
 *
 * The policy is pure (`src/core/ratelimit.ts`); this is the counting half, lifted out of
 * `src/worker/news.ts` so the scrape network can use exactly the same mechanism rather than
 * inventing a second one. The news site's `checkRate` was the only rate limiter in the codebase
 * and it worked; the goal here is one implementation, not a better one.
 *
 * Best-effort by design: KV is eventually consistent, so a determined client racing two
 * requests through the same window can occasionally get one extra. That is fine and stated
 * plainly — this exists to stop flooding, and the real invariants live in the schema. A limiter
 * that needed to be exact would need a Durable Object per user, which is a lot of machinery to
 * buy a bound nobody is relying on.
 *
 * Content-neutral by construction: it knows how often you acted, never what you said.
 */

export type RateKind = keyof typeof LIMITS;

export interface RateResult {
  ok: boolean;
  retryAfter: number;
  /** A human wait ("45s", "3 min"), so a refusal can say what to do. */
  wait: string;
}

/**
 * Count this action and decide whether it's allowed. Only a PERMITTED action increments the
 * counter — a refusal that also consumed quota would let a blocked client hold itself blocked
 * forever by retrying.
 */
export async function checkRate(env: Env, kind: RateKind, subjectId: string, nowMs: number = Date.now()): Promise<RateResult> {
  // Widened to Limit: kinds without a cooldown make the literal union lack the key.
  const limit: Limit = LIMITS[kind];
  const bucket = Math.floor(nowMs / (limit.windowSeconds * 1000));
  const countKey = `rl:${kind}:${subjectId}:${bucket}`;
  const lastKey = `rl:last:${kind}:${subjectId}`;

  const [countRaw, lastRaw] = await Promise.all([env.SESSIONS.get(countKey), env.SESSIONS.get(lastKey)]);
  const n = parseInt(countRaw || "0", 10) || 0;
  const lastMs = parseInt(lastRaw || "0", 10) || 0;
  const sinceLastSeconds = lastMs ? (nowMs - lastMs) / 1000 : Infinity;

  const verdict = rateVerdict({ inWindow: n, limit, sinceLastSeconds });
  if (verdict.ok) {
    await Promise.all([
      env.SESSIONS.put(countKey, String(n + 1), { expirationTtl: limit.windowSeconds * 2 }),
      env.SESSIONS.put(lastKey, String(nowMs), { expirationTtl: Math.max(60, (limit.cooldownSeconds ?? 60) * 4) }),
    ]);
  }
  return { ok: verdict.ok, retryAfter: verdict.retryAfterSeconds, wait: waitMessage(verdict.retryAfterSeconds) };
}

/**
 * The 429 to return when `checkRate` says no. Sets `retry-after`, because a client that is told
 * to wait but not how long will simply retry immediately.
 */
export function tooManyRequests(c: any, r: RateResult, what: string): Response {
  c.header("retry-after", String(Math.max(1, r.retryAfter)));
  return c.json({ error: `too many ${what} — try again in ${r.wait}`, reason: "rate_limited", retryAfter: r.retryAfter }, 429);
}
