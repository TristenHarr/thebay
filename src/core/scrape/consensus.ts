/**
 * Consensus — pure, no I/O. Given everything workers reported for one job, decide what
 * we believe.
 *
 * The brief was "hash the results and expect them to match". We do hash (see
 * `observationDigest`), but a whole-payload hash is the wrong thing to *score* on, and
 * understanding why is the key to this module. Two honest workers ninety seconds apart
 * legitimately differ: a new event appeared, pagination shifted, the site A/B-tested an
 * ordering. A digest mismatch tells you *that* they differed with no way to know *what*
 * differed or *who was right* — so it can't distinguish a liar from a worker who looked
 * a minute later. Per-item voting can.
 *
 * So the digest is a fast path (identical digests ⇒ instant mutual confirmation) and
 * per-item agreement is the substrate. Three ideas make it fair:
 *
 * **Independence is by egress, not by account.** Two accounts behind one NAT are one
 * observer wearing two hats. Counting them as two is exactly how a Sybil publishes
 * whatever it likes, so agreement is counted per egress cluster.
 *
 * **You are never punished for being alone.** An item only you reported, when nobody
 * else has finished the job, is `pending` — not wrong. It costs nothing and waits.
 *
 * **Absence only counts as contradiction when the two workers demonstrably saw the same
 * page.** This is the subtle one. If Bob's crawl returned nothing (a 503 he reported as
 * an empty run) his silence is not evidence against Ann. So a contradiction requires the
 * dissenting worker's item set to OVERLAP Ann's substantially — they agreed about most
 * of the page and disagree about this one item. That single condition is what keeps an
 * honest worker whose recipe paginated further from being punished for finding more.
 *
 * A contradiction is never a deletion: the item simply doesn't publish, the reputation
 * hit is refundable, and a later independent sighting flips it back (see `resolve`'s
 * caller in src/worker/routes/network.ts).
 */
import { hash128 } from "../util/hash";
import type { MemberTier } from "../../../shared/schema";

/**
 * How much two workers' item sets must overlap before one's silence counts as evidence
 * against the other. 0.5 is deliberately forgiving: at half the page in common we're
 * clearly looking at the same source, and below that we assume a partial crawl rather
 * than a liar.
 */
export const CONTRADICTION_MIN_OVERLAP = 0.5;

export type ObservationStatus = "pending" | "confirmed" | "contradicted";

export interface ObsInput {
  /** Row id, so the caller can update exactly these. */
  id: string;
  leaseId: string;
  itemKey: string;
}

export interface LeaseInfo {
  leaseId: string;
  memberId: string;
  /** Egress cluster — ipHash, else asn, else the lease id (assume independent). */
  cluster: string;
  tier: MemberTier;
  /** Did this worker actually finish and report? An open lease is not evidence. */
  completed: boolean;
}

export interface Verdict {
  itemKey: string;
  status: ObservationStatus;
  /** The observation rows this verdict applies to. */
  observationIds: string[];
  /** Independent egress clusters that reported it. */
  observers: number;
  /** Independent clusters that finished the job and did NOT report it, with good overlap. */
  dissenters: number;
  /** Who reported it first — the finder, for crediting the discovery. */
  finderMemberIds: string[];
}

/** hash128 of the sorted, unique item keys — the fast path for "we saw the same page". */
export function observationDigest(itemKeys: string[]): string {
  const uniq = [...new Set(itemKeys.filter((k) => typeof k === "string" && k))].sort();
  return hash128(uniq.join(","));
}

/** |A ∩ B| / |A ∪ B|. Zero when either side is empty — an empty crawl agrees with nothing. */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const k of a) if (b.has(k)) inter++;
  return inter / (a.size + b.size - inter);
}

const TIER_MAY_PUBLISH_ALONE = new Set<MemberTier>(["trusted", "core"]);

/**
 * Decide the status of every reported item for one job.
 *
 * Check order is deliberate: contradiction is evaluated BEFORE solo publication, so a
 * trusted member is not immune to evidence. Earning the right to publish alone means
 * "nobody has to corroborate you"; it cannot mean "nobody may disagree with you", or the
 * tier would be a licence rather than a reputation.
 */
export function resolve(input: {
  observations: ObsInput[];
  leases: LeaseInfo[];
  minOverlap?: number;
}): Verdict[] {
  const minOverlap = input.minOverlap ?? CONTRADICTION_MIN_OVERLAP;
  const leaseById = new Map(input.leases.map((l) => [l.leaseId, l]));

  // What each lease reported, and which clusters reported each item.
  const setOfLease = new Map<string, Set<string>>();
  const byItem = new Map<string, ObsInput[]>();
  for (const o of input.observations) {
    if (!leaseById.has(o.leaseId)) continue; // an observation with no lease is not evidence
    (setOfLease.get(o.leaseId) ?? setOfLease.set(o.leaseId, new Set()).get(o.leaseId)!).add(o.itemKey);
    (byItem.get(o.itemKey) ?? byItem.set(o.itemKey, []).get(o.itemKey)!).push(o);
  }

  // Collapse leases to clusters. A cluster that finished anything is a completed observer.
  const completedClusters = new Map<string, Set<string>>(); // cluster -> union of its item keys
  for (const l of input.leases) {
    if (!l.completed) continue;
    const mine = setOfLease.get(l.leaseId) ?? new Set<string>();
    const acc = completedClusters.get(l.cluster);
    if (acc) for (const k of mine) acc.add(k);
    else completedClusters.set(l.cluster, new Set(mine));
  }

  const verdicts: Verdict[] = [];
  for (const [itemKey, obs] of byItem) {
    const reporting = new Set<string>();
    const tiers: MemberTier[] = [];
    const finders: string[] = [];
    for (const o of obs) {
      const l = leaseById.get(o.leaseId)!;
      reporting.add(l.cluster);
      tiers.push(l.tier);
      if (!finders.includes(l.memberId)) finders.push(l.memberId);
    }

    // Clusters that finished the job, didn't report this item, and clearly saw the same
    // page as somebody who did. Anything less than that is not evidence of absence.
    let dissenters = 0;
    for (const [cluster, theirSet] of completedClusters) {
      if (reporting.has(cluster)) continue;
      let sawTheSamePage = false;
      for (const c of reporting) {
        const theirs = completedClusters.get(c);
        if (theirs && overlap(theirs, theirSet) >= minOverlap) {
          sawTheSamePage = true;
          break;
        }
      }
      if (sawTheSamePage) dissenters++;
    }

    const observers = reporting.size;
    let status: ObservationStatus;
    if (observers === 1 && dissenters >= 1) {
      // One worker saw it; at least one independent worker looking at demonstrably the
      // same page did not. Refundable, and never published.
      status = "contradicted";
    } else if (observers >= 2) {
      status = "confirmed";
    } else if (observers === 1 && tiers.some((t) => TIER_MAY_PUBLISH_ALONE.has(t))) {
      status = "confirmed";
    } else {
      // Alone, and nobody else has finished. Costs the reporter nothing; waits.
      status = "pending";
    }

    verdicts.push({ itemKey, status, observationIds: obs.map((o) => o.id), observers, dissenters, finderMemberIds: finders });
  }

  // Stable order so a caller's batched updates are deterministic and diffable.
  return verdicts.sort((a, b) => (a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0));
}
