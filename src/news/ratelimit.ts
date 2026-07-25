/**
 * Inbound rate limiting — the first in this codebase. Until now abuse was held
 * back by length caps, UNIQUE keys and attendance gates, which stop malformed and
 * duplicate writes but do nothing about volume. A public submit box needs volume
 * limits too.
 *
 * The decision is pure and the counting is done by the caller (a KV counter keyed
 * per user per window), so the policy is testable without a clock or a store.
 */
export interface Limit {
  /** Requests permitted per window. */
  max: number;
  windowSeconds: number;
}

export interface Verdict {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Deliberately asymmetric. Submitting is the loudest action — it occupies the
 * front page for everyone — so it's the tightest. Commenting is conversation and
 * gets room to breathe. Voting is cheap and near-invisible, so it's capped only
 * high enough to make scripted vote-farming impractical.
 */
export const LIMITS = {
  submit: { max: 5, windowSeconds: 3600 },
  comment: { max: 30, windowSeconds: 3600 },
  vote: { max: 200, windowSeconds: 3600 },
} as const satisfies Record<string, Limit>;

export function rateVerdict({ inWindow, limit }: { inWindow: number; limit: Limit }): Verdict {
  const used = Math.max(0, inWindow);
  const remaining = Math.max(0, limit.max - used);
  return {
    ok: used < limit.max,
    remaining,
    retryAfterSeconds: used < limit.max ? 0 : limit.windowSeconds,
  };
}
