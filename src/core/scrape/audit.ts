/**
 * The recipe audit — pure, no I/O. Decides whether a candidate scraper should replace the
 * one currently in production.
 *
 * This is what makes "anyone can improve the scrapers" safe to automate. A candidate runs in
 * SHADOW mode against the same windows as the incumbent, and it is promoted only when it is
 * better on every axis that matters and worse on none:
 *
 *   · **precision** — it must not report things consensus disbelieves. A recipe that finds
 *     more by hallucinating structure is worse than the one it would replace, however
 *     impressive the count looks. This is the check that stops a plausible-looking
 *     `fieldMap` from filling the catalog with garbage.
 *   · **yield** — it must find at least as much, by a real margin. Merely tying is not a
 *     reason to swap live code.
 *   · **completeness** — its records must be at least as full. Twice the rows with half the
 *     venues is not more information.
 *   · **politeness** — it must not cost the host materially more requests. We are guests,
 *     and a yield bump is not a licence to knock three times as often.
 *   · **duration** — all of the above sustained over several windows spanning several days,
 *     because a recipe that got lucky on one afternoon has proven nothing.
 *
 * Two asymmetries are deliberate. `keep` is the default for thin or ambiguous evidence, so
 * doing nothing is what happens when we don't know. And a *collapsed* incumbent — a site
 * changed shape and the live recipe now finds nothing — promotes almost anything that works,
 * because waiting for a human is how a catalog goes stale.
 *
 * Everything is total: no NaN, no negative, no missing field can produce a `promote`.
 */

export interface RecipeStats {
  /** Distinct job windows this recipe has been observed over. */
  windows: number;
  /** Calendar days spanned by those windows. */
  spanDays: number;
  /** Distinct items reported (any status). */
  items: number;
  /** Distinct items consensus accepted. */
  confirmed: number;
  /** Distinct items consensus rejected. */
  contradicted: number;
  /** Mean populated-field rate across its payloads, 0..1. */
  fieldCompleteness: number;
  /** Requests it made — the cost it imposes on the host. */
  requests: number;
}

export interface AuditRules {
  minWindows: number;
  minDays: number;
  /** Fraction of reported items that must not be contradicted. */
  minPrecision: number;
  /** How much more it must find to justify a swap. 1.15 = 15% better. */
  minYieldRatio: number;
  /** Below this fraction of the incumbent's yield, it is actively worse. */
  rejectYieldRatio: number;
  /** Completeness may not fall below this fraction of the incumbent's. */
  minCompletenessRatio: number;
  /** Requests may not exceed this multiple of the incumbent's per window. */
  maxRequestRatio: number;
}

export const AUDIT_RULES: AuditRules = {
  minWindows: 4,
  minDays: 3,
  // One contradicted item in fifty is a site that changed mid-crawl; one in five is a
  // recipe reading the wrong part of the page.
  minPrecision: 0.95,
  minYieldRatio: 1.15,
  rejectYieldRatio: 0.9,
  minCompletenessRatio: 0.95,
  maxRequestRatio: 1.25,
};

export type AuditVerdict = "promote" | "keep" | "reject";

export interface AuditResult {
  verdict: AuditVerdict;
  /** One sentence, kept in `recipe_audits.reason` — a decision nobody can reconstruct is a
   *  decision nobody can argue with. */
  reason: string;
  precision: number;
  yieldRatio: number;
  completenessRatio: number;
  requestRatio: number;
}

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const nonNeg = (v: unknown): number => Math.max(0, num(v, 0));

/** Ratio that treats a zero denominator as "the incumbent found nothing". */
function ratio(candidate: number, incumbent: number): number {
  if (incumbent <= 0) return candidate > 0 ? Infinity : 1;
  return candidate / incumbent;
}

/** Per-window request cost, so a candidate observed over more windows isn't penalised. */
const perWindow = (total: number, windows: number): number => nonNeg(total) / Math.max(1, nonNeg(windows));

/**
 * The fields a human actually reads on an event page, beyond the three a RawEvent cannot
 * exist without (`title`, `url`, `startRaw`). Completeness is measured over these because
 * they are what distinguishes a usable listing from a bare link.
 */
export const RICH_FIELDS = ["description", "endRaw", "venueName", "address", "city", "organizer", "imageUrl", "isFree", "priceText", "timezoneHint"] as const;

/**
 * Mean populated-field rate across payloads, 0..1. Empty strings and nulls do not count —
 * a blank venue name helps nobody and would let a recipe game this by emitting `""`.
 */
export function fieldCompleteness(payloads: Array<Record<string, unknown>>): number {
  if (!Array.isArray(payloads) || !payloads.length) return 0;
  let filled = 0;
  for (const p of payloads) {
    for (const f of RICH_FIELDS) {
      const v = (p ?? {})[f];
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && !v.trim()) continue;
      filled++;
    }
  }
  return filled / (payloads.length * RICH_FIELDS.length);
}

/**
 * Judge a candidate against the incumbent. See the module doc for what each gate is for.
 * Order matters: reject on evidence of harm, wait on lack of evidence, and only then
 * consider promoting.
 */
export function auditVerdict(candidate: RecipeStats, incumbent: RecipeStats, rules: AuditRules = AUDIT_RULES): AuditResult {
  const cItems = nonNeg(candidate?.items);
  const cConfirmed = nonNeg(candidate?.confirmed);
  const cBad = nonNeg(candidate?.contradicted);
  const iConfirmed = nonNeg(incumbent?.confirmed);

  const reported = cConfirmed + cBad;
  const precision = reported > 0 ? cConfirmed / reported : 1;
  const yieldRatio = ratio(cConfirmed, iConfirmed);
  const completenessRatio = ratio(num(candidate?.fieldCompleteness, 0), num(incumbent?.fieldCompleteness, 0));
  const requestRatio = ratio(
    perWindow(candidate?.requests, candidate?.windows),
    perWindow(incumbent?.requests, incumbent?.windows),
  );
  const out = (verdict: AuditVerdict, reason: string): AuditResult => ({ verdict, reason, precision, yieldRatio, completenessRatio, requestRatio });

  // ── harm first ────────────────────────────────────────────────────────────────
  if (precision < rules.minPrecision) {
    return out("reject", `precision ${(precision * 100).toFixed(0)}% — ${cBad} of ${reported} reported items were contradicted`);
  }

  // ── then: do we know enough to decide? ────────────────────────────────────────
  const windows = nonNeg(candidate?.windows);
  const spanDays = nonNeg(candidate?.spanDays);
  if (windows < rules.minWindows) return out("keep", `only ${windows} of ${rules.minWindows} windows observed so far`);
  if (spanDays < rules.minDays) return out("keep", `only ${spanDays} of ${rules.minDays} days spanned — a single burst proves nothing`);
  if (cItems <= 0) return out("keep", "the candidate has not reported anything yet");

  // ── actively worse? ───────────────────────────────────────────────────────────
  // A collapsed incumbent is the exception: anything that works beats nothing.
  const incumbentCollapsed = iConfirmed === 0;
  if (!incumbentCollapsed && yieldRatio < rules.rejectYieldRatio) {
    return out("reject", `yield ${(yieldRatio * 100).toFixed(0)}% of the incumbent — it finds fewer events`);
  }
  if (completenessRatio < rules.minCompletenessRatio) {
    return out("keep", `records are less complete than the incumbent's (${(completenessRatio * 100).toFixed(0)}%)`);
  }
  if (requestRatio > rules.maxRequestRatio) {
    return out("keep", `costs the host ${requestRatio.toFixed(1)}× the requests — politeness is not negotiable for a yield bump`);
  }

  // ── better enough to be worth a swap? ─────────────────────────────────────────
  if (incumbentCollapsed) return out("promote", `the live recipe now finds nothing; this one finds ${cConfirmed}`);
  if (yieldRatio >= rules.minYieldRatio) {
    return out("promote", `finds ${(yieldRatio * 100 - 100).toFixed(0)}% more, at equal or better completeness and no extra request cost`);
  }
  if (completenessRatio > 1 && yieldRatio >= 1) {
    return out("promote", `same yield with ${(completenessRatio * 100 - 100).toFixed(0)}% more complete records`);
  }
  return out("keep", "not materially better than the incumbent — a replacement has to earn it");
}
