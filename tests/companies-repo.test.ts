/**
 * CompaniesRepo — the funding graph over the real schema (D1-over-SQLite shim,
 * so FK / CHECK / UNIQUE are genuinely enforced).
 *
 * The invariant this file exists to hold: A NAME ON A FILING IS NOT AN ACCOUNT.
 * Form D data is public record and we publish it; the link from a filing name to
 * a `@handle` is a claim about a real person and only that person may make it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/d1";
import { CompaniesRepo } from "../src/storage/d1/companies-repo";
import type { FormDFiling } from "../src/news/ingest/formd";

let db: any, raw: any, repo: CompaniesRepo;
beforeEach(() => {
  ({ d1: db, raw } = makeTestDb());
  repo = new CompaniesRepo(db);
});

const FILING: FormDFiling = {
  cik: "1987654",
  accessionNumber: "0001987654-26-000003",
  entityName: "Acme Robotics & Co, Inc.",
  yearOfInc: 2022,
  street: "500 Treat Ave",
  city: "San Francisco",
  state: "CA",
  industryGroup: "Technology",
  totalOfferingAmount: 4_200_000,
  totalAmountSold: 3_100_000,
  minimumInvestmentAccepted: 25_000,
  dateOfFirstSale: "2026-06-15",
  relatedPersons: [
    { name: "Ann Lee", relationships: ["Executive Officer", "Director"] },
    { name: "Bo Q. Nakamura", relationships: ["Promoter"] },
  ],
  filedAt: "2026-07-21",
  sourceUrl: "https://www.sec.gov/Archives/edgar/data/1987654/000198765426000003/primary_doc.xml",
};

function mkUser(id: string, name: string, email: string, handle = id) {
  raw.prepare(
    "INSERT INTO users (id, email, handle, display_name, social_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, '2026-01-01', '2026-01-01')",
  ).run(id, email, handle, name);
  return id;
}
function befriend(a: string, b: string) {
  const [low, high] = a < b ? [a, b] : [b, a];
  raw.prepare("INSERT INTO friendships (user_low, user_high, status, requested_by, created_at, updated_at) VALUES (?, ?, 'accepted', ?, '2026-01-01', '2026-01-01')").run(low, high, a);
}
function mkStory(id: string, adsh: string) {
  raw.prepare("INSERT INTO stories (id, kind, title, url, origin, created_at) VALUES (?, 'link', ?, ?, 'sec', '2026-07-21')").run(id, `Filing ${adsh}`, `https://sec.gov/${adsh}`);
  raw.prepare("INSERT INTO story_sources (story_id, origin, external_id, fetched_at) VALUES (?, 'sec', ?, '2026-07-21')").run(id, adsh);
}

describe("upsertFromFormD", () => {
  it("stores the company, the round and every named person", async () => {
    const r = (await repo.upsertFromFormD(FILING))!;
    expect(r.companyCreated).toBe(true);
    expect(r.roundCreated).toBe(true);
    expect(r.people).toBe(3); // Ann×2 roles + Bo×1

    const c = await repo.bySlug("acme-robotics");
    expect(c!.company).toMatchObject({ name: "Acme Robotics & Co, Inc.", cik: "1987654", city: "San Francisco", state: "CA", industry: "Technology", yearFounded: 2022, source: "sec" });
    expect(c!.rounds[0]).toMatchObject({ kind: "form-d", amountUsd: 4_200_000, amountSoldUsd: 3_100_000, filedAt: "2026-07-21", firstSaleAt: "2026-06-15", source: "sec", externalId: "0001987654-26-000003" });
    expect(c!.people.map((p) => `${p.personName}:${p.role}`).sort()).toEqual(["Ann Lee:Director", "Ann Lee:Executive Officer", "Bo Q. Nakamura:Promoter"]);
  });

  it("never guesses a stage from an amount — a Form D does not state one", async () => {
    await repo.upsertFromFormD(FILING);
    expect((await repo.bySlug("acme-robotics"))!.rounds[0]!.stage).toBeNull();
  });

  it("is idempotent: re-harvesting the same accession changes nothing", async () => {
    await repo.upsertFromFormD(FILING);
    const second = (await repo.upsertFromFormD(FILING))!;
    expect(second.companyCreated).toBe(false);
    expect(second.roundCreated).toBe(false);
    expect(raw.prepare("SELECT COUNT(*) n FROM companies").get().n).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) n FROM funding_rounds").get().n).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) n FROM company_people").get().n).toBe(3);
  });

  it("converges on ONE company for a second filing by the same CIK, and updates the amount", async () => {
    await repo.upsertFromFormD(FILING);
    await repo.upsertFromFormD({ ...FILING, accessionNumber: "0001987654-27-000001", entityName: "ACME ROBOTICS INC", totalAmountSold: 4_200_000, filedAt: "2027-02-02" });
    expect(raw.prepare("SELECT COUNT(*) n FROM companies").get().n).toBe(1);
    const c = await repo.bySlug("acme-robotics");
    expect(c!.rounds.length).toBe(2);
    expect(c!.rounds[0]!.filedAt).toBe("2027-02-02"); // newest first
  });

  it("gives a same-named company from a different CIK its own slug", async () => {
    await repo.upsertFromFormD(FILING);
    await repo.upsertFromFormD({ ...FILING, cik: "999", accessionNumber: "0000999-26-000001", relatedPersons: [] });
    const slugs = raw.prepare("SELECT slug FROM companies ORDER BY slug").all().map((r: any) => r.slug);
    expect(slugs).toEqual(["acme-robotics", "acme-robotics-2"]);
  });

  it("stores every person UNRESOLVED — no user_id, no matter how obvious the name", async () => {
    mkUser("u-ann", "Ann Lee", "ann@acmerobotics.com", "annlee");
    await repo.upsertFromFormD(FILING);
    const rows = raw.prepare("SELECT user_id, source, confirmed_at FROM company_people").all();
    expect(rows.every((r: any) => r.user_id === null)).toBe(true);
    expect(rows.every((r: any) => r.source === "sec")).toBe(true);
    expect(rows.every((r: any) => r.confirmed_at === null)).toBe(true);
  });

  it("skips a filing with no usable company name instead of throwing", async () => {
    const bad = await repo.upsertFromFormD({ ...FILING, entityName: "   ", cik: "" });
    expect(bad).toBeNull();
    expect(raw.prepare("SELECT COUNT(*) n FROM companies").get().n).toBe(0);
  });

  it("survives a filing with no money and no people", async () => {
    const r = await repo.upsertFromFormD({ ...FILING, totalOfferingAmount: null, totalAmountSold: null, dateOfFirstSale: null, relatedPersons: [] });
    expect(r!.roundCreated).toBe(true);
    expect(r!.people).toBe(0);
  });
});

describe("the schema itself refuses a fabricated link", () => {
  it("rejects a user_id on a row that was not self-confirmed", async () => {
    mkUser("u-ann", "Ann Lee", "ann@acmerobotics.com");
    const { companyId } = (await repo.upsertFromFormD(FILING))!;
    expect(() =>
      raw.prepare("UPDATE company_people SET user_id='u-ann' WHERE company_id=? AND person_name='Ann Lee'").run(companyId),
    ).toThrow(/CHECK/i);
  });

  it("rejects a resolved row with no record of when it was confirmed", () => {
    mkUser("u-ann", "Ann Lee", "ann@acmerobotics.com");
    raw.prepare("INSERT INTO companies (id,name,slug,source,created_at,updated_at) VALUES ('c1','C','c','user','2026-01-01','2026-01-01')").run();
    expect(() =>
      raw.prepare("INSERT INTO company_people (company_id,person_name,user_id,role,source,created_at) VALUES ('c1','Ann Lee','u-ann','Director','self','2026-01-01')").run(),
    ).toThrow(/CHECK/i);
  });

  it("rejects a duplicate SEC accession outright", async () => {
    const { companyId } = (await repo.upsertFromFormD(FILING))!;
    expect(() =>
      raw.prepare("INSERT INTO funding_rounds (id,company_id,kind,source,external_id,created_at) VALUES ('r9',?, 'form-d','sec','0001987654-26-000003','2026-01-01')").run(companyId),
    ).toThrow(/UNIQUE/i);
  });
});

describe("identity resolution: candidates are questions, not answers", () => {
  beforeEach(async () => {
    mkUser("u-ann", "Ann Lee", "ann@acmerobotics.com", "annlee");
    mkUser("u-zed", "Zed Zenith", "zed@elsewhere.io", "zed");
    await repo.upsertFromFormD({ ...FILING, relatedPersons: [{ name: "Ann Lee", relationships: ["Executive Officer"] }] });
    // the domain signal needs a domain on the company; SEC filings don't carry one
    raw.prepare("UPDATE companies SET domain='acmerobotics.com'").run();
  });

  it("offers Ann her own match with the signals spelled out and a real question", async () => {
    const m = await repo.candidatesForUser("u-ann");
    expect(m.length).toBe(1);
    expect(m[0]!.company.slug).toBe("acme-robotics");
    expect(m[0]!.person).toMatchObject({ personName: "Ann Lee", role: "Executive Officer" });
    expect(m[0]!.candidate.signals).toEqual(expect.arrayContaining(["name:exact", "domain:email"]));
    expect(m[0]!.question).toBe("Are you the Ann Lee listed as Executive Officer of Acme Robotics & Co, Inc. on this Form D?");
  });

  it("offers nothing to someone whose name does not match", async () => {
    expect(await repo.candidatesForUser("u-zed")).toEqual([]);
    expect(await repo.candidatesForUser("nobody")).toEqual([]);
  });

  it("stops offering a match once it is confirmed", async () => {
    await repo.confirmPerson("u-ann", (await repo.candidatesForUser("u-ann"))[0]!.person.companyId, "Ann Lee", "Executive Officer");
    expect(await repo.candidatesForUser("u-ann")).toEqual([]);
  });

  it("confirming welds the handle, records the moment, and declares the employment", async () => {
    const companyId = (await repo.candidatesForUser("u-ann"))[0]!.person.companyId;
    expect(await repo.confirmPerson("u-ann", companyId, "Ann Lee", "Executive Officer")).toBe("confirmed");
    const row = raw.prepare("SELECT * FROM company_people WHERE company_id=? AND person_name='Ann Lee'").get(companyId);
    expect(row.user_id).toBe("u-ann");
    expect(row.source).toBe("self");
    expect(row.confirmed_at).toBeTruthy();
    // a confirmed filing role is also a self-declaration of where they work
    expect(raw.prepare("SELECT COUNT(*) n FROM user_companies WHERE user_id='u-ann' AND company_id=?").get(companyId).n).toBe(1);
  });

  it("REFUSES a claim from someone who was never a candidate", async () => {
    const companyId = (await repo.candidatesForUser("u-ann"))[0]!.person.companyId;
    expect(await repo.confirmPerson("u-zed", companyId, "Ann Lee", "Executive Officer")).toBe("not_a_candidate");
    expect(raw.prepare("SELECT user_id FROM company_people WHERE company_id=?").get(companyId).user_id).toBeNull();
  });

  it("refuses a second claim on an already-resolved row, and an unknown row", async () => {
    const companyId = (await repo.candidatesForUser("u-ann"))[0]!.person.companyId;
    await repo.confirmPerson("u-ann", companyId, "Ann Lee", "Executive Officer");
    mkUser("u-ann3", "Ann Lee", "ann@acmerobotics.com".replace("ann@", "ann3@"), "annlee3");
    expect(await repo.confirmPerson("u-ann3", companyId, "Ann Lee", "Executive Officer")).toBe("taken");
    expect(await repo.confirmPerson("u-ann", companyId, "Nobody At All", "Director")).toBe("unknown");
  });
});

describe("public rendering never welds an unconfirmed name to a handle", () => {
  it("shows the filing name and role, and no account, until it is confirmed", async () => {
    mkUser("u-ann", "Ann Lee", "ann@acmerobotics.com", "annlee");
    const { companyId } = (await repo.upsertFromFormD(FILING))!;
    raw.prepare("UPDATE companies SET domain='acmerobotics.com'").run();

    const before = await repo.bySlug("acme-robotics");
    const ann = before!.people.find((p) => p.personName === "Ann Lee" && p.role === "Executive Officer")!;
    expect(ann.personName).toBe("Ann Lee"); // public record, still shown
    expect(ann.handle).toBeNull();
    expect(ann.userId).toBeNull();
    expect(ann.confirmed).toBe(false);
    expect(JSON.stringify(before)).not.toContain("annlee");

    await repo.confirmPerson("u-ann", companyId, "Ann Lee", "Executive Officer");
    const after = await repo.bySlug("acme-robotics");
    const annAfter = after!.people.find((p) => p.role === "Executive Officer")!;
    expect(annAfter.handle).toBe("annlee");
    expect(annAfter.confirmed).toBe(true);
    // the OTHER roles are still unresolved and still handle-free
    expect(after!.people.filter((p) => p.confirmed).length).toBe(1);
  });
});

describe("stories ↔ companies", () => {
  it("links a filing's news story to its company by accession number", async () => {
    await repo.upsertFromFormD(FILING);
    mkStory("s1", "0001987654-26-000003");
    mkStory("s2", "0000000000-26-999999"); // an unrelated SEC story
    expect(await repo.linkStoriesByAccession()).toBe(1);
    expect(await repo.linkStoriesByAccession()).toBe(0); // idempotent

    const facts = await repo.factsForStories(["s1", "s2"]);
    expect(facts.s1).toMatchObject({ name: "Acme Robotics & Co, Inc.", slug: "acme-robotics", amountUsd: 4_200_000, roundSource: "sec" });
    expect(facts.s2).toBeUndefined();
  });

  it("counts CONFIRMED people in the viewer's network — and only confirmed ones", async () => {
    mkUser("me", "Me", "me@x.com");
    mkUser("u-ann", "Ann Lee", "ann@acmerobotics.com", "annlee");
    befriend("me", "u-ann");
    const { companyId } = (await repo.upsertFromFormD(FILING))!;
    raw.prepare("UPDATE companies SET domain='acmerobotics.com'").run();
    mkStory("s1", "0001987654-26-000003");
    await repo.linkStoriesByAccession();

    // unconfirmed ⇒ nobody is in your network yet
    expect((await repo.factsForStories(["s1"], "me")).s1!.peopleInNetwork).toBe(0);
    await repo.confirmPerson("u-ann", companyId, "Ann Lee", "Executive Officer");
    expect((await repo.factsForStories(["s1"], "me")).s1!.peopleInNetwork).toBe(1);
    // a stranger sees the filing, but no network count
    expect((await repo.factsForStories(["s1"], "u-ann")).s1!.peopleInNetwork).toBe(0);
    expect((await repo.factsForStories(["s1"])).s1!.peopleInNetwork).toBe(0);
  });

  it("chunks the story-id list well under D1's 100-parameter cap", async () => {
    await repo.upsertFromFormD(FILING);
    const ids = Array.from({ length: 250 }, (_, i) => `s${i}`);
    for (const id of ids) mkStory(id, `adsh-${id}`);
    mkStory("real", "0001987654-26-000003");
    await repo.linkStoriesByAccession();
    const facts = await repo.factsForStories([...ids, "real"], "nobody");
    expect(Object.keys(facts)).toEqual(["real"]); // no D1_ERROR thrown
  });
});

describe("self-declared employment (users had no company field at all)", () => {
  it("lets a member say where they work, creating the company if needed", async () => {
    mkUser("u-ann", "Ann Lee", "ann@acmerobotics.com", "annlee");
    const id = await repo.declareCompany("u-ann", { name: "Newco Labs", role: "founder", title: "CEO" });
    expect(id).toBeTruthy();
    const mine = await repo.companiesForUser("u-ann");
    expect(mine).toEqual([expect.objectContaining({ name: "Newco Labs", role: "founder", title: "CEO", source: "self", slug: "newco-labs" })]);
    // idempotent on (user, company, role)
    await repo.declareCompany("u-ann", { name: "Newco Labs", role: "founder", title: "Chief Executive" });
    expect((await repo.companiesForUser("u-ann")).length).toBe(1);
    expect((await repo.companiesForUser("u-ann"))[0]!.title).toBe("Chief Executive");
  });

  it("attaches a declaration to an existing SEC company rather than forking it", async () => {
    mkUser("u-ann", "Ann Lee", "ann@acmerobotics.com", "annlee");
    await repo.upsertFromFormD(FILING);
    await repo.declareCompany("u-ann", { name: "ACME ROBOTICS, INC.", role: "founder" });
    expect(raw.prepare("SELECT COUNT(*) n FROM companies").get().n).toBe(1);
  });

  it("refuses an empty company name", async () => {
    mkUser("u-ann", "Ann Lee", "ann@acmerobotics.com", "annlee");
    expect(await repo.declareCompany("u-ann", { name: "  ", role: "founder" })).toBeNull();
  });

  it("reads the LinkedIn company/position the importer has always written and nothing ever read", async () => {
    mkUser("me", "Me", "me@x.com");
    mkUser("u-bo", "Bo Q. Nakamura", "bo@personal.com", "bo");
    // ME imported MY connections; one of them is Bo, who is also a member
    raw.prepare(
      "INSERT INTO imported_items (id, user_id, provider, external_id, kind, payload_json, created_at) VALUES ('i1','me','linkedin','li:bo','connection',?, '2026-05-01')",
    ).run(JSON.stringify({ name: "Bo Q. Nakamura", email: "bo@personal.com", company: "Acme Robotics", position: "Co-Founder" }));

    expect(await repo.linkedinSignals("u-bo")).toEqual({ company: "Acme Robotics", position: "Co-Founder" });
    expect(await repo.linkedinSignals("me")).toEqual({ company: null, position: null });

    // ...and Bo can adopt it as his own declaration (his act, not the importer's)
    const adopted = await repo.adoptImportedEmployment("u-bo");
    expect(adopted).toBe(1);
    expect(await repo.companiesForUser("u-bo")).toEqual([expect.objectContaining({ name: "Acme Robotics", title: "Co-Founder", source: "import" })]);
    expect(await repo.adoptImportedEmployment("u-bo")).toBe(0); // idempotent
  });

  it("uses the LinkedIn signal to raise a candidate match", async () => {
    mkUser("me", "Me", "me@x.com");
    mkUser("u-bo", "Bo Q. Nakamura", "bo@personal.com", "bo");
    raw.prepare(
      "INSERT INTO imported_items (id, user_id, provider, external_id, kind, payload_json, created_at) VALUES ('i1','me','linkedin','li:bo','connection',?, '2026-05-01')",
    ).run(JSON.stringify({ name: "Bo Q. Nakamura", email: "bo@personal.com", company: "Acme Robotics", position: "Co-Founder" }));
    await repo.upsertFromFormD(FILING);

    const m = await repo.candidatesForUser("u-bo");
    expect(m.length).toBe(1);
    expect(m[0]!.candidate.signals).toEqual(expect.arrayContaining(["name:exact", "linkedin:company", "linkedin:position"]));
    expect(m[0]!.candidate.score).toBeLessThan(1);
  });
});

describe("listing", () => {
  it("lists newest-filing-first with the latest round attached, and searches by name", async () => {
    await repo.upsertFromFormD(FILING);
    await repo.upsertFromFormD({ ...FILING, cik: "222", accessionNumber: "0000222-26-000001", entityName: "Zeta Bio, Inc.", filedAt: "2026-07-25", totalOfferingAmount: 9_000_000, relatedPersons: [] });

    const all = await repo.list({ limit: 10, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.companies.map((c) => c.name)).toEqual(["Zeta Bio, Inc.", "Acme Robotics & Co, Inc."]);
    expect(all.companies[0]!.latestAmountUsd).toBe(9_000_000);

    expect((await repo.list({ limit: 10, offset: 0, q: "acme" })).companies.map((c) => c.name)).toEqual(["Acme Robotics & Co, Inc."]);
    expect((await repo.list({ limit: 10, offset: 0, q: "nothing here" })).total).toBe(0);
    expect(await repo.bySlug("no-such-company")).toBeNull();
  });

  it("clamps a hostile limit/offset instead of trusting them", async () => {
    await repo.upsertFromFormD(FILING);
    expect((await repo.list({ limit: 100000, offset: -5 })).companies.length).toBe(1);
  });
});

describe("unseenAccessions", () => {
  it("reports which accessions are new, so the per-tick budget is never wasted", async () => {
    await repo.upsertFromFormD(FILING);
    const asked = ["0001987654-26-000003", "0000999-26-000001"];
    expect(await repo.unseenAccessions(asked)).toEqual(["0000999-26-000001"]);
    expect(await repo.unseenAccessions([])).toEqual([]);
  });

  it("chunks well under D1's 100-parameter cap", async () => {
    const many = Array.from({ length: 400 }, (_, i) => `0000001-26-${String(i).padStart(6, "0")}`);
    expect((await repo.unseenAccessions(many)).length).toBe(400);
  });
});
