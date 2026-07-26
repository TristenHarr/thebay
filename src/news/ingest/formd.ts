/**
 * Form D mining — the structured filing behind the news story.
 *
 * `sec.ts` searches EDGAR for Bay Area filings and turns each into a headline.
 * That headline is the news product; this file is the DATA product. The same
 * search response also carries the CIK and the accession number, and the filing
 * those two address contains what actually matters to a founder reading this
 * site: how much was raised, how much has sold, when the first sale was, and —
 * the part nobody else surfaces — the named executives, directors and promoters
 * on the filing.
 *
 * EDGAR ACCESS RULES (see the header of sec.ts — these are conditions of use):
 *   - `SEC_USER_AGENT` is mandatory. Without it EDGAR returns 403.
 *   - No more than 10 requests/second.
 * We therefore fetch details sequentially and only {@link FORMD_BUDGET} of them
 * per 15-minute cron tick, exactly as `PREVIEW_BUDGET` / `SUMMARY_BUDGET` bound
 * the other per-tick work in `ingest/index.ts`.
 *
 * House rule for ingestion (src/sources/types.ts): SKIP BAD ITEMS, NEVER ABORT
 * THE RUN. A `primary_doc.xml` that 500s costs one filing, not the harvest.
 *
 * XML is parsed with a small scoped string/regex reader rather than a dependency.
 * The scoping matters and is tested: a Form D contains an issuer address AND one
 * address per related person, all using `<city>`, so a document-wide search for
 * "the city" would happily return a director's home town.
 */
import { SEC_USER_AGENT, isBayLocation } from "./sec";

/** Detail fetches per cron tick. Bounded so a tick stays cheap and polite. */
export const FORMD_BUDGET = 8;

/** What the EDGAR full-text search knows about a filing, before we open it. */
export interface SecFilingRef {
  /** No leading zeros — that is the form the Archives path wants. */
  cik: string;
  /** Accession number, dashed: 0001987654-26-000003. */
  adsh: string;
  form: string;
  entityName: string;
  location: string;
  filedAt: string | null;
}

export interface FormDPerson {
  name: string;
  /** 'Executive Officer' | 'Director' | 'Promoter', as the filing spells them. */
  relationships: string[];
}

export interface FormDFiling {
  cik: string;
  accessionNumber: string;
  entityName: string;
  yearOfInc: number | null;
  street: string | null;
  city: string | null;
  state: string | null;
  industryGroup: string | null;
  totalOfferingAmount: number | null;
  totalAmountSold: number | null;
  minimumInvestmentAccepted: number | null;
  dateOfFirstSale: string | null;
  relatedPersons: FormDPerson[];
  filedAt: string | null;
  sourceUrl: string;
}

// ── tiny scoped XML reader ───────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&"); // last, so &amp;lt; doesn't become a tag
}

/** Inner text of the first `<name>…</name>`, or null. Self-closing ⇒ null. */
function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  if (!m) return null;
  const v = decodeEntities(m[1] ?? "").trim();
  return v === "" ? null : v;
}

/** Inner contents of every `<name>…</name>` occurrence. */
function blocks(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1] ?? "");
  return out;
}

/** Whole-dollar amount, or null. EDGAR writes "Indefinite" for open-ended funds
 *  and we refuse to invent a number for it. */
function amount(raw: string | null): number | null {
  if (raw == null) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits || !/\d/.test(raw)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

const stripZeros = (cik: string) => String(cik ?? "").replace(/^0+/, "");

// ── the parsers ──────────────────────────────────────────────────────────────

/**
 * The structured filing. Returns null rather than a half-parsed record — an
 * EDGAR error page is HTML, and a filing with no issuer name is not usable.
 */
export function parseFormD(xml: string): Omit<FormDFiling, "accessionNumber" | "sourceUrl" | "filedAt"> | null {
  if (!xml || !/<edgarSubmission/i.test(xml)) return null;

  // SCOPE FIRST. Every one of these fields also appears inside a related person's
  // address block further down the document.
  const issuer = blocks(xml, "primaryIssuer")[0] ?? "";
  const entityName = tag(issuer, "entityName");
  if (!entityName) return null;

  const address = blocks(issuer, "issuerAddress")[0] ?? "";
  const yearBlock = blocks(issuer, "yearOfInc")[0] ?? "";
  const yearRaw = tag(yearBlock, "value");
  const year = yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;

  const offering = blocks(xml, "offeringData")[0] ?? "";
  const sales = blocks(offering, "offeringSalesAmounts")[0] ?? "";
  const firstSaleBlock = blocks(offering, "dateOfFirstSale")[0] ?? "";
  const firstSale = tag(firstSaleBlock, "value"); // absent when <yetToOccur>true</yetToOccur>

  const persons: FormDPerson[] = [];
  const personsList = blocks(xml, "relatedPersonsList")[0] ?? "";
  for (const p of blocks(personsList, "relatedPersonInfo")) {
    const nameBlock = blocks(p, "relatedPersonName")[0] ?? "";
    const name = [tag(nameBlock, "firstName"), tag(nameBlock, "middleName"), tag(nameBlock, "lastName")]
      .filter(Boolean)
      .join(" ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!name) continue; // skip the bad item, keep the filing
    const relBlock = blocks(p, "relatedPersonRelationshipList")[0] ?? "";
    persons.push({ name, relationships: blocks(relBlock, "relationship").map((r) => decodeEntities(r).trim()).filter(Boolean) });
  }

  return {
    cik: stripZeros(tag(issuer, "cik") ?? ""),
    entityName,
    yearOfInc: year,
    street: tag(address, "street1"),
    city: tag(address, "city"),
    state: tag(address, "stateOrCountry"),
    industryGroup: tag(blocks(offering, "industryGroup")[0] ?? "", "industryGroupType"),
    totalOfferingAmount: amount(tag(sales, "totalOfferingAmount")),
    totalAmountSold: amount(tag(sales, "totalAmountSold")),
    minimumInvestmentAccepted: amount(tag(offering, "minimumInvestmentAccepted")),
    dateOfFirstSale: firstSale,
    relatedPersons: persons,
  };
}

/** The company name EDGAR shows, without its "(CIK 000…)" suffix. */
function cleanName(displayName: string): string {
  return String(displayName ?? "")
    .replace(/\s*\(CIK\s+\d+\)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The same EDGAR full-text response `parseSec` reads, but keeping the identifiers
 * it discards. Bay Area filers only, one ref per accession (a filing has several
 * documents and the search returns one hit per document).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseSecFilings(payload: any): SecFilingRef[] {
  const hits: any[] = payload?.hits?.hits ?? [];
  const out: SecFilingRef[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const src = h?._source ?? {};
    const locations: string[] = Array.isArray(src.biz_locations) ? src.biz_locations : [];
    if (!locations.some(isBayLocation)) continue;
    const adsh = String(src.adsh ?? "");
    const cik = stripZeros(String((Array.isArray(src.ciks) ? src.ciks[0] : "") ?? ""));
    const entityName = cleanName((Array.isArray(src.display_names) ? src.display_names[0] : "") ?? "");
    if (!adsh || !cik || !entityName || seen.has(adsh)) continue;
    seen.add(adsh);
    out.push({
      cik,
      adsh,
      form: String(src.form ?? "D"),
      entityName,
      location: locations.find(isBayLocation) ?? "",
      filedAt: src.file_date ? String(src.file_date) : null,
    });
  }
  return out;
}

/** Where EDGAR serves the machine-readable filing. */
export function primaryDocUrl(cik: string, adsh: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${stripZeros(cik)}/${String(adsh ?? "").replace(/-/g, "")}/primary_doc.xml`;
}

/** One filing's detail. Null on ANY failure — the caller keeps going. */
export async function fetchFormD(ref: SecFilingRef, fetchImpl: typeof fetch = fetch): Promise<FormDFiling | null> {
  const url = primaryDocUrl(ref.cik, ref.adsh);
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/xml", "user-agent": SEC_USER_AGENT } });
    if (!res.ok) return null;
    const parsed = parseFormD(await res.text());
    if (!parsed) return null;
    return {
      ...parsed,
      // Trust the search result's CIK when the document omits it.
      cik: parsed.cik || ref.cik,
      accessionNumber: ref.adsh,
      filedAt: ref.filedAt,
      sourceUrl: url,
    };
  } catch {
    return null;
  }
}

export interface FormDHarvest {
  filings: FormDFiling[];
  /** How much of the budget was actually spent. */
  attempted: number;
  /** One entry per filing that could not be read. Never fatal. */
  failures: string[];
}

/**
 * Up to `budget` Form D details, sequentially. Only form 'D' — a Reg CF or S-1
 * accession has a completely different primary document and mining it here would
 * produce garbage, so those are skipped rather than mis-parsed.
 */
export async function harvestFormD(
  refs: SecFilingRef[],
  fetchImpl: typeof fetch = fetch,
  budget: number = FORMD_BUDGET,
): Promise<FormDHarvest> {
  const out: FormDHarvest = { filings: [], attempted: 0, failures: [] };
  const queue = (Array.isArray(refs) ? refs : []).filter((r) => r && r.form === "D" && r.cik && r.adsh);
  for (const ref of queue.slice(0, Math.max(0, budget))) {
    out.attempted++;
    const filing = await fetchFormD(ref, fetchImpl);
    if (filing) out.filings.push(filing);
    else out.failures.push(`formd:${ref.adsh}`);
  }
  return out;
}
