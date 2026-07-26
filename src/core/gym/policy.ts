/**
 * The gym's declared rules and its state machine — pure, so every edge is a unit test
 * and the client can grey out a button using the same function the server enforces with.
 *
 * ## Why terms freeze
 *
 * A gym whose rules can change after the event is a discretionary mint with a promise
 * attached: advertise "flat 50 to everyone", then pay your friends 300 and the advertised
 * rule was a lie. So `arm` publishes the terms and the schema freezes them (trigger), and
 * everything here treats `armed` as the point of no return for policy.
 *
 * ## Why flat allocation prorates
 *
 * If a host promises 50 XP each and 40 people arrive against a 1,500 budget, paying the
 * first 30 in full and nothing to the last 10 makes the host a liar to ten people who
 * showed up. Everyone getting 37 does not. First-come-first-served on a promise made to
 * everyone is the one failure mode that would actively damage a host's reputation, which
 * is the thing the whole standing system depends on.
 */
import { eventEndMs, eventStartMs, type EventWindow } from "./window";

export type { EventWindow };

/** Most named feats one gym may price. Twelve is more than any real event uses. */
export const MAX_BOUNTIES = 12;

/** The absolute per-award ceiling this module will emit. Mirrors the schema CHECK. */
export const MAX_AWARD_XP = 1000;

/** How early a gym may start awarding — doors open before the listed start. */
export const AWARD_OPENS_BEFORE_MS = 60 * 60 * 1000;

/** How long after the event a host may still correct the roster. */
export const AWARD_SHUTS_AFTER_MS = 48 * 60 * 60 * 1000;

export type GymMode = "none" | "flat" | "discretion" | "bounty";

export interface BountySpec {
  key: string;
  label: string;
  xp: number;
  badgeSlug?: string;
  /** "One Best Demo, not thirty." */
  limit?: number;
}

export interface GymFacts {
  mode: GymMode;
  flatXp: number;
  bounties: BountySpec[];
  budget: number;
  spent: number;
  status: "draft" | "armed" | "settled";
}

export type GymTransition =
  | "ok"
  | "not_draft"
  | "not_armed"
  | "already_settled"
  | "no_budget"
  | "too_early"
  | "too_late"
  | "empty_policy";

const num = (x: unknown, fallback = 0): number => {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : fallback;
};

const SLUG_OK = /^[a-z][a-z0-9_]{0,31}$/;

/** Lowercase, punctuation to underscores, collapsed. Returns "" if unusable. */
function slugify(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return SLUG_OK.test(s) ? s : "";
}

/**
 * Parse a stored `bounties_json` (or a freshly-posted array) into usable specs.
 *
 * TOTAL, in the spirit of `src/core/places/fields.ts`: malformed entries are DROPPED and
 * out-of-range prices are CLAMPED, never thrown on. A gym with one corrupt bounty must
 * still render its other three, and an attendee's card must not 500 because a host typed
 * something odd into a form.
 */
export function parseBounties(raw: unknown): BountySpec[] {
  let src: unknown = raw;
  if (typeof src === "string") {
    try {
      src = JSON.parse(src);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(src)) return [];

  const out: BountySpec[] = [];
  const seen = new Set<string>();
  for (const entry of src) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;

    const key = slugify(e.key);
    if (!key || seen.has(key)) continue;

    const label = typeof e.label === "string" ? e.label.trim().slice(0, 60) : "";
    if (!label) continue;

    // Clamp rather than reject: a host who typed 5000 meant "a lot", and dropping the
    // row would silently lose a feat they intended to reward.
    const xp = Math.round(Math.max(1, Math.min(MAX_AWARD_XP, num(e.xp, 1))));

    const spec: BountySpec = { key, label, xp };
    const badgeSlug = slugify(e.badgeSlug);
    if (badgeSlug) spec.badgeSlug = badgeSlug;
    const limit = Math.floor(num(e.limit, 0));
    if (limit > 0) spec.limit = Math.min(200, limit);

    seen.add(key);
    out.push(spec);
    if (out.length >= MAX_BOUNTIES) break;
  }
  return out;
}

export function serializeBounties(b: BountySpec[]): string {
  return JSON.stringify(b);
}

/** Does this policy actually promise something payable? */
function isEmptyPolicy(g: GymFacts): boolean {
  if (g.mode === "flat") return num(g.flatXp) <= 0;
  if (g.mode === "bounty") return g.bounties.length === 0;
  // 'none' is a legitimate declaration ("I am not awarding XP") and 'discretion'
  // promises nothing specific by design, so neither can be empty.
  return false;
}

/** The window in which awards may be made at all. */
function awardWindow(ev: EventWindow): { fromMs: number; toMs: number } {
  return { fromMs: eventStartMs(ev) - AWARD_OPENS_BEFORE_MS, toMs: eventEndMs(ev) + AWARD_SHUTS_AFTER_MS };
}

/**
 * May this gym be armed?
 *
 * Arming after doors is allowed — a host who discovers the feature at the entrance
 * should still be able to reward people — so lateness is reported by the route as a
 * flag rather than refused here. What is refused is arming a gym for an event that is
 * long over.
 */
export function canArm(g: GymFacts, ev: EventWindow, atMs: number): GymTransition {
  if (g.status !== "draft") return "not_draft";
  if (isEmptyPolicy(g)) return "empty_policy";
  const { toMs } = awardWindow(ev);
  if (!Number.isFinite(toMs) || atMs > toMs) return "too_late";
  return "ok";
}

export function canAward(g: GymFacts, ev: EventWindow, atMs: number): GymTransition {
  if (g.status === "settled") return "already_settled";
  if (g.status !== "armed") return "not_armed";
  const { fromMs, toMs } = awardWindow(ev);
  // An unparseable window shuts the door rather than opening it. Failing closed is the
  // only safe default for something that mints currency.
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return "too_late";
  if (atMs < fromMs) return "too_early";
  if (atMs > toMs) return "too_late";
  if (num(g.budget) - num(g.spent) <= 0) return "no_budget";
  return "ok";
}

export function canSettle(g: GymFacts, _ev: EventWindow, _atMs: number): GymTransition {
  if (g.status === "settled") return "already_settled";
  if (g.status !== "armed") return "not_armed";
  return "ok";
}

/** When a gym stops accepting corrections and closes its ledger for good. */
export function autoSettleAtMs(ev: EventWindow): number {
  return eventEndMs(ev) + AWARD_SHUTS_AFTER_MS;
}

/**
 * What a `flat` gym owes each verified attendee.
 *
 * Prorated when the room outgrew the promise — see the header for why that matters more
 * than it looks.
 */
export function flatAllocation(
  flatXp: number,
  attendees: number,
  budget: number,
): { perAttendee: number; total: number; prorated: boolean } {
  const rate = Math.max(0, Math.floor(num(flatXp)));
  const n = Math.max(0, Math.floor(num(attendees)));
  const b = Math.max(0, Math.floor(num(budget)));
  if (n === 0 || rate === 0 || b === 0) return { perAttendee: 0, total: 0, prorated: false };

  const want = rate * n;
  if (want <= b) return { perAttendee: rate, total: want, prorated: false };

  // Floor, so rounding can never push the total above the budget and trip the schema
  // CHECK — the constraint would be correct to abort, but the host would see a 409 for
  // a policy the server itself computed.
  const perAttendee = Math.floor(b / n);
  return { perAttendee, total: perAttendee * n, prorated: true };
}
