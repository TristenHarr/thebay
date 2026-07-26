/**
 * Why we believe an edge exists.
 *
 * This is the whole point of the feature. The graph is not meant to say "you're connected
 * to Sam" — it is meant to say *"you and Sam both checked in at Founders Night on 3 March"*
 * and be able to prove it. So every edge carries at least one `GraphEvidence`, and every
 * `GraphEvidence` names the ROW it came from.
 *
 * ## Three tiers, deliberately NOT the `attributions` vocabulary
 *
 * `migrations/0019` grades claims about CAUSE with `sec | counterparty | self | platform`,
 * and `src/core/attribution/ledger.ts` renders those as "confirmed by both" and so on. These
 * tiers grade something different: how we know the RELATION happened. Conflating the two
 * would let a renderer print a co-attendance badged as "SEC-corroborated", which is worse
 * than printing nothing.
 *
 *   attested — a row nobody could have written for themselves alone: a check-in against a
 *              host-issued code, a redeemed proximity invite, a photo tagging two people.
 *   stated   — somebody said so: a friendship, an RSVP, a self-declared role.
 *   inferred — we noticed a coincidence. Asserts nothing, and must never render as a verb.
 *
 * ## `source` is what makes evidence testable
 *
 * `{ table, keys }` is not decoration. It is what lets `tests/graph-evidence.test.ts` take
 * every edge in a projection, SELECT its source row back out, and fail if it isn't there.
 * Without it, "the graph cites its sources" is a claim in a comment; with it, it's a test.
 */

export const GRAPH_EVIDENCE_TIERS = ["attested", "stated", "inferred"] as const;
export type GraphEvidenceTier = (typeof GRAPH_EVIDENCE_TIERS)[number];

/** Ordering for "show the strongest reason". Mirrors `EVIDENCE_RANK` in the attribution
 *  ledger — same idea, different question. */
export const TIER_RANK: Record<GraphEvidenceTier, number> = { attested: 3, stated: 2, inferred: 1 };

export interface GraphEvidence {
  tier: GraphEvidenceTier;
  /** The row that IS the evidence. Auditable: a test can SELECT it back. */
  source: { table: string; keys: Record<string, string> };
  /** When the evidenced thing happened. Null when the source row carries no time. */
  at: string | null;
  /** The intermediate node for a derived edge (`co_attended`). Absent ⇒ direct. */
  via?: { id: string; type: string; label: string } | null;
  /** Everything the sentence needs, pre-resolved — the renderer never re-queries. */
  detail?: Record<string, string | number | null>;
}

/**
 * Does this tier assert a fact?
 *
 * `inferred` does not, and the renderer must reflect that: an inferred edge is drawn dashed
 * and described without a verb ("both appear near this venue", never "met here"). Mirrors
 * `assertsCausation` in the attribution ledger.
 */
export function assertsFact(t: GraphEvidenceTier): boolean {
  return t !== "inferred";
}

/**
 * The strongest tier in a set. Returns null for an empty set.
 *
 * Never averages. Two stated reasons do not add up to an attested one — an edge is as good
 * as its best evidence, and saying otherwise would let volume launder weak claims.
 */
export function strongestTier(tiers: readonly GraphEvidenceTier[]): GraphEvidenceTier | null {
  let best: GraphEvidenceTier | null = null;
  for (const t of tiers) if (!best || TIER_RANK[t] > TIER_RANK[best]) best = t;
  return best;
}

/** Build an evidence record, with the source keys stringified so they round-trip through
 *  JSON and can be compared against SQL output without type surprises. */
export function evidenceOf(
  tier: GraphEvidenceTier,
  table: string,
  keys: Record<string, string | number | null | undefined>,
  at: string | null,
  extra?: { via?: GraphEvidence["via"]; detail?: GraphEvidence["detail"] },
): GraphEvidence {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(keys)) if (v !== null && v !== undefined) clean[k] = String(v);
  return { tier, source: { table, keys: clean }, at, ...(extra?.via ? { via: extra.via } : {}), ...(extra?.detail ? { detail: extra.detail } : {}) };
}
