/**
 * Outcomes and attribution over HTTP.
 *
 * The evidence ladder has to survive the round trip: the four tiers come back
 * rendered distinctly, a `platform` correlation is never returned as causation,
 * and an opted-out member is on no board at all.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { CompaniesRepo } from "../src/storage/d1/companies-repo";
import type { FormDFiling } from "../src/news/ingest/formd";

let t: TestApp;
beforeEach(() => { t = makeTestApp(); });

const FILING: FormDFiling = {
  cik: "1987654", accessionNumber: "0001987654-26-000003", entityName: "Acme Robotics, Inc.", yearOfInc: 2022,
  street: null, city: "San Francisco", state: "CA", industryGroup: "Technology",
  totalOfferingAmount: 4_200_000, totalAmountSold: 4_200_000, minimumInvestmentAccepted: null,
  dateOfFirstSale: "2026-06-01", relatedPersons: [], filedAt: "2026-06-10", sourceUrl: "https://sec.gov/x",
};

async function enableSocial(cookie: string) {
  await call(t, "/api/me", { method: "PATCH", cookie, body: { socialEnabled: true } });
}
async function befriend(a: { cookie: string; user: any }, b: { cookie: string; user: any }) {
  await call(t, `/api/friends/${b.user.id}/request`, { method: "POST", cookie: a.cookie });
  await call(t, `/api/friends/${a.user.id}/respond`, { method: "POST", cookie: b.cookie, body: { accept: true } });
}
/** A real accepted warm intro: asker ← connector → target. Returns the forward id. */
async function warmIntro(asker: any, conn: any, target: any) {
  for (const u of [asker, conn, target]) await enableSocial(u.cookie);
  await befriend(asker, conn);
  await befriend(conn, target);
  const reqId = (await call(t, "/api/intros", { method: "POST", cookie: asker.cookie, body: { targetDesc: "Target", targetUserId: target.user.id } })).json.id;
  const fwd = await call(t, `/api/intros/${reqId}/forward`, { method: "POST", cookie: conn.cookie });
  await call(t, `/api/intros/forward/${fwd.json.forwardId}/accept`, { method: "POST", cookie: target.cookie });
  return fwd.json.forwardId as string;
}

describe("POST /api/outcomes", () => {
  it("records an outcome and shows the SEC headline separately from any cause", async () => {
    const ann = await login(t, "ann@x.com", "Ann Lee");
    const { companyId, roundId } = (await new CompaniesRepo(t.env.DB).upsertFromFormD(FILING))!;
    const created = await call(t, "/api/outcomes", { method: "POST", cookie: ann.cookie, body: { kind: "funding", companyId, roundId, occurredAt: "2026-06-10T00:00:00Z" } });
    expect(created.status).toBe(200);

    const got = await call(t, `/api/outcomes/${created.json.id}`);
    expect(got.json.outcome).toMatchObject({ kind: "funding", headline: "$4.2M · Form D", attributions: [] });
  });

  it("requires auth and validates the kind", async () => {
    expect((await call(t, "/api/outcomes", { method: "POST", body: { kind: "funding" } })).status).toBe(401);
    const { cookie } = await login(t, "ann@x.com", "Ann");
    expect((await call(t, "/api/outcomes", { method: "POST", cookie, body: { kind: "vibes" } })).status).toBe(400);
    expect((await call(t, "/api/outcomes", { method: "POST", cookie, body: { kind: "funding", visibility: "secret" } })).status).toBe(400);
    expect((await call(t, "/api/outcomes/nope")).status).toBe(404);
  });
});

describe("the evidence ladder over HTTP", () => {
  it("walks a claim from 'claimed by @ann' to 'confirmed by both'", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const conn = await login(t, "conn@x.com", "Connie");
    const bo = await login(t, "bo@x.com", "Bo");
    const forwardId = await warmIntro(ann, conn, bo);

    const outcomeId = (await call(t, "/api/outcomes", { method: "POST", cookie: ann.cookie, body: { kind: "funding", occurredAt: "2026-06-10T00:00:00Z" } })).json.id;
    const claimed = await call(t, `/api/outcomes/${outcomeId}/attributions`, { method: "POST", cookie: ann.cookie, body: { causeType: "intro", causeId: forwardId } });
    expect(claimed.status).toBe(200);

    let attrs = (await call(t, `/api/outcomes/${outcomeId}`)).json.outcome.attributions;
    expect(attrs[0]).toMatchObject({ evidence: "self", kind: "claimed", causal: true, label: `claimed by @${ann.user.handle}` });

    // a bystander cannot corroborate; the connector can
    expect((await call(t, `/api/attributions/${attrs[0].id}/confirm`, { method: "POST", cookie: bo.cookie })).status).toBe(403);
    expect((await call(t, `/api/attributions/${attrs[0].id}/confirm`, { method: "POST", cookie: conn.cookie })).status).toBe(200);

    attrs = (await call(t, `/api/outcomes/${outcomeId}`)).json.outcome.attributions;
    expect(attrs[0]).toMatchObject({ evidence: "counterparty", kind: "corroborated", label: "confirmed by both" });
  });

  it("returns a platform correlation as co-occurrence and never as causation", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const host = await login(t, "host@x.com", "Host");
    const eventId = (await call(t, "/api/host", { method: "POST", cookie: host.cookie, body: { title: "Founder Night", startUtc: "2026-01-10T18:00:00Z" } })).json.id;

    const outcomeId = (await call(t, "/api/outcomes", { method: "POST", cookie: ann.cookie, body: { kind: "funding", occurredAt: "2026-06-10T00:00:00Z" } })).json.id;
    const corr = await call(t, `/api/outcomes/${outcomeId}/attributions`, { method: "POST", cookie: ann.cookie, body: { causeType: "event", causeId: eventId, evidence: "platform" } });
    expect(corr.status).toBe(200);

    const [a] = (await call(t, `/api/outcomes/${outcomeId}`)).json.outcome.attributions;
    expect(a).toMatchObject({ evidence: "platform", kind: "correlation", causal: false, label: "met here 5 months before", claimedBy: null });
    expect(a.label).not.toMatch(/\b(led to|because|caused|resulted in)\b/i);
    // and it cannot be corroborated — nobody claimed it
    expect((await call(t, `/api/attributions/${a.id}/confirm`, { method: "POST", cookie: host.cookie })).status).toBe(403);
  });

  it("refuses a claim on somebody else's outcome, and validates the cause", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const bo = await login(t, "bo@x.com", "Bo");
    const outcomeId = (await call(t, "/api/outcomes", { method: "POST", cookie: ann.cookie, body: { kind: "funding" } })).json.id;
    expect((await call(t, `/api/outcomes/${outcomeId}/attributions`, { method: "POST", cookie: bo.cookie, body: { causeType: "intro", causeId: "x" } })).status).toBe(403);
    expect((await call(t, `/api/outcomes/${outcomeId}/attributions`, { method: "POST", cookie: ann.cookie, body: { causeType: "nonsense", causeId: "x" } })).status).toBe(400);
    expect((await call(t, `/api/outcomes/${outcomeId}/attributions`, { method: "POST", cookie: ann.cookie, body: { causeType: "intro", causeId: "ghost" } })).status).toBe(404);
    expect((await call(t, "/api/attributions/ghost/confirm", { method: "POST", cookie: ann.cookie })).status).toBe(404);
  });
});

describe("visibility, the opt-out, and public profiles", () => {
  it("serves a member's public outcomes by handle and hides the rest", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    await enableSocial(ann.cookie);
    await call(t, "/api/outcomes", { method: "POST", cookie: ann.cookie, body: { kind: "funding", visibility: "public" } });
    await call(t, "/api/outcomes", { method: "POST", cookie: ann.cookie, body: { kind: "hire", visibility: "private" } });

    const pub = await call(t, `/api/u/${ann.user.handle}/outcomes`);
    expect(pub.status).toBe(200);
    expect(pub.json.outcomes.map((o: any) => o.kind)).toEqual(["funding"]);
    expect((await call(t, `/api/u/${ann.user.handle}/outcomes`, { cookie: ann.cookie })).json.outcomes.length).toBe(2);
    expect((await call(t, "/api/u/nobody/outcomes")).status).toBe(404);
  });

  it("opting out empties the public view and leaves the member's own untouched", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    await enableSocial(ann.cookie);
    await call(t, "/api/outcomes", { method: "POST", cookie: ann.cookie, body: { kind: "funding", visibility: "public" } });

    const off = await call(t, "/api/me/attribution", { method: "PUT", cookie: ann.cookie, body: { optOut: true } });
    expect(off.json).toMatchObject({ ok: true, optOut: true });
    expect((await call(t, `/api/u/${ann.user.handle}/outcomes`)).json.outcomes).toEqual([]);
    expect((await call(t, "/api/me/outcomes", { cookie: ann.cookie })).json.outcomes.length).toBe(1);

    await call(t, "/api/me/attribution", { method: "PUT", cookie: ann.cookie, body: { optOut: false } });
    expect((await call(t, `/api/u/${ann.user.handle}/outcomes`)).json.outcomes.length).toBe(1);
    expect((await call(t, "/api/me/attribution", { method: "PUT", body: { optOut: true } })).status).toBe(401);
  });
});

describe("GET /api/impact/leaderboard", () => {
  it("serves every board publicly and never lists an opted-out member", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const conn = await login(t, "conn@x.com", "Connie");
    const bo = await login(t, "bo@x.com", "Bo");
    const forwardId = await warmIntro(ann, conn, bo);
    const { companyId, roundId } = (await new CompaniesRepo(t.env.DB).upsertFromFormD(FILING))!;
    const outcomeId = (await call(t, "/api/outcomes", { method: "POST", cookie: ann.cookie, body: { kind: "funding", companyId, roundId, occurredAt: "2026-06-10T00:00:00Z" } })).json.id;
    await call(t, `/api/outcomes/${outcomeId}/attributions`, { method: "POST", cookie: ann.cookie, body: { causeType: "intro", causeId: forwardId } });

    const board = await call(t, "/api/impact/leaderboard?board=connectors");
    expect(board.status).toBe(200);
    expect(board.json.board).toBe("connectors");
    expect(board.json.rows[0]).toMatchObject({ handle: conn.user.handle, intros: 1, outcomes: 1, attributedUsd: 4_200_000 });

    for (const b of ["events", "communities", "venues", "hosts"]) {
      const r = await call(t, `/api/impact/leaderboard?board=${b}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.json.rows)).toBe(true);
    }
    // an unknown board falls back rather than 500ing
    expect((await call(t, "/api/impact/leaderboard?board=wat")).json.board).toBe("connectors");

    // Ann opts out → the credit her round carried disappears from the board
    await call(t, "/api/me/attribution", { method: "PUT", cookie: ann.cookie, body: { optOut: true } });
    const after = await call(t, "/api/impact/leaderboard?board=connectors");
    expect(after.json.rows.find((r: any) => r.handle === conn.user.handle).attributedUsd).toBe(0);
    expect(after.json.rows.some((r: any) => r.handle === ann.user.handle)).toBe(false);
  });

  it("exposes per-cause outcome density with claims and correlations kept apart", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const host = await login(t, "host@x.com", "Host");
    const e1 = (await call(t, "/api/host", { method: "POST", cookie: host.cookie, body: { title: "Night One", startUtc: "2026-01-10T18:00:00Z" } })).json.id;
    const e2 = (await call(t, "/api/host", { method: "POST", cookie: host.cookie, body: { title: "Night Two", startUtc: "2026-01-11T18:00:00Z" } })).json.id;
    const outcomeId = (await call(t, "/api/outcomes", { method: "POST", cookie: ann.cookie, body: { kind: "funding", occurredAt: "2026-06-10T00:00:00Z" } })).json.id;
    await call(t, `/api/outcomes/${outcomeId}/attributions`, { method: "POST", cookie: ann.cookie, body: { causeType: "event", causeId: e1 } });
    await call(t, `/api/outcomes/${outcomeId}/attributions`, { method: "POST", cookie: ann.cookie, body: { causeType: "event", causeId: e2, evidence: "platform" } });

    const d = await call(t, `/api/impact/density?cause=event&ids=${e1},${e2}`);
    expect(d.status).toBe(200);
    expect(d.json.density[e1]).toMatchObject({ claimed: 1, correlated: 0 });
    expect(d.json.density[e2]).toMatchObject({ claimed: 0, correlated: 1 });
    expect((await call(t, "/api/impact/density?cause=nonsense")).status).toBe(400);
  });
});
