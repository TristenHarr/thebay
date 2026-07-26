/**
 * The evidence ladder — pure logic, no I/O.
 *
 * An attribution says "this intro / event / community had something to do with
 * that outcome". That is a claim about cause, and claims about cause are the
 * easiest thing in a product like this to publish wrongly. So every attribution
 * carries the tier of evidence behind it, and the four tiers are rendered
 * DISTINCTLY and never collapsed into one another:
 *
 *   sec           the round is on the public record          "$4.2M · Form D"
 *   counterparty  both sides confirmed the causal link       "confirmed by both"
 *   self          one party claims it                        "claimed by @ann"
 *   platform      the edge provably predates the outcome     "met here 5 months before"
 *
 * The last one is the dangerous one. `platform` is CO-OCCURRENCE: we can prove
 * two people were connected here before the outcome, and that is all we can
 * prove. It is never reported as causation, it never carries a causal verb, and
 * no quantity of correlations rolls up into a corroborated outcome.
 *
 * The other rule enforced here: a tier can never silently upgrade itself. Every
 * transition needs a named human actor and must be on the allow-list —
 * `{ actor: "system" }` can never raise anything.
 */

export const EVIDENCE_TIERS = ["sec", "counterparty", "self", "platform"] as const;
export type Evidence = (typeof EVIDENCE_TIERS)[number];

export type CauseType = "intro" | "event" | "group" | "community" | "mentor";

/** Strength order. Used to pick the strongest tier present, never to average. */
export const EVIDENCE_RANK: Record<Evidence, number> = { sec: 4, counterparty: 3, self: 2, platform: 1 };

export interface AttributionRecord {
  evidence: Evidence;
  causeType: CauseType;
  weight: number;
  claimedByHandle?: string | null;
  confirmedByHandle?: string | null;
  /** Whole months between the platform edge and the outcome. Null = unmeasured. */
  leadMonths?: number | null;
}

export interface EvidenceRendering {
  tier: Evidence;
  /** Exactly what to print. Distinct per tier — a reader can always tell them apart. */
  label: string;
  /** How a renderer should style it. 'correlation' must never look like a claim. */
  kind: "corroborated" | "claimed" | "correlation";
  /** True only when a human has actually asserted the causal link. */
  causal: boolean;
}

/** `platform` is the only tier that asserts nothing about cause. */
export function assertsCausation(tier: Evidence): boolean {
  return tier !== "platform";
}

function months(n: number): string {
  return `${n} month${n === 1 ? "" : "s"}`;
}

export function describeAttribution(a: AttributionRecord): EvidenceRendering {
  switch (a.evidence) {
    case "sec":
      return { tier: "sec", label: "SEC-corroborated", kind: "corroborated", causal: true };
    case "counterparty":
      return { tier: "counterparty", label: "confirmed by both", kind: "corroborated", causal: true };
    case "self":
      return {
        tier: "self",
        // No handle ⇒ say so plainly rather than inventing an attribution to someone.
        label: a.claimedByHandle ? `claimed by @${a.claimedByHandle}` : "claimed by a participant",
        kind: "claimed",
        causal: true,
      };
    case "platform":
    default:
      return {
        tier: "platform",
        // Deliberately verb-free about cause: it states WHEN, never WHY.
        label: a.leadMonths && a.leadMonths > 0 ? `met here ${months(a.leadMonths)} before` : "met here before this outcome",
        kind: "correlation",
        causal: false,
      };
  }
}

/** The strongest tier in a set, or null for an empty set. Never an average. */
export function strongestEvidence(tiers: Evidence[]): Evidence | null {
  let best: Evidence | null = null;
  for (const t of tiers) if (!best || EVIDENCE_RANK[t] > EVIDENCE_RANK[best]) best = t;
  return best;
}

export interface OutcomeRollup extends EvidenceRendering {
  counts: Record<Evidence, number>;
  /** True only when a corroborated tier is actually present. */
  corroborated: boolean;
}

/**
 * How one outcome's whole set of attributions should be badged. Takes the
 * strongest tier present — a hundred `platform` correlations stay a correlation.
 */
export function rollUpOutcome(attrs: AttributionRecord[]): OutcomeRollup {
  const counts: Record<Evidence, number> = { sec: 0, counterparty: 0, self: 0, platform: 0 };
  for (const a of attrs) counts[a.evidence]++;
  const tier = strongestEvidence(attrs.map((a) => a.evidence)) ?? "platform";
  const top = attrs.find((a) => a.evidence === tier) ?? { evidence: tier, causeType: "event" as CauseType, weight: 1 };
  const rendering = describeAttribution(top);
  return { ...rendering, counts, corroborated: rendering.kind === "corroborated" };
}

// ── tier transitions ─────────────────────────────────────────────────────────

/** Who is asking for the change. `system` exists so that "no actor" is a value
 *  you can pass, and is always refused — that is the no-silent-upgrade rule. */
export type Actor = "system" | "ingest" | "claimant" | "counterparty";

export interface Transition {
  from: Evidence;
  to: Evidence;
  actor: Actor;
}

/**
 * Upgrades are allow-listed per actor. Anything not listed is refused, so a new
 * tier or a new caller defaults to "no change" rather than to a promotion.
 */
const ALLOWED_UPGRADES: Record<Actor, Array<[Evidence, Evidence]>> = {
  // Nothing. A tier never raises itself.
  system: [],
  // A person steps forward and turns a correlation into their own claim.
  claimant: [["platform", "self"]],
  // The other side corroborates a claim that already exists. It cannot corroborate
  // a correlation nobody has claimed.
  counterparty: [["self", "counterparty"]],
  // The filing corroborates a link somebody already asserted. It never invents one.
  ingest: [
    ["self", "sec"],
    ["counterparty", "sec"],
  ],
};

export interface UpgradeResult {
  evidence: Evidence;
  changed: boolean;
  reason: string;
}

/**
 * Apply a tier transition, or refuse it. Downgrades (retractions) are always
 * allowed for a human actor — walking a claim back is safe. Upgrades must be on
 * the allow-list for that actor.
 */
export function upgradeEvidence(t: Transition): UpgradeResult {
  const keep = (reason: string): UpgradeResult => ({ evidence: t.from, changed: false, reason });
  if (t.from === t.to) return keep("already at this tier");
  if (t.actor === "system") return keep("no human actor — a tier never upgrades itself");

  if (EVIDENCE_RANK[t.to] < EVIDENCE_RANK[t.from]) {
    return { evidence: t.to, changed: true, reason: `retracted to ${t.to} by ${t.actor}` };
  }
  const ok = ALLOWED_UPGRADES[t.actor].some(([from, to]) => from === t.from && to === t.to);
  return ok
    ? { evidence: t.to, changed: true, reason: `${t.actor} raised ${t.from} → ${t.to}` }
    : keep(`${t.actor} may not raise ${t.from} → ${t.to}`);
}

/**
 * Split credit for ONE outcome across its causes so it can never be counted
 * twice on a leaderboard. Weights are normalized to sum to 1; an all-zero set is
 * split evenly rather than dividing by zero.
 */
export function normalizeWeights<T extends AttributionRecord>(attrs: T[]): T[] {
  if (attrs.length === 0) return [];
  const total = attrs.reduce((s, a) => s + (Number.isFinite(a.weight) ? Math.max(0, a.weight) : 0), 0);
  if (total <= 0) return attrs.map((a) => ({ ...a, weight: 1 / attrs.length }));
  return attrs.map((a) => ({ ...a, weight: Math.max(0, a.weight) / total }));
}

// ── outcome headline ─────────────────────────────────────────────────────────

/** Compact money. Trims a trailing ".0" so $12.0M prints as $12M. */
export function formatUsd(n: number): string {
  const abs = Math.abs(n);
  const scale = (div: number, suffix: string) => `$${(n / div).toFixed(1).replace(/\.0$/, "")}${suffix}`;
  if (abs >= 1e9) return scale(1e9, "B");
  if (abs >= 1e6) return scale(1e6, "M");
  if (abs >= 1e3) return scale(1e3, "K");
  return `$${Math.round(n)}`;
}

/**
 * Whole calendar months from `from` to `to`, or null if either is unparseable or
 * the order is wrong. Calendar months, not days/30: "Jan 10 → Jun 10" is five
 * months to a reader, and 151/30.44 is not.
 */
export function monthsBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = from ? new Date(from) : null;
  const b = to ? new Date(to) : null;
  if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b <= a) return null;
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) m--;
  return Math.max(0, m);
}

export interface OutcomeFacts {
  kind: "funding" | "hire" | "cofounder" | "customer" | "job";
  amountUsd: number | null;
  /** Where the round came from. Only 'sec' may be printed as "Form D". */
  roundSource: "sec" | "news" | "crowd" | null;
}

/**
 * The badge for the OUTCOME — deliberately separate from the attribution badge,
 * because "this round is on the public record" and "this intro caused it" are
 * different statements and must never be printed as one.
 */
export function outcomeHeadline(o: OutcomeFacts): string {
  if (o.kind !== "funding") return o.kind;
  const provenance = o.roundSource === "sec" ? "Form D" : o.roundSource === "news" ? "reported" : o.roundSource === "crowd" ? "community-reported" : null;
  if (o.amountUsd == null) return provenance ? `${provenance} filed` : "funding";
  return provenance ? `${formatUsd(o.amountUsd)} · ${provenance}` : formatUsd(o.amountUsd);
}
