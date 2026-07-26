/**
 * Reputation for scrape-network members — pure, no I/O. Modelled directly on
 * src/core/places/trust.ts, because the shape of the problem is the same: a vouch
 * balance that decays, so a statement about a moment stops being treated as a fact
 * forever.
 *
 *     trust = (confirms − 2.0·contradictions − 0.25·min(vouchDebits, 20)) · exp(−age / halfLife)
 *
 * `CONTRADICTION_WEIGHT` is 2.0 rather than the crowd map's 1.5 because the costs aren't
 * symmetric: a missing event costs a founder nothing they didn't already lack, while a
 * *wrong published* event costs them a wasted evening and costs the catalog the only
 * thing it really sells, which is being right.
 *
 * The decay is anchored on the last time a member was scored, so standing reflects recent
 * work. Note what that does and doesn't do: it fades a tier that is no longer supported by
 * current evidence, and it never inverts — going quiet cannot make you negative, because
 * absence is not misconduct.
 *
 * Three deliberate softenings, all there because the expensive failure mode of a
 * volunteer network is not a fabricator getting through; it is an honest contributor
 * being wrongly blamed and leaving:
 *
 *   · a tier needs CALENDAR TIME as well as volume, so one scripted afternoon buys
 *     nothing — and equally, so nobody loses standing for having a slow week;
 *   · vouching costs a FRACTION of an invitee's contradiction and is capped, so
 *     introducing someone you met once stays something people will do;
 *   · quarantine looks only at a member's OWN work, and needs a real deficit rather
 *     than a bad day.
 *
 * Everything here is total in the same sense `places/trust.ts` is: no input — NaN, a
 * garbage date, a clock skewed into the future — can produce NaN, because this number
 * orders the lease queue and the contributor board, and a NaN comparator silently
 * scrambles both.
 */
import type { MemberTier } from "../../../shared/schema";

/** How fast standing fades with silence. 30 days: a month off costs you ~63%. */
export const TRUST_HALF_LIFE_H = 30 * 24;

/** A wrong published event costs more than a missing one. See the module doc. */
export const CONTRADICTION_WEIGHT = 2.0;

/** What a voucher pays for one of their invitee's contradictions. */
export const VOUCH_SHARE = 0.25;

/** ...and the most they can ever pay, so vouching stays worth doing. */
export const VOUCH_DEBIT_CAP = 20;

/** Below this, a member's own work is held pending a human review. */
export const QUARANTINE_FLOOR = -10;

/**
 * What each tier costs. `minTrust` is the decaying score (so a tier lapses when the
 * evidence for it does), while `minConfirms`/`minDays` are raw history (so a tier is
 * never granted to someone who simply hasn't done the work yet).
 */
export const TIER_RULES = {
  trusted: { minTrust: 20, minConfirms: 40, minDays: 3 },
  core: { minTrust: 120, minConfirms: 300, minDays: 14 },
} as const;

export interface MemberStats {
  confirms: number;
  contradictions: number;
  distinctDays: number;
  /** Invitee contradictions charged to this member for vouching. */
  vouchDebits?: number | null;
  joinedAt: string;
  lastScoredAt?: string | null;
}

/** Finite number or the fallback. Guards every arithmetic input. */
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** exp(−age / halfLife), clamped to [0,1]. A future anchor (clock skew) reads as brand new. */
export function decayFactor(ageHours: number, halfLifeHours: number = TRUST_HALF_LIFE_H): number {
  const age = Math.max(0, num(ageHours, 0));
  const hl = Math.max(1e-6, num(halfLifeHours, TRUST_HALF_LIFE_H));
  const f = Math.exp(-age / hl);
  return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
}

/** Hours since this member last had work judged (or joined). Never negative. */
export function ageHours(m: MemberStats, atMs: number): number {
  const anchor = ms(m.lastScoredAt) ?? ms(m.joinedAt) ?? atMs;
  return Math.max(0, (atMs - anchor) / 3_600_000);
}

/** The vouch penalty, weighted and capped. */
export function vouchPenalty(m: MemberStats): number {
  return VOUCH_SHARE * Math.min(VOUCH_DEBIT_CAP, Math.max(0, num(m.vouchDebits, 0)));
}

/** The one score. See the module doc for the formula and why the weights are what they are. */
export function trustScore(m: MemberStats, atMs: number = Date.now()): number {
  const balance = num(m.confirms) - CONTRADICTION_WEIGHT * num(m.contradictions) - vouchPenalty(m);
  const s = balance * decayFactor(ageHours(m, atMs));
  return Number.isFinite(s) ? s : 0;
}

/**
 * The tier the evidence currently supports. Computed, never granted — so nobody can be
 * talked into one, and losing one is arithmetic rather than a judgement call.
 */
export function tierOf(m: MemberStats, atMs: number = Date.now()): MemberTier {
  const trust = trustScore(m, atMs);
  const confirms = num(m.confirms);
  const days = num(m.distinctDays);
  const meets = (r: { minTrust: number; minConfirms: number; minDays: number }) =>
    trust >= r.minTrust && confirms >= r.minConfirms && days >= r.minDays;
  if (meets(TIER_RULES.core)) return "core";
  if (meets(TIER_RULES.trusted)) return "trusted";
  return "probation";
}

/** What this member would have to reach next, for a UI that can say so. */
export function nextTier(m: MemberStats, atMs: number = Date.now()): { tier: MemberTier; minTrust: number; minConfirms: number; minDays: number } | null {
  const t = tierOf(m, atMs);
  if (t === "probation") return { tier: "trusted", ...TIER_RULES.trusted };
  if (t === "trusted") return { tier: "core", ...TIER_RULES.core };
  return null;
}

/**
 * Should this member's pending work be held for a human to look at?
 *
 * Deliberately narrow. It ignores vouch debits entirely — you are held for your own work,
 * never for someone you introduced — and it requires a real deficit, so a single
 * contradiction on a first day cannot trigger it. Quarantine is a pause, not a verdict:
 * nothing is deleted and nothing publishes while it holds.
 */
export function shouldQuarantine(m: MemberStats, atMs: number = Date.now()): boolean {
  const ownBalance = num(m.confirms) - CONTRADICTION_WEIGHT * num(m.contradictions);
  return ownBalance * decayFactor(ageHours(m, atMs)) <= QUARANTINE_FLOOR;
}
