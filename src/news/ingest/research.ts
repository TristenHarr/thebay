/**
 * OpenAlex — research coming out of Bay Area institutions.
 *
 * Filtered by INSTITUTION, not by keyword. That's the whole point: this isn't
 * "papers about AI", it's "what Stanford, Berkeley and UCSF published this week".
 * For a Bay readership that is local news that happens to be a paper, and it
 * covers three of the four interest axes at once.
 *
 * OpenAlex is free, keyless and open. It asks for a `mailto` in the query so
 * they can contact heavy users and so we land in the polite pool — that's a
 * condition of the fast lane, not decoration.
 * https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication
 */
import type { IngestedStory } from "./types";
import { isUsable } from "./types";

export const OPENALEX_MAILTO = "contact@thebay.news";

/** ROR ids — OpenAlex's stable institution identifiers. */
export const BAY_INSTITUTIONS: { id: string; ror: string; name: string }[] = [
  { id: "stanford", ror: "00f54p054", name: "Stanford" },
  { id: "berkeley", ror: "01an7q238", name: "UC Berkeley" },
  { id: "ucsf", ror: "043mz5j54", name: "UCSF" },
];

/** OpenAlex concept → our axes. Only mapped fields produce a topic. */
const FIELD_TOPIC: Record<string, string> = {
  "computer science": "software",
  mathematics: "math",
  physics: "hardware",
  engineering: "hardware",
  "materials science": "hardware",
  economics: "vc",
};

export function searchUrl(ror: string, nowMs: number = Date.now(), days = 7, perPage = 10): string {
  const since = new Date(nowMs - days * 86_400_000).toISOString().slice(0, 10);
  const p = new URLSearchParams({
    filter: `institutions.ror:${ror},from_publication_date:${since}`,
    // Most-cited first. On brand-new papers citations are near zero, but it
    // still surfaces the ones the field picked up fastest.
    sort: "cited_by_count:desc",
    "per-page": String(perPage),
    mailto: OPENALEX_MAILTO,
  });
  return `https://api.openalex.org/works?${p.toString()}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseResearch(payload: any, institution = "Bay"): IngestedStory[] {
  const results: any[] = Array.isArray(payload?.results) ? payload.results : [];
  const out: IngestedStory[] = [];

  for (const w of results) {
    const id = String(w?.id ?? "").split("/").pop() ?? "";
    const title = String(w?.title ?? w?.display_name ?? "").trim();
    if (!id || !title) continue;

    // Prefer a landing page a human can actually read: DOI, then the open-access
    // PDF/host, then OpenAlex itself.
    const url =
      (typeof w?.doi === "string" && w.doi) ||
      w?.primary_location?.landing_page_url ||
      w?.best_oa_location?.landing_page_url ||
      w?.id ||
      null;

    const field = String(w?.primary_topic?.field?.display_name ?? "").toLowerCase();
    const topics = FIELD_TOPIC[field] ? [FIELD_TOPIC[field]!] : [];

    const first = w?.authorships?.[0]?.author?.display_name;
    const nAuthors = Array.isArray(w?.authorships) ? w.authorships.length : 0;
    const byline = first ? (nAuthors > 1 ? `${first} et al.` : String(first)) : null;

    const candidate: Partial<IngestedStory> = {
      origin: "research",
      externalId: `openalex:${id}`,
      // The institution is the reason this is on a Bay news site, so it's in the title.
      title: `${title} — ${institution}`.slice(0, 200),
      url,
      externalUrl: null,
      points: Number.isFinite(w?.cited_by_count) ? w.cited_by_count : null,
      comments: null,
      createdAt: w?.publication_date
        ? new Date(`${w.publication_date}T00:00:00Z`).toISOString()
        : new Date().toISOString(),
      author: byline,
      topics,
    };
    if (isUsable(candidate)) out.push(candidate);
  }
  return out;
}

export async function fetchResearch(fetchImpl: typeof fetch = fetch, nowMs: number = Date.now()): Promise<IngestedStory[]> {
  const out: IngestedStory[] = [];
  // Carry WHY each one failed. "all 3 failed" told me nothing when this worked
  // from a laptop and not from the Worker — a status code would have.
  const errors: string[] = [];
  let throttled = 0;
  for (const inst of BAY_INSTITUTIONS) {
    try {
      const res = await fetchImpl(searchUrl(inst.ror, nowMs), {
        headers: { accept: "application/json", "user-agent": `thebay.news (${OPENALEX_MAILTO})` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out.push(...parseResearch(await res.json(), inst.name));
    } catch (err) {
      const msg = `${(err as Error).message ?? err}`;
      // 429 is an infrastructure condition, not a bug: OpenAlex throttles by IP
      // and a Worker shares egress with all of Cloudflare, so we are in someone
      // else's bucket. (The `mailto` polite-pool param doesn't rescue a shared
      // IP.) Reporting it every 15 minutes would train us to ignore the failure
      // list, so a throttled run is a SKIP — it simply harvests nothing and
      // picks up again whenever we're let through.
      if (msg.includes("429")) { throttled++; continue; }
      errors.push(`${inst.id}=${msg}`.slice(0, 60));
    }
  }
  if (throttled === BAY_INSTITUTIONS.length) return []; // rate-limited: quietly skip
  if (errors.length === BAY_INSTITUTIONS.length) throw new Error(errors.join(" "));
  return out;
}
