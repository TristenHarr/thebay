/**
 * SEC EDGAR — Bay Area companies raising private rounds, as they file.
 *
 * This is the most differentiated source on the site. A Form D is what a company
 * files when it sells securities in a private placement, i.e. when it raises. It
 * lands in EDGAR days-to-weeks before anyone writes about the round, and nobody
 * else puts it in a news feed. For a readership of founders and early-stage
 * investors, that's the single most valuable thing here.
 *
 * EDGAR ACCESS RULES — these are conditions of use, not suggestions:
 *   - A User-Agent declaring who we are and how to contact us. Without it EDGAR
 *     returns 403 (verified — an earlier probe with a generic UA was refused).
 *   - No more than 10 requests/second. The 15-minute cron makes one.
 * https://www.sec.gov/os/webmaster-faq#developers
 */
import type { IngestedStory } from "./types";
import { isUsable } from "./types";

/** EDGAR requires a real contact address here. */
export const SEC_USER_AGENT = "thebay.news aggregator contact@thebay.news";
const FTS = "https://efts.sec.gov/LATEST/search-index";

/**
 * Bay Area business locations as EDGAR spells them. Matching on the filer's
 * stated location is the whole point — a Form D from a Kansas REIT is not Bay
 * Area news no matter how large the raise.
 */
const BAY_CITIES = [
  "san francisco", "oakland", "berkeley", "palo alto", "menlo park", "mountain view",
  "sunnyvale", "santa clara", "san jose", "redwood city", "san mateo", "burlingame",
  "cupertino", "fremont", "emeryville", "alameda", "richmond", "walnut creek",
  "san carlos", "belmont", "foster city", "millbrae", "daly city", "south san francisco",
  "los altos", "los gatos", "campbell", "milpitas", "hayward", "san ramon", "pleasanton",
  "dublin", "livermore", "san rafael", "sausalito", "novato", "petaluma", "santa rosa",
];

export function isBayLocation(location: string): boolean {
  const s = String(location ?? "").toLowerCase();
  if (!/,\s*ca$/.test(s.trim())) return false; // California only
  return BAY_CITIES.some((c) => s.startsWith(c + ",") || s.startsWith(c + " "));
}

/**
 * The filing types worth surfacing, each a different moment in a company's life:
 *   D  — a private placement. The company raised. The early-stage signal.
 *   C  — Reg CF crowdfunding. Smaller, earlier, often pre-institutional.
 *   S-1 — the IPO registration. The other end of the same story.
 */
export const FORMS = ["D", "C", "S-1"] as const;

/** Recent filings of one type. Date-bounded so each query stays small. */
export function searchUrl(nowMs: number = Date.now(), days = 7, form: string = "D"): string {
  const end = new Date(nowMs).toISOString().slice(0, 10);
  // S-1s are rare enough that a week's window usually returns nothing; widen it.
  const window = form === "S-1" ? Math.max(days, 45) : days;
  const start = new Date(nowMs - window * 86_400_000).toISOString().slice(0, 10);
  const p = new URLSearchParams({ q: '"California"', forms: form, dateRange: "custom", startdt: start, enddt: end });
  return `${FTS}?${p.toString()}`;
}

/** Company name, with EDGAR's "(CIK 000…)" suffix removed. */
function cleanName(displayName: string): string {
  return String(displayName ?? "").replace(/\s*\(CIK\s+\d+\)\s*$/i, "").replace(/\s{2,}/g, " ").trim();
}

/** The human-readable filing index page. */
export function filingUrl(cik: string, adsh: string): string {
  const noDashes = String(adsh ?? "").replace(/-/g, "");
    return `https://www.sec.gov/Archives/edgar/data/${String(cik).replace(/^0+/, "")}/${noDashes}/${adsh}-index.htm`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseSec(payload: any): IngestedStory[] {
  const hits: any[] = payload?.hits?.hits ?? [];
  const out: IngestedStory[] = [];
  const seen = new Set<string>();

  for (const h of hits) {
    const src = h?._source ?? {};
    const locations: string[] = Array.isArray(src.biz_locations) ? src.biz_locations : [];
    if (!locations.some(isBayLocation)) continue; // Bay Area filers only

    const adsh = String(src.adsh ?? "");
    const cik = String((Array.isArray(src.ciks) ? src.ciks[0] : "") ?? "");
    if (!adsh || !cik || seen.has(adsh)) continue; // one story per filing, not per document
    seen.add(adsh);

    const name = cleanName((Array.isArray(src.display_names) ? src.display_names[0] : "") ?? "");
    if (!name) continue;
    const form = String(src.form ?? "D");
    const where = locations.find(isBayLocation) ?? "";

    const candidate: Partial<IngestedStory> = {
      origin: "sec",
      externalId: adsh,
      title: `${name} filed ${form === "S-1" ? "to go public (S-1)" : `a Form ${form}`}${where ? ` — ${where}` : ""}`.slice(0, 200),
      url: filingUrl(cik, adsh),
      externalUrl: null,
      points: null,
      comments: null,
      createdAt: src.file_date ? new Date(`${src.file_date}T00:00:00Z`).toISOString() : new Date().toISOString(),
      author: null,
      topics: ["vc"],
    };
    if (isUsable(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * `onPayload` hands the raw search response to a second reader before it is
 * reduced to headlines. `parseSec` throws away the CIK, the amounts and the
 * related-persons list; `ingest/formd.ts` wants them, and this way it gets them
 * without a second round trip to EDGAR. Optional — the news path is unchanged.
 */
export async function fetchSec(
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
  onPayload?: (form: string, payload: unknown) => void,
): Promise<IngestedStory[]> {
  const out: IngestedStory[] = [];
  let failed = 0;
  // Sequential, spaced: EDGAR caps at 10 req/s and asks that you not hammer it.
  for (const form of FORMS) {
    try {
      const res = await fetchImpl(searchUrl(nowMs, 7, form), {
        headers: { accept: "application/json", "user-agent": SEC_USER_AGENT },
      });
      if (!res.ok) throw new Error(`sec ${res.status}`);
      const payload = await res.json();
      try { onPayload?.(form, payload); } catch { /* a second reader must never cost the story */ }
      out.push(...parseSec(payload));
    } catch { failed++; }
  }
  if (failed === FORMS.length) throw new Error(`all ${failed} EDGAR form queries failed`);
  return out;
}
