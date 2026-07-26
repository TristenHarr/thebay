/**
 * Form D mining — the structured filing behind the news story.
 *
 * `src/news/ingest/sec.ts` already finds Bay Area Form D filings and turns each
 * into a headline, throwing away the CIK, the money and the related-persons list.
 * This is the second stage that keeps them.
 *
 * Two things are load-bearing and both are asserted here:
 *   - the parser is scoped, so the issuer's city is the ISSUER's city and not
 *     some director's home address further down the same document; and
 *   - one bad `primary_doc.xml` costs exactly one filing. That bug class (a
 *     single 500-ing URL taking down a whole run) has already bitten this repo.
 *
 * No network: the fixture is a realistic EDGAR document, inline.
 */
import { describe, it, expect } from "vitest";
import { parseFormD, parseSecFilings, primaryDocUrl, fetchFormD, harvestFormD, FORMD_BUDGET, type SecFilingRef } from "../src/news/ingest/formd";
import { SEC_USER_AGENT } from "../src/news/ingest/sec";

/** A real-shaped Form D primary_doc.xml, trimmed of the parts we never read. */
const PRIMARY_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission>
  <schemaVersion>X0708</schemaVersion>
  <submissionType>D</submissionType>
  <testOrLive>LIVE</testOrLive>
  <primaryIssuer>
    <cik>0001987654</cik>
    <entityName>Acme Robotics &amp; Co, Inc.</entityName>
    <issuerAddress>
      <street1>500 Treat Ave</street1>
      <city>San Francisco</city>
      <stateOrCountry>CA</stateOrCountry>
      <stateOrCountryDescription>CALIFORNIA</stateOrCountryDescription>
      <zipCode>94110</zipCode>
    </issuerAddress>
    <issuerPhoneNumber>4155550100</issuerPhoneNumber>
    <jurisdictionOfInc>DELAWARE</jurisdictionOfInc>
    <issuerPreviousNameList><value>None</value></issuerPreviousNameList>
    <entityType>Corporation</entityType>
    <yearOfInc>
      <withinFiveYears>true</withinFiveYears>
      <value>2022</value>
    </yearOfInc>
  </primaryIssuer>
  <relatedPersonsList>
    <relatedPersonInfo>
      <relatedPersonName>
        <firstName>Ann</firstName>
        <middleName/>
        <lastName>Lee</lastName>
      </relatedPersonName>
      <relatedPersonAddress>
        <street1>9 Grand Ave</street1>
        <city>Oakland</city>
        <stateOrCountry>CA</stateOrCountry>
        <zipCode>94612</zipCode>
      </relatedPersonAddress>
      <relatedPersonRelationshipList>
        <relationship>Executive Officer</relationship>
        <relationship>Director</relationship>
      </relatedPersonRelationshipList>
      <relationshipClarification/>
    </relatedPersonInfo>
    <relatedPersonInfo>
      <relatedPersonName>
        <firstName>Bo</firstName>
        <middleName>Q.</middleName>
        <lastName>Nakamura</lastName>
      </relatedPersonName>
      <relatedPersonAddress>
        <street1>500 Treat Ave</street1>
        <city>San Francisco</city>
        <stateOrCountry>CA</stateOrCountry>
      </relatedPersonAddress>
      <relatedPersonRelationshipList>
        <relationship>Promoter</relationship>
      </relatedPersonRelationshipList>
    </relatedPersonInfo>
  </relatedPersonsList>
  <offeringData>
    <industryGroup>
      <industryGroupType>Technology</industryGroupType>
    </industryGroup>
    <issuerSize><revenueRange>No Revenues</revenueRange></issuerSize>
    <federalExemptionsExclusions><item>06b</item></federalExemptionsExclusions>
    <typeOfFiling>
      <newOrAmendment><isAmendment>false</isAmendment></newOrAmendment>
      <dateOfFirstSale><value>2026-06-15</value></dateOfFirstSale>
    </typeOfFiling>
    <durationOfOffering><moreThanOneYear>false</moreThanOneYear></durationOfOffering>
    <minimumInvestmentAccepted>25000</minimumInvestmentAccepted>
    <salesCompensationList/>
    <offeringSalesAmounts>
      <totalOfferingAmount>4200000</totalOfferingAmount>
      <totalAmountSold>3100000</totalAmountSold>
      <totalRemaining>1100000</totalRemaining>
    </offeringSalesAmounts>
    <investors>
      <hasNonAccreditedInvestors>false</hasNonAccreditedInvestors>
      <totalNumberAlreadyInvested>7</totalNumberAlreadyInvested>
    </investors>
  </offeringData>
</edgarSubmission>`;

/** A pooled-fund filing: indefinite raise, no first sale yet, no related persons. */
const INDEFINITE_DOC = `<?xml version="1.0"?>
<edgarSubmission>
  <submissionType>D</submissionType>
  <primaryIssuer>
    <cik>0002000001</cik>
    <entityName>Bay Seed Fund III, L.P.</entityName>
    <issuerAddress><city>Menlo Park</city><stateOrCountry>CA</stateOrCountry></issuerAddress>
    <yearOfInc><overFiveYears>true</overFiveYears></yearOfInc>
  </primaryIssuer>
  <relatedPersonsList/>
  <offeringData>
    <industryGroup><industryGroupType>Pooled Investment Fund</industryGroupType></industryGroup>
    <typeOfFiling><dateOfFirstSale><yetToOccur>true</yetToOccur></dateOfFirstSale></typeOfFiling>
    <offeringSalesAmounts>
      <totalOfferingAmount>Indefinite</totalOfferingAmount>
      <totalAmountSold>0</totalAmountSold>
    </offeringSalesAmounts>
  </offeringData>
</edgarSubmission>`;

const SEARCH_PAYLOAD = {
  hits: {
    hits: [
      { _source: { ciks: ["0001987654"], display_names: ["Acme Robotics & Co, Inc.  (CIK 0001987654)"], form: "D", file_date: "2026-07-21", biz_locations: ["San Francisco, CA"], adsh: "0001987654-26-000003" } },
      // same filing, second document in the same accession — one ref, not two
      { _source: { ciks: ["0001987654"], display_names: ["Acme Robotics & Co, Inc.  (CIK 0001987654)"], form: "D", file_date: "2026-07-21", biz_locations: ["San Francisco, CA"], adsh: "0001987654-26-000003" } },
      { _source: { ciks: ["0002000001"], display_names: ["Bay Seed Fund III, L.P. (CIK 0002000001)"], form: "D", file_date: "2026-07-20", biz_locations: ["Menlo Park, CA"], adsh: "0002000001-26-000009" } },
      // not Bay Area — dropped
      { _source: { ciks: ["0003"], display_names: ["Kansas REIT (CIK 0000003)"], form: "D", file_date: "2026-07-19", biz_locations: ["Wichita, KS"], adsh: "0000003-26-000001" } },
    ],
  },
};

describe("parseFormD", () => {
  it("pulls the whole structured filing out of primary_doc.xml", () => {
    const f = parseFormD(PRIMARY_DOC)!;
    expect(f).toBeTruthy();
    expect(f.cik).toBe("1987654"); // leading zeros stripped, as EDGAR archive paths want
    expect(f.entityName).toBe("Acme Robotics & Co, Inc."); // XML entities decoded
    expect(f.yearOfInc).toBe(2022);
    expect(f.industryGroup).toBe("Technology");
    expect(f.totalOfferingAmount).toBe(4_200_000);
    expect(f.totalAmountSold).toBe(3_100_000);
    expect(f.minimumInvestmentAccepted).toBe(25_000);
    expect(f.dateOfFirstSale).toBe("2026-06-15");
  });

  it("takes the ISSUER's address, not a director's home address further down the file", () => {
    const f = parseFormD(PRIMARY_DOC)!;
    expect(f.city).toBe("San Francisco"); // NOT Oakland (Ann Lee's address)
    expect(f.state).toBe("CA");
    expect(f.street).toBe("500 Treat Ave");
  });

  it("keeps every related person with all of their relationships", () => {
    const f = parseFormD(PRIMARY_DOC)!;
    expect(f.relatedPersons).toEqual([
      { name: "Ann Lee", relationships: ["Executive Officer", "Director"] },
      { name: "Bo Q. Nakamura", relationships: ["Promoter"] },
    ]);
  });

  it("handles indefinite raises, unfired first sales and an empty persons list", () => {
    const f = parseFormD(INDEFINITE_DOC)!;
    expect(f.entityName).toBe("Bay Seed Fund III, L.P.");
    expect(f.totalOfferingAmount).toBeNull(); // "Indefinite" is not a number — never guess one
    expect(f.totalAmountSold).toBe(0);
    expect(f.dateOfFirstSale).toBeNull(); // yetToOccur
    expect(f.yearOfInc).toBeNull(); // overFiveYears carries no year
    expect(f.relatedPersons).toEqual([]);
    expect(f.city).toBe("Menlo Park");
  });

  it("returns null rather than a half-parsed filing for junk input", () => {
    expect(parseFormD("")).toBeNull();
    expect(parseFormD("<html><body>404 Not Found</body></html>")).toBeNull();
    expect(parseFormD("<edgarSubmission><primaryIssuer></primaryIssuer></edgarSubmission>")).toBeNull(); // no entity name
  });
});

describe("parseSecFilings", () => {
  it("keeps the CIK and accession the news path throws away, Bay Area only, one per filing", () => {
    const refs = parseSecFilings(SEARCH_PAYLOAD);
    expect(refs.map((r) => r.adsh)).toEqual(["0001987654-26-000003", "0002000001-26-000009"]);
    expect(refs[0]).toMatchObject({ cik: "1987654", form: "D", entityName: "Acme Robotics & Co, Inc.", location: "San Francisco, CA", filedAt: "2026-07-21" });
  });

  it("never throws on a malformed payload", () => {
    expect(parseSecFilings(null)).toEqual([]);
    expect(parseSecFilings({ hits: { hits: [{}, { _source: {} }] } })).toEqual([]);
  });

  it("builds the archive URL EDGAR actually serves", () => {
    expect(primaryDocUrl("1987654", "0001987654-26-000003")).toBe(
      "https://www.sec.gov/Archives/edgar/data/1987654/000198765426000003/primary_doc.xml",
    );
  });
});

const REFS: SecFilingRef[] = parseSecFilings(SEARCH_PAYLOAD);

function fakeEdgar(opts: { fail?: string[]; status?: number } = {}) {
  const calls: { url: string; ua: string | null }[] = [];
  const impl = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url ?? input);
    calls.push({ url, ua: init?.headers?.["user-agent"] ?? null });
    if (opts.fail?.some((f) => url.includes(f))) return new Response("", { status: opts.status ?? 500 });
    if (url.includes("/1987654/")) return new Response(PRIMARY_DOC, { status: 200 });
    return new Response(INDEFINITE_DOC, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("fetchFormD", () => {
  it("declares the mandatory EDGAR user-agent", async () => {
    const { impl, calls } = fakeEdgar();
    const f = await fetchFormD(REFS[0]!, impl);
    expect(f?.entityName).toBe("Acme Robotics & Co, Inc.");
    expect(f?.sourceUrl).toContain("primary_doc.xml");
    expect(f?.accessionNumber).toBe("0001987654-26-000003");
    expect(f?.filedAt).toBe("2026-07-21");
    expect(calls[0]!.ua).toBe(SEC_USER_AGENT); // without it EDGAR 403s
  });

  it("returns null — never throws — on a 500, a 403 or a network error", async () => {
    expect(await fetchFormD(REFS[0]!, fakeEdgar({ fail: ["1987654"], status: 500 }).impl)).toBeNull();
    expect(await fetchFormD(REFS[0]!, fakeEdgar({ fail: ["1987654"], status: 403 }).impl)).toBeNull();
    const boom = (async () => { throw new Error("connection reset"); }) as unknown as typeof fetch;
    expect(await fetchFormD(REFS[0]!, boom)).toBeNull();
  });
});

describe("harvestFormD", () => {
  it("fetches the detail for each Form D and reports what it got", async () => {
    const { impl, calls } = fakeEdgar();
    const r = await harvestFormD(REFS, impl);
    expect(r.filings.map((f) => f.entityName)).toEqual(["Acme Robotics & Co, Inc.", "Bay Seed Fund III, L.P."]);
    expect(r.attempted).toBe(2);
    expect(r.failures).toEqual([]);
    expect(calls.length).toBe(2);
  });

  it("is bounded per tick, exactly like PREVIEW_BUDGET / SUMMARY_BUDGET", async () => {
    expect(FORMD_BUDGET).toBe(8);
    const many = Array.from({ length: 20 }, (_, i) => ({ ...REFS[0]!, adsh: `0001987654-26-0000${10 + i}` }));
    const { impl, calls } = fakeEdgar();
    const r = await harvestFormD(many, impl, 3);
    expect(calls.length).toBe(3);
    expect(r.attempted).toBe(3);
    expect(r.filings.length).toBe(3);
  });

  it("costs ONE filing when a primary_doc.xml is broken — not the whole harvest", async () => {
    const { impl } = fakeEdgar({ fail: ["/1987654/"] });
    const r = await harvestFormD(REFS, impl);
    expect(r.filings.map((f) => f.entityName)).toEqual(["Bay Seed Fund III, L.P."]); // the other one still landed
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]).toContain("0001987654-26-000003");
  });

  it("only mines Form D — Reg CF and S-1 primary docs are a different document entirely", async () => {
    const { impl, calls } = fakeEdgar();
    const r = await harvestFormD([{ ...REFS[0]!, form: "S-1" }, { ...REFS[1]!, form: "C" }], impl);
    expect(calls.length).toBe(0);
    expect(r.filings).toEqual([]);
    expect(r.attempted).toBe(0);
  });

  it("survives an empty or junk ref list", async () => {
    const { impl } = fakeEdgar();
    expect((await harvestFormD([], impl)).filings).toEqual([]);
    expect((await harvestFormD(null as any, impl)).filings).toEqual([]);
  });
});
