/**
 * openFDA — medical device clearances from Bay Area companies.
 *
 * A 510(k) clearance is the moment a device is legally allowed to be sold. For
 * the Bay's very large medtech and biotech sector that is a real product launch,
 * and it is a matter of public record days before anyone writes it up. Same
 * spirit as the EDGAR source: structured public filings, read as news.
 *
 * openFDA is free and keyless (240 requests/minute unauthenticated — we make one
 * per cron tick).
 * https://open.fda.gov/apis/authentication/
 */
import type { IngestedStory } from "./types";
import { isUsable } from "./types";

/** Bay Area cities as they appear in FDA applicant addresses. */
const BAY_CITIES = [
  "san francisco", "oakland", "berkeley", "palo alto", "menlo park", "mountain view",
  "sunnyvale", "santa clara", "san jose", "redwood city", "san mateo", "burlingame",
  "cupertino", "fremont", "emeryville", "alameda", "hayward", "milpitas", "newark",
  "pleasanton", "san carlos", "belmont", "foster city", "south san francisco",
  "los altos", "los gatos", "campbell", "union city", "livermore", "dublin",
];

export function isBayCity(city: string): boolean {
  const s = String(city ?? "").trim().toLowerCase();
  return BAY_CITIES.includes(s);
}

export function searchUrl(nowMs: number = Date.now(), days = 30, limit = 40): string {
  const end = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, "");
  const start = new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
  // State filter first so the Bay-city pass has a small, relevant set to work on.
  const search = `decision_date:[${start}+TO+${end}]+AND+state:CA`;
  return `https://api.fda.gov/device/510k.json?search=${search}&limit=${limit}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseFda(payload: any): IngestedStory[] {
  const results: any[] = Array.isArray(payload?.results) ? payload.results : [];
  const out: IngestedStory[] = [];
  const seen = new Set<string>();

  for (const r of results) {
    const city = String(r?.city ?? "");
    if (!isBayCity(city)) continue; // California is not the Bay

    const kNumber = String(r?.k_number ?? "");
    const applicant = String(r?.applicant ?? "").trim();
    const device = String(r?.device_name ?? "").trim();
    if (!kNumber || !applicant || seen.has(kNumber)) continue;
    seen.add(kNumber);

    const date = String(r?.decision_date ?? "");
    const candidate: Partial<IngestedStory> = {
      origin: "fda",
      externalId: kNumber,
      title: device
        ? `${applicant} cleared ${device} — ${titleCase(city)}, CA`.slice(0, 200)
        : `${applicant} received FDA clearance — ${titleCase(city)}, CA`.slice(0, 200),
      url: `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID=${encodeURIComponent(kNumber)}`,
      externalUrl: null,
      points: null,
      comments: null,
      createdAt: /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? new Date(`${date}T00:00:00Z`).toISOString()
        : new Date().toISOString(),
      author: null,
      topics: ["hardware"],
    };
    if (isUsable(candidate)) out.push(candidate);
  }
  return out;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export async function fetchFda(fetchImpl: typeof fetch = fetch, nowMs: number = Date.now()): Promise<IngestedStory[]> {
  const res = await fetchImpl(searchUrl(nowMs), {
    headers: { accept: "application/json", "user-agent": "thebay.news aggregator contact@thebay.news" },
  });
  // openFDA returns 404 for "no matches", which is a quiet week, not a failure.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`fda ${res.status}`);
  return parseFda(await res.json());
}
