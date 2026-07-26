/**
 * Companies over HTTP — the public surface of the funding graph.
 *
 * The headline assertion of this file (and of Track E): AN UNCONFIRMED MATCH
 * NEVER APPEARS PUBLICLY WELDED TO A @HANDLE. The Form D itself is public record
 * and we publish it; "@annlee raised $4.2M" requires Ann.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { CompaniesRepo } from "../src/storage/d1/companies-repo";
import type { FormDFiling } from "../src/news/ingest/formd";

let t: TestApp;
beforeEach(() => { t = makeTestApp(); });

const FILING: FormDFiling = {
  cik: "1987654", accessionNumber: "0001987654-26-000003", entityName: "Acme Robotics, Inc.", yearOfInc: 2022,
  street: "500 Treat Ave", city: "San Francisco", state: "CA", industryGroup: "Technology",
  totalOfferingAmount: 4_200_000, totalAmountSold: 3_100_000, minimumInvestmentAccepted: 25_000,
  dateOfFirstSale: "2026-06-15",
  relatedPersons: [{ name: "Ann Lee", relationships: ["Executive Officer"] }, { name: "Bo Nakamura", relationships: ["Director"] }],
  filedAt: "2026-07-21", sourceUrl: "https://www.sec.gov/Archives/edgar/data/1987654/000198765426000003/primary_doc.xml",
};
const seed = (f: Partial<FormDFiling> = {}) => new CompaniesRepo(t.env.DB).upsertFromFormD({ ...FILING, ...f });

describe("GET /api/companies", () => {
  it("lists Bay filers publicly, with the latest amount, and searches", async () => {
    await seed();
    await seed({ cik: "222", accessionNumber: "0000222-26-1", entityName: "Zeta Bio, Inc.", filedAt: "2026-07-25", totalOfferingAmount: 9_000_000, relatedPersons: [] });

    const r = await call(t, "/api/companies");
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(2);
    expect(r.json.companies[0]).toMatchObject({ name: "Zeta Bio, Inc.", latestAmountUsd: 9_000_000 });

    expect((await call(t, "/api/companies?q=acme")).json.companies.map((c: any) => c.slug)).toEqual(["acme-robotics"]);
    expect((await call(t, "/api/companies?limit=1")).json.companies.length).toBe(1);
  });

  it("404s an unknown company rather than 500ing", async () => {
    expect((await call(t, "/api/companies/nope")).status).toBe(404);
  });
});

describe("GET /api/companies/:slug — the accuracy gate", () => {
  it("publishes the filing and its named people, and NO handle for an unconfirmed name", async () => {
    await login(t, "ann@acme.test", "Ann Lee"); // a real member with the same name
    await seed();

    const r = await call(t, "/api/companies/acme-robotics");
    expect(r.status).toBe(200);
    expect(r.json.company).toMatchObject({ name: "Acme Robotics, Inc.", cik: "1987654", city: "San Francisco" });
    expect(r.json.rounds[0]).toMatchObject({ amountUsd: 4_200_000, source: "sec", kind: "form-d" });
    expect(r.json.rounds[0].stage).toBeNull(); // a Form D states no stage

    // the names are public record and rendered...
    expect(r.json.people.map((p: any) => p.personName).sort()).toEqual(["Ann Lee", "Bo Nakamura"]);
    // ...but nothing is welded to an account
    expect(r.json.people.every((p: any) => p.confirmed === false && p.handle === null && p.userId === null)).toBe(true);
    expect(JSON.stringify(r.json)).not.toMatch(/annlee|ann-lee/i);
  });

  it("shows the handle once — and only once — the person confirms", async () => {
    const ann = await login(t, "ann@acme.test", "Ann Lee");
    const { companyId } = (await seed())!;

    const matches = await call(t, "/api/me/company-matches", { cookie: ann.cookie });
    expect(matches.status).toBe(200);
    expect(matches.json.matches[0].question).toContain("Are you the Ann Lee listed as Executive Officer");
    expect(matches.json.matches[0].candidate.score).toBeLessThan(1);

    const ok = await call(t, `/api/companies/${companyId}/people/confirm`, {
      method: "POST", cookie: ann.cookie, body: { personName: "Ann Lee", role: "Executive Officer" },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.result).toBe("confirmed");

    const after = await call(t, "/api/companies/acme-robotics");
    const annRow = after.json.people.find((p: any) => p.personName === "Ann Lee");
    expect(annRow).toMatchObject({ confirmed: true, handle: ann.user.handle });
    // Bo never confirmed and is still just a name on a document
    expect(after.json.people.find((p: any) => p.personName === "Bo Nakamura")).toMatchObject({ confirmed: false, handle: null });
  });

  it("refuses a claim from someone the deterministic matcher never proposed", async () => {
    const mallory = await login(t, "m@x.com", "Mallory Malfeasance");
    const { companyId } = (await seed())!;
    expect((await call(t, "/api/me/company-matches", { cookie: mallory.cookie })).json.matches).toEqual([]);
    const bad = await call(t, `/api/companies/${companyId}/people/confirm`, {
      method: "POST", cookie: mallory.cookie, body: { personName: "Ann Lee", role: "Executive Officer" },
    });
    expect(bad.status).toBe(403);
    expect(bad.json.result).toBe("not_a_candidate");
    expect((await call(t, "/api/companies/acme-robotics")).json.people.every((p: any) => p.handle === null)).toBe(true);
  });

  it("guards every write and validates its body", async () => {
    const { companyId } = (await seed())!;
    expect((await call(t, "/api/me/company-matches")).status).toBe(401);
    expect((await call(t, `/api/companies/${companyId}/people/confirm`, { method: "POST", body: { personName: "Ann Lee", role: "Executive Officer" } })).status).toBe(401);
    const { cookie } = await login(t, "ann@acme.test", "Ann Lee");
    expect((await call(t, `/api/companies/${companyId}/people/confirm`, { method: "POST", cookie, body: {} })).status).toBe(400);
    expect((await call(t, `/api/companies/${companyId}/people/confirm`, { method: "POST", cookie, body: { personName: "Ghost", role: "Director" } })).status).toBe(404);
  });

  it("lets the holder release a match they confirmed by mistake", async () => {
    const ann = await login(t, "ann@acme.test", "Ann Lee");
    const { companyId } = (await seed())!;
    await call(t, `/api/companies/${companyId}/people/confirm`, { method: "POST", cookie: ann.cookie, body: { personName: "Ann Lee", role: "Executive Officer" } });
    const rel = await call(t, `/api/companies/${companyId}/people/release`, { method: "POST", cookie: ann.cookie, body: { personName: "Ann Lee", role: "Executive Officer" } });
    expect(rel.json.released).toBe(true);
    expect((await call(t, "/api/companies/acme-robotics")).json.people.every((p: any) => p.handle === null)).toBe(true);
  });
});

describe("self-declared employment (/api/me/companies)", () => {
  it("round-trips a declaration and creates the company", async () => {
    const { cookie } = await login(t, "ann@acme.test", "Ann Lee");
    expect((await call(t, "/api/me/companies", { cookie })).json.companies).toEqual([]);

    const created = await call(t, "/api/me/companies", { method: "POST", cookie, body: { name: "Newco Labs", role: "founder", title: "CEO" } });
    expect(created.status).toBe(200);
    expect((await call(t, "/api/me/companies", { cookie })).json.companies[0]).toMatchObject({ name: "Newco Labs", role: "founder", title: "CEO" });
    expect((await call(t, "/api/companies?q=newco")).json.total).toBe(1);
  });

  it("validates the body and requires auth", async () => {
    expect((await call(t, "/api/me/companies")).status).toBe(401);
    const { cookie } = await login(t, "ann@acme.test", "Ann Lee");
    expect((await call(t, "/api/me/companies", { method: "POST", cookie, body: { role: "founder" } })).status).toBe(400);
    expect((await call(t, "/api/me/companies", { method: "POST", cookie, body: { name: "   ", role: "founder" } })).status).toBe(400);
  });

  it("adopts what the LinkedIn importer has been storing all along", async () => {
    const me = await login(t, "me@x.com", "Me");
    const bo = await login(t, "bo@personal.test", "Bo Nakamura");
    const imported = await call(t, "/api/integrations/linkedin/import", {
      method: "POST", cookie: me.cookie,
      body: { items: [{ externalId: "li:bo", kind: "connection", payload: { name: "Bo Nakamura", email: "bo@personal.test", company: "Acme Robotics", position: "Co-Founder" } }] },
    });
    expect(imported.json.imported).toBe(1);

    const adopt = await call(t, "/api/me/companies/import", { method: "POST", cookie: bo.cookie });
    expect(adopt.json.adopted).toBe(1);
    expect((await call(t, "/api/me/companies", { cookie: bo.cookie })).json.companies[0]).toMatchObject({ name: "Acme Robotics", title: "Co-Founder", source: "import" });
  });
});
