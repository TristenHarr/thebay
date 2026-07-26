/**
 * AttributionRepo — outcomes, the evidence ladder in the database, and the
 * leaderboards that read them.
 *
 * The two things that must never happen in public, both asserted here:
 *   - a `platform` co-occurrence rendered or aggregated as if somebody claimed it;
 *   - an opted-out member appearing anywhere on a board.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/d1";
import { AttributionRepo } from "../src/storage/d1/attribution-repo";
import { CompaniesRepo } from "../src/storage/d1/companies-repo";

let db: any, raw: any, repo: AttributionRepo;
beforeEach(() => {
  ({ d1: db, raw } = makeTestDb());
  repo = new AttributionRepo(db);
});

function mkUser(id: string, name: string, handle = id) {
  raw.prepare("INSERT INTO users (id, email, handle, display_name, social_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, '2026-01-01', '2026-01-01')").run(id, `${id}@x.com`, handle, name);
  return id;
}
function mkEvent(id: string, hostId: string | null, startUtc = "2026-01-10T18:00:00Z", venue = "Frontier Tower") {
  raw.prepare(
    `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at, venue_name, host_user_id)
     VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'sf', 'https://x/'||?, ?, '2026-01-01', '2026-01-01', ?, ?)`,
  ).run(id, `fp-${id}`, `Event ${id}`, startUtc, id, `ch-${id}`, venue, hostId);
  return id;
}
function rsvp(userId: string, eventId: string) {
  raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?, ?, 'went', '2026-01-11')").run(userId, eventId);
}
function mkIntro(forwardId: string, requesterId: string, connectorId: string, targetId: string) {
  raw.prepare("INSERT INTO intro_requests (id, requester_id, target_desc, target_user_id, status, created_at) VALUES (?, ?, 'x', ?, 'matched', '2026-01-01')").run(`req-${forwardId}`, requesterId, targetId);
  raw.prepare("INSERT INTO intro_forwards (id, request_id, connector_id, status, created_at) VALUES (?, ?, ?, 'accepted', '2026-01-02')").run(forwardId, `req-${forwardId}`, connectorId);
  return forwardId;
}
async function mkFundedCompany(amount = 4_200_000, adsh = "0001-26-000001") {
  const c = new CompaniesRepo(db);
  const r = await c.upsertFromFormD({
    cik: "1987654", accessionNumber: adsh, entityName: "Acme Robotics, Inc.", yearOfInc: 2022,
    street: null, city: "San Francisco", state: "CA", industryGroup: "Technology",
    totalOfferingAmount: amount, totalAmountSold: amount, minimumInvestmentAccepted: null,
    dateOfFirstSale: "2026-06-01", relatedPersons: [], filedAt: "2026-06-10",
    sourceUrl: "https://sec.gov/x",
  });
  return r!;
}

describe("recording an outcome", () => {
  it("stores a funding outcome against its company and round", async () => {
    mkUser("ann", "Ann Lee");
    const { companyId, roundId } = await mkFundedCompany();
    const id = await repo.recordOutcome("ann", { kind: "funding", companyId, roundId, occurredAt: "2026-06-10" });
    const o = await repo.outcome(id, "ann");
    expect(o).toMatchObject({ kind: "funding", companyId, roundId, visibility: "public", amountUsd: 4_200_000, roundSource: "sec" });
    expect(o!.headline).toBe("$4.2M · Form D");
  });

  it("rejects an outcome kind the schema does not know", async () => {
    mkUser("ann", "Ann Lee");
    await expect(repo.recordOutcome("ann", { kind: "vibes" as any })).rejects.toThrow();
  });
});

describe("the evidence ladder in the database", () => {
  beforeEach(() => {
    mkUser("ann", "Ann Lee");
    mkUser("conn", "Connie Connector");
    mkUser("bo", "Bo Nakamura");
  });

  it("a self-claim is 'self', is stamped, and names its claimant", async () => {
    mkIntro("f1", "ann", "conn", "bo");
    const outcomeId = await repo.recordOutcome("ann", { kind: "funding" });
    expect(await repo.claimAttribution("ann", outcomeId, { causeType: "intro", causeId: "f1" })).toBe("claimed");
    const [a] = (await repo.outcome(outcomeId, "ann"))!.attributions;
    expect(a).toMatchObject({ evidence: "self", causeType: "intro", label: "claimed by @conn".replace("conn", "ann") });
    expect(a!.claimedAt).toBeTruthy();
    expect(a!.causal).toBe(true);
  });

  it("only the counterparty of the cause can corroborate it — and never the claimant", async () => {
    mkIntro("f1", "ann", "conn", "bo");
    const outcomeId = await repo.recordOutcome("ann", { kind: "funding" });
    await repo.claimAttribution("ann", outcomeId, { causeType: "intro", causeId: "f1" });
    const attrId = (await repo.outcome(outcomeId, "ann"))!.attributions[0]!.id;

    expect(await repo.confirmAttribution("ann", attrId)).toBe("forbidden"); // self-corroboration
    expect(await repo.confirmAttribution("bo", attrId)).toBe("forbidden"); // not the connector
    expect(await repo.confirmAttribution("conn", attrId)).toBe("confirmed");

    const [a] = (await repo.outcome(outcomeId, "ann"))!.attributions;
    expect(a).toMatchObject({ evidence: "counterparty", label: "confirmed by both", kind: "corroborated" });
  });

  it("a platform correlation is machine-derived, non-causal, and claimed by nobody", async () => {
    const e1 = mkEvent("e1", "conn", "2026-01-10T18:00:00Z");
    const outcomeId = await repo.recordOutcome("ann", { kind: "funding", occurredAt: "2026-06-10T00:00:00Z" });
    expect(await repo.recordPlatformCorrelation(outcomeId, { causeType: "event", causeId: e1 })).toBe("recorded");

    const [a] = (await repo.outcome(outcomeId, "ann"))!.attributions;
    expect(a).toMatchObject({ evidence: "platform", kind: "correlation", causal: false });
    expect(a!.label).toBe("met here 5 months before"); // Jan 10 → Jun 10
    expect(a!.claimedBy).toBeNull();
    expect(a!.claimedAt).toBeNull();
    expect(a!.label).not.toMatch(/\b(led to|because|caused|resulted in)\b/i);
  });

  it("refuses a platform correlation that does not actually predate the outcome", async () => {
    const e1 = mkEvent("e1", "conn", "2026-12-01T18:00:00Z");
    const outcomeId = await repo.recordOutcome("ann", { kind: "funding", occurredAt: "2026-06-10T00:00:00Z" });
    expect(await repo.recordPlatformCorrelation(outcomeId, { causeType: "event", causeId: e1 })).toBe("not_before");
    expect((await repo.outcome(outcomeId, "ann"))!.attributions).toEqual([]);
  });

  it("will not let a correlation be corroborated — nobody claimed it", async () => {
    const e1 = mkEvent("e1", "conn", "2026-01-10T18:00:00Z");
    const outcomeId = await repo.recordOutcome("ann", { kind: "funding", occurredAt: "2026-06-10T00:00:00Z" });
    await repo.recordPlatformCorrelation(outcomeId, { causeType: "event", causeId: e1 });
    const attrId = (await repo.outcome(outcomeId, "ann"))!.attributions[0]!.id;
    expect(await repo.confirmAttribution("conn", attrId)).toBe("forbidden");
    expect((await repo.outcome(outcomeId, "ann"))!.attributions[0]!.evidence).toBe("platform");
  });

  it("lets a party turn their own correlation into a claim, which is then corroborable", async () => {
    const e1 = mkEvent("e1", "conn", "2026-01-10T18:00:00Z");
    const outcomeId = await repo.recordOutcome("ann", { kind: "funding", occurredAt: "2026-06-10T00:00:00Z" });
    await repo.recordPlatformCorrelation(outcomeId, { causeType: "event", causeId: e1 });
    expect(await repo.claimAttribution("ann", outcomeId, { causeType: "event", causeId: e1 })).toBe("claimed");
    expect((await repo.outcome(outcomeId, "ann"))!.attributions[0]!.evidence).toBe("self");
  });

  it("only the outcome's owner may claim a cause for it", async () => {
    mkIntro("f1", "ann", "conn", "bo");
    const outcomeId = await repo.recordOutcome("ann", { kind: "funding" });
    expect(await repo.claimAttribution("bo", outcomeId, { causeType: "intro", causeId: "f1" })).toBe("forbidden");
    expect(await repo.claimAttribution("ann", "no-such-outcome", { causeType: "intro", causeId: "f1" })).toBe("unknown");
    expect(await repo.claimAttribution("ann", outcomeId, { causeType: "intro", causeId: "no-such-forward" })).toBe("unknown");
  });

  it("re-claiming the same cause is idempotent, not a duplicate row", async () => {
    mkIntro("f1", "ann", "conn", "bo");
    const outcomeId = await repo.recordOutcome("ann", { kind: "funding" });
    await repo.claimAttribution("ann", outcomeId, { causeType: "intro", causeId: "f1" });
    expect(await repo.claimAttribution("ann", outcomeId, { causeType: "intro", causeId: "f1" })).toBe("claimed");
    expect((await repo.outcome(outcomeId, "ann"))!.attributions.length).toBe(1);
  });

  it("does NOT silently downgrade a corroborated attribution when it is re-claimed", async () => {
    mkIntro("f1", "ann", "conn", "bo");
    const outcomeId = await repo.recordOutcome("ann", { kind: "funding" });
    await repo.claimAttribution("ann", outcomeId, { causeType: "intro", causeId: "f1" });
    const attrId = (await repo.outcome(outcomeId, "ann"))!.attributions[0]!.id;
    await repo.confirmAttribution("conn", attrId);
    await repo.claimAttribution("ann", outcomeId, { causeType: "intro", causeId: "f1" });
    expect((await repo.outcome(outcomeId, "ann"))!.attributions[0]!.evidence).toBe("counterparty");
  });

  it("SEC corroboration only reaches an already-claimed link, never a bare correlation", async () => {
    const { companyId, roundId } = await mkFundedCompany();
    const e1 = mkEvent("e1", "conn", "2026-01-10T18:00:00Z");
    mkIntro("f1", "ann", "conn", "bo");
    const outcomeId = await repo.recordOutcome("ann", { kind: "funding", companyId, roundId, occurredAt: "2026-06-10T00:00:00Z" });
    await repo.recordPlatformCorrelation(outcomeId, { causeType: "event", causeId: e1 });
    await repo.claimAttribution("ann", outcomeId, { causeType: "intro", causeId: "f1" });

    expect(await repo.corroborateFromSec(outcomeId)).toBe(1); // the claim only
    const byCause = Object.fromEntries((await repo.outcome(outcomeId, "ann"))!.attributions.map((a) => [a.causeType, a.evidence]));
    expect(byCause).toEqual({ intro: "sec", event: "platform" });
  });

  it("corroborates by round, which is how the ingest path reaches it", async () => {
    const { companyId, roundId } = await mkFundedCompany();
    mkIntro("f1", "ann", "conn", "bo");
    const outcomeId = await repo.recordOutcome("ann", { kind: "funding", companyId, roundId, occurredAt: "2026-06-10T00:00:00Z" });
    await repo.claimAttribution("ann", outcomeId, { causeType: "intro", causeId: "f1" });
    expect(await repo.corroborateSecRound(roundId)).toBe(1);
    expect((await repo.outcome(outcomeId, "ann"))!.attributions[0]!.evidence).toBe("sec");
    expect(await repo.corroborateSecRound(roundId)).toBe(0); // idempotent
    expect(await repo.corroborateSecRound("no-such-round")).toBe(0);
  });

  it("does not corroborate anything when the outcome has no SEC round behind it", async () => {
    mkIntro("f1", "ann", "conn", "bo");
    const outcomeId = await repo.recordOutcome("ann", { kind: "funding" });
    await repo.claimAttribution("ann", outcomeId, { causeType: "intro", causeId: "f1" });
    expect(await repo.corroborateFromSec(outcomeId)).toBe(0);
  });
});

describe("visibility and the opt-out", () => {
  beforeEach(() => {
    mkUser("ann", "Ann Lee");
    mkUser("friend", "A Friend");
    mkUser("stranger", "A Stranger");
    const [low, high] = ["ann", "friend"].sort();
    raw.prepare("INSERT INTO friendships (user_low, user_high, status, requested_by, created_at, updated_at) VALUES (?, ?, 'accepted', 'ann', '2026-01-01', '2026-01-01')").run(low, high);
  });

  it("honours public / network / private", async () => {
    const pub = await repo.recordOutcome("ann", { kind: "funding", visibility: "public" });
    const net = await repo.recordOutcome("ann", { kind: "hire", visibility: "network" });
    const priv = await repo.recordOutcome("ann", { kind: "job", visibility: "private" });

    expect((await repo.outcomesForUser("ann", "ann")).map((o) => o.id).sort()).toEqual([net, priv, pub].sort());
    expect((await repo.outcomesForUser("ann", "friend")).map((o) => o.id).sort()).toEqual([net, pub].sort());
    expect((await repo.outcomesForUser("ann", "stranger")).map((o) => o.id)).toEqual([pub]);
    expect((await repo.outcomesForUser("ann")).map((o) => o.id)).toEqual([pub]); // anonymous
    expect(await repo.outcome(priv, "stranger")).toBeNull();
  });

  it("opting out hides everything from everyone but the member themselves", async () => {
    const pub = await repo.recordOutcome("ann", { kind: "funding", visibility: "public" });
    await repo.setOptOut("ann", true);
    expect(await repo.optedOut("ann")).toBe(true);
    expect(await repo.outcomesForUser("ann", "stranger")).toEqual([]);
    expect(await repo.outcomesForUser("ann", "friend")).toEqual([]);
    expect(await repo.outcome(pub, "stranger")).toBeNull();
    expect((await repo.outcomesForUser("ann", "ann")).map((o) => o.id)).toEqual([pub]); // their own view is unchanged
    await repo.setOptOut("ann", false);
    expect((await repo.outcomesForUser("ann", "stranger")).map((o) => o.id)).toEqual([pub]);
  });
});

describe("leaderboards", () => {
  beforeEach(async () => {
    mkUser("ann", "Ann Lee");
    mkUser("conn", "Connie Connector");
    mkUser("bo", "Bo Nakamura");
    mkEvent("e1", "conn", "2026-01-10T18:00:00Z", "Frontier Tower");
    mkEvent("e2", "bo", "2026-02-10T18:00:00Z", "SHACK15");
    rsvp("ann", "e1");
    mkIntro("f1", "ann", "conn", "bo");
    raw.prepare("INSERT INTO communities (id, name, created_by, created_at) VALUES ('cm1','AI Infra','conn','2026-01-01')").run();
    raw.prepare("INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES ('cm1','ann','member','2026-01-02')").run();

    const { companyId, roundId } = await mkFundedCompany(4_200_000);
    const outcomeId = await repo.recordOutcome("ann", { kind: "funding", companyId, roundId, occurredAt: "2026-06-10T00:00:00Z" });
    await repo.claimAttribution("ann", outcomeId, { causeType: "intro", causeId: "f1" });
    await repo.claimAttribution("ann", outcomeId, { causeType: "event", causeId: "e1" });
    await repo.claimAttribution("ann", outcomeId, { causeType: "community", causeId: "cm1" });
  });

  it("credits super-connectors for the outcomes their intros are attributed to", async () => {
    const rows = await repo.superConnectors();
    const connie = rows.find((r) => r.handle === "conn")!;
    expect(connie.intros).toBe(1);
    expect(connie.outcomes).toBe(1);
    // credit is SHARED across the three causes, so one round can't be counted thrice
    expect(connie.attributedUsd).toBe(1_400_000);
    expect(rows[0]!.handle).toBe("conn");
  });

  it("gives events, communities, venues and hosts their own track record", async () => {
    const events = await repo.eventTrackRecord();
    expect(events[0]).toMatchObject({ eventId: "e1", title: "Event e1", outcomes: 1, attributedUsd: 1_400_000 });

    const communities = await repo.communityTrackRecord();
    expect(communities[0]).toMatchObject({ communityId: "cm1", name: "AI Infra", outcomes: 1, attributedUsd: 1_400_000 });

    const venues = await repo.venueBoard();
    expect(venues[0]).toMatchObject({ venue: "Frontier Tower", attributedUsd: 1_400_000 });

    const hosts = await repo.hostBoard();
    expect(hosts[0]).toMatchObject({ handle: "conn", attributedUsd: 1_400_000 });
  });

  it("counts an event only when the outcome lands inside the 12-month window", async () => {
    const later = await repo.recordOutcome("ann", { kind: "funding", occurredAt: "2029-01-01T00:00:00Z" });
    await repo.claimAttribution("ann", later, { causeType: "event", causeId: "e1" });
    const events = await repo.eventTrackRecord();
    expect(events.find((e) => e.eventId === "e1")!.outcomes).toBe(1); // the 3-years-later one is not credited
  });

  it("EXCLUDES an opted-out member from every board", async () => {
    await repo.setOptOut("ann", true);
    expect((await repo.superConnectors()).find((r) => r.handle === "conn")!.attributedUsd).toBe(0);
    expect(await repo.eventTrackRecord()).toEqual([]);
    expect(await repo.communityTrackRecord()).toEqual([]);
    expect(await repo.venueBoard()).toEqual([]);
    expect(await repo.hostBoard()).toEqual([]);
  });

  it("never lets a bare platform correlation raise a track record", async () => {
    const outcomeId = await repo.recordOutcome("bo", { kind: "funding", occurredAt: "2026-06-10T00:00:00Z" });
    await repo.recordPlatformCorrelation(outcomeId, { causeType: "event", causeId: "e2" });
    const e2 = (await repo.eventTrackRecord()).find((e) => e.eventId === "e2");
    expect(e2).toBeUndefined(); // correlations are reported separately, never as a track record
  });
});

describe("outcome density (what Track A's ranking reads)", () => {
  beforeEach(async () => {
    mkUser("ann", "Ann Lee");
    mkUser("conn", "Connie");
    mkEvent("e1", "conn", "2026-01-10T18:00:00Z");
    mkEvent("e2", "conn", "2026-01-11T18:00:00Z");
    const { companyId, roundId } = await mkFundedCompany();
    const o = await repo.recordOutcome("ann", { kind: "funding", companyId, roundId, occurredAt: "2026-06-10T00:00:00Z" });
    await repo.claimAttribution("ann", o, { causeType: "event", causeId: "e1" });
    await repo.recordPlatformCorrelation(o, { causeType: "event", causeId: "e2" });
  });

  it("reports claims and correlations SEPARATELY, per cause", async () => {
    const d = await repo.outcomeDensity("event");
    expect(d.e1).toMatchObject({ outcomes: 1, claimed: 1, correlated: 0, corroborated: 0 });
    expect(d.e2).toMatchObject({ outcomes: 1, claimed: 0, correlated: 1, corroborated: 0 });
    expect(d.e1!.attributedUsd).toBeGreaterThan(0);
    expect(d.e2!.attributedUsd).toBe(0); // a correlation contributes no money to a ranking
  });

  it("can be narrowed to a set of ids, chunked under D1's parameter cap", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `ghost-${i}`);
    const d = await repo.outcomeDensity("event", [...ids, "e1"]);
    expect(Object.keys(d)).toEqual(["e1"]);
  });

  it("returns an empty map rather than throwing for an unknown cause type", async () => {
    expect(await repo.outcomeDensity("mentor")).toEqual({});
    expect(await repo.outcomeDensity("event", [])).toEqual({});
  });
});
