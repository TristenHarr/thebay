/**
 * THE ECONOMY. A gym leader is a mint, and this file is what a mint may print.
 *
 * Every mint needs a monetary base it cannot fabricate. Here that base is **verified
 * physical presence** — rows in `event_presence`, which only exist after a live,
 * geofenced door scan inside the event's window. Everything below prices that base.
 *
 * ## The three bounds, and the attack each one closes
 *
 * | bound | attack it kills |
 * |---|---|
 * | per-event budget from verified attendance, with a 3-attendee floor | "I hosted an event with no attendees and minted 50,000 XP" — and the staged 2-person meetup outright |
 * | per-host rolling 30-day cap | gym-spam: forty 'events' in a week |
 * | per-recipient halving, across all events, forever | mutual collusion between two people who take turns hosting |
 *
 * The third is the one worth understanding. The Nth time host H pays attendee A — over
 * all events, for all time — is worth `2^-(N-1)` of the cap. The geometric series
 * converges, so the TOTAL XP one host can ever mint to one person is 994 XP, which is
 * **level 4**. `tests/gym-budget.test.ts` asserts that number directly: a perfect
 * two-person collusion ring, run forever, buys level 4 and costs a physical meeting per
 * award. A ten-person ring caps around 9,000 XP each — and getting it requires ten real
 * accounts co-located at ten real gatherings inside the Bay, at which point they are
 * holding meetups, which is the product working.
 *
 * ## Why this is core and not SQL
 *
 * Overspend is enforced in the schema (`CHECK (spent <= budget)` with `spent` maintained
 * by trigger) because it is a property of a row. The BUDGET, though, is an aggregate over
 * `event_presence`, `reviews` and a 30-day window over `gym_awards`, and it needs "now".
 * A trigger computing it would bury the economic policy in DDL where it can't be unit
 * tested and can't be retuned without a migration. So: SQL owns what a row can promise;
 * this file owns what the economy allows. Nothing owns either twice.
 *
 * Pure and total — every function is safe against NaN, negatives and absurd inputs,
 * because these numbers arrive from SQL aggregates and a NaN cap is an unbounded cap.
 */

/** What a gym that actually ran is worth before per-head scaling. */
export const GYM_BASE_XP = 200;

/** What one verified body in the room is worth. */
export const XP_PER_ATTENDEE = 100;

/** Below this many verified attendees the budget is zero. This single constant kills
 *  the staged two-person meetup, which is the cheapest possible attack. */
export const GYM_MIN_ATTENDEES = 3;

/** Policy ceiling for one recipient at one gym, before dwell and halving. The SCHEMA
 *  ceiling on `gym_awards.xp` is deliberately looser (1000) — that one is the backstop
 *  no future bug can raise without a migration; this one is tunable. */
export const PER_RECIPIENT_CAP = 500;

export const HOST_WINDOW_DAYS = 30;

/** Most XP one host may mint in a rolling window, across every gym they run. */
export const HOST_WINDOW_CAP = 20_000;

/** Each repeat award from the same host to the same person is worth this share of the
 *  previous one. 0.5 makes the total convergent — see the header. */
export const REPEAT_HALVING = 0.5;

/** Standing multiplier bounds. Ceilinged so a reputable host cannot run away with the
 *  money supply; floored at 0 so a quarantined one mints nothing. */
export const STANDING_MIN = 0;
export const STANDING_MAX = 1.5;

/** NPS is noise below this many reviews, and is ignored entirely. */
export const STANDING_MIN_REVIEWS = 3;

export interface HostStanding {
  /** Gyms this host has settled with at least `GYM_MIN_ATTENDEES` verified attendees. */
  settledGyms: number;
  /** %5★ − %≤3★ over reviews of events they hosted, −100…100, or null if unreviewed. */
  nps: number | null;
  reviewCount: number;
  /** XP this host has minted in the last `HOST_WINDOW_DAYS`. */
  mintedInWindow: number;
  /** Set by moderation. Overrides everything. */
  quarantined: boolean;
}

export interface Budget {
  budget: number;
  recipientCap: number;
  /**
   * Why the budget is what it is. Not decoration: a host who awarded nothing needs to
   * be told their event was too small, or they will conclude the feature is broken and
   * file a bug instead of inviting more people.
   */
  reasons: string[];
}

const num = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * The standing multiplier, clamped to [0, 1.5].
 *
 * Two inputs, deliberately: **experience** (a first-time host starts below full rate, so
 * a fresh throwaway account is not worth as much as a track record) and **NPS** (a
 * well-reviewed host earns more headroom, a badly-reviewed one less). Quarantine is a
 * hard zero.
 */
export function standingMultiplier(s: HostStanding): number {
  if (s.quarantined) return 0;

  // 0.6 at zero settled gyms, reaching full rate at four. A new host can still run a
  // real gym; they just can't mint at veteran rate on day one.
  const gyms = Math.max(0, num(s.settledGyms));
  const experience = Math.min(1, 0.6 + 0.1 * gyms);

  // ±0.5 at ±100 NPS, and ignored entirely below the review threshold — one 5★ from a
  // friend must not be worth a 50% raise.
  const reviews = Math.max(0, num(s.reviewCount));
  const nps = s.nps == null ? null : num(s.nps, 0);
  const npsAdj = nps != null && reviews >= STANDING_MIN_REVIEWS ? clamp(nps, -100, 100) / 100 * 0.5 : 0;

  return clamp(experience * (1 + npsAdj), STANDING_MIN, STANDING_MAX);
}

/**
 * The ceiling for one recipient, given how many times this host has already paid them.
 *
 * `Math.floor` matters: it makes the series terminate at zero rather than trailing
 * fractions forever, so "this host can never pay you again" is a reachable state.
 */
export function recipientCap(priorAwardsFromThisHost: number, cap = PER_RECIPIENT_CAP): number {
  const n = Math.max(0, Math.floor(num(priorAwardsFromThisHost)));
  return Math.max(0, Math.floor(cap * Math.pow(REPEAT_HALVING, n)));
}

/**
 * What a gym may mint in total, from verified attendance and the host's standing.
 *
 * Deliberately NOT discounted by repeat attendees. I considered a `distinctNewAttendees`
 * term and left it out: unspent budget is harmless because `recipientCap` makes it
 * unspendable, and a fourth input to this function is complexity that buys nothing.
 * Noted here so nobody "fixes" it later.
 */
export function gymBudget(verifiedAttendees: number, s: HostStanding): Budget {
  const reasons: string[] = [];
  const attendees = Math.max(0, Math.floor(num(verifiedAttendees)));
  const cap = recipientCap(0);

  if (s.quarantined) {
    reasons.push("This account is under review, so this gym cannot award XP.");
    return { budget: 0, recipientCap: cap, reasons };
  }

  if (attendees < GYM_MIN_ATTENDEES) {
    reasons.push(
      `A gym needs ${GYM_MIN_ATTENDEES} verified attendees before it can award XP — ${attendees} ${attendees === 1 ? "has" : "have"} scanned in.`,
    );
    return { budget: 0, recipientCap: cap, reasons };
  }

  const multiplier = standingMultiplier(s);
  const raw = Math.floor((GYM_BASE_XP + XP_PER_ATTENDEE * attendees) * multiplier);

  const minted = Math.max(0, num(s.mintedInWindow));
  const windowRemaining = Math.max(0, HOST_WINDOW_CAP - minted);
  const budget = Math.min(raw, windowRemaining);

  if (windowRemaining === 0) {
    reasons.push(`You've minted the maximum ${HOST_WINDOW_CAP.toLocaleString()} XP for the last ${HOST_WINDOW_DAYS} days.`);
  } else if (budget < raw) {
    reasons.push(`Capped by your ${HOST_WINDOW_DAYS}-day limit — ${windowRemaining.toLocaleString()} XP left in the window.`);
  } else {
    reasons.push(`${attendees} verified attendees × standing ${multiplier.toFixed(2)}.`);
  }

  return { budget, recipientCap: cap, reasons };
}
