/**
 * Inbound rate limiting. Abuse used to be held back by length caps, UNIQUE keys and
 * attendance gates, which stop malformed and duplicate writes but do nothing about volume;
 * a public submit box and a volunteer scrape network both need volume limits too.
 *
 * The decision is pure and the counting is done by the caller (a KV counter keyed per user
 * per window), so the policy is testable without a clock or a store.
 *
 * Lives in `core/` rather than `news/` because both Workers use it now. `src/news/ratelimit.ts`
 * re-exports this file, so every existing news import is unaffected.
 */
export interface Limit {
  /** Requests permitted per window. */
  max: number;
  windowSeconds: number;
  /**
   * Minimum gap between two of these actions, in seconds.
   *
   * The per-hour cap alone doesn't stop a script burning the whole quota in two
   * seconds; a cooldown does, without caring what was said. This is the entire
   * automatic enforcement mechanism on this site — deliberately mechanical, so
   * it can't be experienced as a judgement about content.
   */
  cooldownSeconds?: number;
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
  submit: { max: 5, windowSeconds: 3600, cooldownSeconds: 60 },
  comment: { max: 30, windowSeconds: 3600, cooldownSeconds: 20 },
  // Voting is cheap and near-invisible; a cooldown here would just make the site
  // feel broken while reading.
  vote: { max: 200, windowSeconds: 3600 },
  flag: { max: 20, windowSeconds: 3600, cooldownSeconds: 10 },

  // ── the scrape network ────────────────────────────────────────────────────
  // NO COOLDOWNS on either of these, deliberately. Both are two people standing together, and
  // a cooldown punishes the honest case far harder than it inhibits abuse: the display legitimately
  // re-mints every ~27 seconds while somebody holds up a phone, and a joiner told to "stand
  // nearer" has to be able to step closer and retry *immediately* or the product feels broken in
  // the exact moment it needs to feel instant. The hourly cap already bounds flooding, and neither
  // action is loud — nothing is broadcast to anyone.
  //
  // 400/hour is one mint every nine seconds sustained, comfortably above a continuous Show
  // session, and each mint is one small INSERT plus one UPDATE.
  net_invite: { max: 400, windowSeconds: 3600 },
  // Frame codes are unguessable, so this is hygiene against a stuck client looping forever
  // rather than a security control.
  net_join: { max: 60, windowSeconds: 3600 },
  // Deliberately generous: a worker asking for work is the behaviour we WANT, and the real
  // brake is the coordinator's politeness budget, which refuses work rather than requests.
  net_lease: { max: 600, windowSeconds: 3600 },
  net_submit: { max: 600, windowSeconds: 3600 },
} as const satisfies Record<string, Limit>;

/**
 * Decide whether an action is permitted right now.
 *
 * `sinceLastSeconds` is how long ago this user last performed this action
 * (Infinity if never). Cooldown is checked first because it produces the more
 * useful message: "try again in 45s" is actionable, "you've hit your hourly
 * limit" is not.
 */
export function rateVerdict({
  inWindow,
  limit,
  sinceLastSeconds = Infinity,
}: { inWindow: number; limit: Limit; sinceLastSeconds?: number }): Verdict {
  const used = Math.max(0, inWindow);
  const remaining = Math.max(0, limit.max - used);

  const cooldown = limit.cooldownSeconds ?? 0;
  if (cooldown > 0 && sinceLastSeconds < cooldown) {
    return { ok: false, remaining, retryAfterSeconds: Math.max(1, Math.ceil(cooldown - sinceLastSeconds)) };
  }
  if (used >= limit.max) {
    return { ok: false, remaining: 0, retryAfterSeconds: limit.windowSeconds };
  }
  return { ok: true, remaining, retryAfterSeconds: 0 };
}

/** Human-readable wait, for a refusal message that tells you what to do. */
export function waitMessage(seconds: number): string {
  if (seconds <= 0) return "";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.ceil(seconds / 60);
  return mins < 60 ? `${mins} min` : `${Math.ceil(mins / 60)}h`;
}
