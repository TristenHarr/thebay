/**
 * The evidence ladder, as pure logic.
 *
 * This is the accuracy gate of the whole track. Two failures would be
 * unacceptable in public and both are asserted here:
 *
 *   1. An evidence tier silently upgrading itself — "@ann says an intro led to
 *      her round" quietly becoming "confirmed by both".
 *   2. A `platform` co-occurrence being reported as causation — the edge merely
 *      predates the outcome; we know nothing about why.
 */
import { describe, it, expect } from "vitest";
import {
  EVIDENCE_TIERS,
  EVIDENCE_RANK,
  describeAttribution,
  assertsCausation,
  strongestEvidence,
  rollUpOutcome,
  upgradeEvidence,
  normalizeWeights,
  outcomeHeadline,
  type Evidence,
} from "../src/core/attribution/ledger";

/** Words that assert one thing produced another. A correlation may use none. */
const CAUSAL_WORDS = /\b(led to|because|caused|resulted in|thanks to|produced|drove)\b/i;

describe("evidence tiers", () => {
  it("ranks sec > counterparty > self > platform", () => {
    expect(EVIDENCE_RANK.sec).toBeGreaterThan(EVIDENCE_RANK.counterparty);
    expect(EVIDENCE_RANK.counterparty).toBeGreaterThan(EVIDENCE_RANK.self);
    expect(EVIDENCE_RANK.self).toBeGreaterThan(EVIDENCE_RANK.platform);
    expect([...EVIDENCE_TIERS].sort()).toEqual(["counterparty", "platform", "sec", "self"]);
  });

  it("renders each tier distinctly and never conflates them", () => {
    const sec = describeAttribution({ evidence: "sec", causeType: "intro", weight: 1 });
    const both = describeAttribution({ evidence: "counterparty", causeType: "intro", weight: 1, claimedByHandle: "ann", confirmedByHandle: "bo" });
    const mine = describeAttribution({ evidence: "self", causeType: "intro", weight: 1, claimedByHandle: "ann" });
    const corr = describeAttribution({ evidence: "platform", causeType: "event", weight: 0.5, leadMonths: 5 });

    expect(sec.kind).toBe("corroborated");
    expect(both.label).toBe("confirmed by both");
    expect(mine.label).toBe("claimed by @ann");
    expect(corr.label).toBe("met here 5 months before");

    // four tiers, four distinct renderings — a reader can always tell them apart
    expect(new Set([sec.label, both.label, mine.label, corr.label]).size).toBe(4);
    expect(new Set([sec.kind, both.kind, mine.kind, corr.kind]).size).toBe(3);
  });

  it("labels a self-claim without a handle without inventing one", () => {
    expect(describeAttribution({ evidence: "self", causeType: "intro", weight: 1 }).label).toBe("claimed by a participant");
  });

  it("pluralizes and degrades the platform label honestly", () => {
    expect(describeAttribution({ evidence: "platform", causeType: "event", weight: 1, leadMonths: 1 }).label).toBe("met here 1 month before");
    // no measured lead ⇒ say only what we know
    expect(describeAttribution({ evidence: "platform", causeType: "event", weight: 1 }).label).toBe("met here before this outcome");
  });
});

describe("a platform correlation is never causation", () => {
  it("marks platform as non-causal and every other tier as causal", () => {
    expect(assertsCausation("platform")).toBe(false);
    for (const t of ["sec", "counterparty", "self"] as Evidence[]) expect(assertsCausation(t)).toBe(true);
    expect(describeAttribution({ evidence: "platform", causeType: "event", weight: 1, leadMonths: 3 }).causal).toBe(false);
  });

  it("never uses a causal verb in a platform rendering", () => {
    for (const leadMonths of [null, 0, 1, 5, 18]) {
      const r = describeAttribution({ evidence: "platform", causeType: "event", weight: 1, leadMonths });
      expect(r.label).not.toMatch(CAUSAL_WORDS);
      expect(r.kind).toBe("correlation");
    }
  });

  it("does not let a pile of correlations roll up into a corroborated outcome", () => {
    const roll = rollUpOutcome([
      { evidence: "platform", causeType: "event", weight: 1, leadMonths: 5 },
      { evidence: "platform", causeType: "community", weight: 1, leadMonths: 9 },
      { evidence: "platform", causeType: "group", weight: 1, leadMonths: 2 },
    ]);
    expect(roll.tier).toBe("platform");
    expect(roll.causal).toBe(false);
    expect(roll.corroborated).toBe(false);
    expect(roll.label).not.toMatch(CAUSAL_WORDS);
  });

  it("reports the strongest tier present, not an average", () => {
    expect(strongestEvidence(["platform", "self", "platform"])).toBe("self");
    expect(strongestEvidence(["self", "counterparty"])).toBe("counterparty");
    expect(strongestEvidence([])).toBe(null);
    const roll = rollUpOutcome([
      { evidence: "platform", causeType: "event", weight: 1, leadMonths: 5 },
      { evidence: "counterparty", causeType: "intro", weight: 1, claimedByHandle: "ann", confirmedByHandle: "bo" },
    ]);
    expect(roll.tier).toBe("counterparty");
    expect(roll.corroborated).toBe(true);
    expect(roll.counts).toEqual({ sec: 0, counterparty: 1, self: 0, platform: 1 });
  });
});

describe("an evidence tier can never silently upgrade itself", () => {
  it("refuses every upgrade requested by the system with no human behind it", () => {
    for (const from of EVIDENCE_TIERS) {
      for (const to of EVIDENCE_TIERS) {
        const r = upgradeEvidence({ from, to, actor: "system" });
        expect(r.evidence).toBe(from);
        if (from !== to) expect(r.changed).toBe(false);
      }
    }
  });

  it("only allows the specific, human-backed transitions", () => {
    // a person steps forward: a correlation becomes their claim
    expect(upgradeEvidence({ from: "platform", to: "self", actor: "claimant" })).toMatchObject({ evidence: "self", changed: true });
    // the other side corroborates it
    expect(upgradeEvidence({ from: "self", to: "counterparty", actor: "counterparty" })).toMatchObject({ evidence: "counterparty", changed: true });
    // the filing corroborates an already-claimed link
    expect(upgradeEvidence({ from: "self", to: "sec", actor: "ingest" })).toMatchObject({ evidence: "sec", changed: true });
    expect(upgradeEvidence({ from: "counterparty", to: "sec", actor: "ingest" })).toMatchObject({ evidence: "sec", changed: true });
  });

  it("refuses to jump the ladder", () => {
    // nobody claimed it, so nothing can corroborate it
    expect(upgradeEvidence({ from: "platform", to: "counterparty", actor: "counterparty" }).evidence).toBe("platform");
    expect(upgradeEvidence({ from: "platform", to: "sec", actor: "ingest" }).evidence).toBe("platform");
    // the claimant cannot confirm their own claim
    expect(upgradeEvidence({ from: "self", to: "counterparty", actor: "claimant" }).evidence).toBe("self");
    // ingest cannot invent a claim
    expect(upgradeEvidence({ from: "platform", to: "self", actor: "ingest" }).evidence).toBe("platform");
  });

  it("always allows a retraction downwards, and always gives a reason", () => {
    const down = upgradeEvidence({ from: "counterparty", to: "self", actor: "counterparty" });
    expect(down).toMatchObject({ evidence: "self", changed: true });
    expect(down.reason).toBeTruthy();
    expect(upgradeEvidence({ from: "self", to: "self", actor: "claimant" }).changed).toBe(false);
    expect(upgradeEvidence({ from: "platform", to: "counterparty", actor: "system" }).reason).toBeTruthy();
  });
});

describe("shared credit", () => {
  it("normalizes weights so one outcome can never be counted twice", () => {
    const w = normalizeWeights([
      { evidence: "self", causeType: "intro", weight: 1, claimedByHandle: "a" },
      { evidence: "self", causeType: "event", weight: 1, claimedByHandle: "a" },
    ]);
    expect(w.map((x) => x.weight)).toEqual([0.5, 0.5]);
    expect(w.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1);
  });

  it("leaves a single cause at full weight and survives zeroes", () => {
    expect(normalizeWeights([{ evidence: "self", causeType: "intro", weight: 1, claimedByHandle: "a" }])[0]!.weight).toBe(1);
    expect(normalizeWeights([])).toEqual([]);
    const zeroed = normalizeWeights([
      { evidence: "platform", causeType: "event", weight: 0 },
      { evidence: "platform", causeType: "group", weight: 0 },
    ]);
    expect(zeroed.map((x) => x.weight)).toEqual([0.5, 0.5]); // never divides by zero
  });
});

describe("the outcome headline is about the outcome, not the cause", () => {
  it("prints the Form D figure only when the round really came from a filing", () => {
    expect(outcomeHeadline({ kind: "funding", amountUsd: 4_200_000, roundSource: "sec" })).toBe("$4.2M · Form D");
    expect(outcomeHeadline({ kind: "funding", amountUsd: 4_200_000, roundSource: "news" })).toBe("$4.2M · reported");
    expect(outcomeHeadline({ kind: "funding", amountUsd: null, roundSource: "sec" })).toBe("Form D filed");
    expect(outcomeHeadline({ kind: "hire", amountUsd: null, roundSource: null })).toBe("hire");
  });

  it("formats money at a readable scale without lying about precision", () => {
    expect(outcomeHeadline({ kind: "funding", amountUsd: 750_000, roundSource: "sec" })).toBe("$750K · Form D");
    expect(outcomeHeadline({ kind: "funding", amountUsd: 12_000_000, roundSource: "sec" })).toBe("$12M · Form D");
    expect(outcomeHeadline({ kind: "funding", amountUsd: 1_500_000_000, roundSource: "sec" })).toBe("$1.5B · Form D");
    expect(outcomeHeadline({ kind: "funding", amountUsd: 900, roundSource: "sec" })).toBe("$900 · Form D");
  });
});
