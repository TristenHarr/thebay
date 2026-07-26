/**
 * arXiv — preprints, as research rather than as a generic feed item.
 *
 * arXiv was already being ingested, but through the RSS path: thirteen
 * `export.arxiv.org/api/query` URLs sat in news-feeds.json and went through the
 * feed parser, so every paper landed with origin `rss` and rendered with an
 * "rss" mark next to a techmeme link. Readers looking for papers found them
 * under "feeds"; the `research` chip showed only OpenAlex.
 *
 * Same content, wrong shelf. This adapter owns arXiv instead, which also buys
 * the things the feed path threw away: real author lists, the abstract as a
 * summary, the arXiv id as a stable external id (so v1→v2 doesn't duplicate a
 * paper), and per-category topic mapping instead of one topic per feed URL.
 *
 * The API is free, keyless and asks only for a descriptive User-Agent and
 * courteous pacing. https://info.arxiv.org/help/api/
 *
 * NOTE: https, not http — the http endpoint answers 301 with an empty body,
 * which reads exactly like a dead source.
 */
import type { IngestedStory } from "./types";
import { isUsable } from "./types";
import { decodeXml } from "./rss";

/**
 * Categories we pull, mapped to the site's axes. These are the same categories
 * the feed entries covered, so nothing stops being ingested by this swap.
 */
export const ARXIV_CATEGORIES: { cat: string; topic: string }[] = [
  { cat: "cs.AI", topic: "software" },
  { cat: "cs.LG", topic: "software" },
  { cat: "cs.DC", topic: "software" },
  { cat: "cs.CR", topic: "software" },
  { cat: "cs.PL", topic: "software" },
  { cat: "math.CO", topic: "math" },
  { cat: "math.NT", topic: "math" },
  { cat: "math.AG", topic: "math" },
  { cat: "math.DS", topic: "math" },
  { cat: "math.OC", topic: "math" },
  { cat: "math.PR", topic: "math" },
  { cat: "eess.SP", topic: "hardware" },
  { cat: "cond-mat.mes-hall", topic: "hardware" },
];

/** Per category, per run. Thirteen categories is already a lot of paper. */
export const MAX_PER_CATEGORY = 8;

export function searchUrl(cat: string, max = MAX_PER_CATEGORY): string {
  const p = new URLSearchParams({
    search_query: `cat:${cat}`,
    sortBy: "submittedDate",
    sortOrder: "descending",
    max_results: String(max),
  });
  return `https://export.arxiv.org/api/query?${p.toString()}`;
}

const block = (s: string, tag: string): string[] =>
  s.split(`<${tag}`).slice(1).map((b) => b.slice(b.indexOf(">") + 1).split(`</${tag}>`)[0] ?? "");

const field = (s: string, tag: string): string | null => {
  const i = s.indexOf(`<${tag}`);
  if (i < 0) return null;
  const start = s.indexOf(">", i);
  const end = s.indexOf(`</${tag}>`, start);
  if (start < 0 || end < 0) return null;
  return decodeXml(s.slice(start + 1, end)).replace(/\s+/g, " ").trim();
};

/**
 * `2507.12345v2` → `2507.12345`. The version is what makes a revised paper look
 * like a new one; stripping it means a v2 updates the story we already have.
 */
export function arxivId(rawId: string): string | null {
  const m = String(rawId).match(/abs\/([^\s?#]+)/);
  if (!m) return null;
  return m[1]!.replace(/v\d+$/, "");
}

export function parseArxiv(xml: string, topic?: string): IngestedStory[] {
  const out: IngestedStory[] = [];
  for (const entry of block(xml, "entry")) {
    const id = arxivId(field(entry, "id") ?? "");
    const title = field(entry, "title");
    if (!id || !title) continue;

    const authors = block(entry, "author")
      .map((a) => field(a, "name"))
      .filter((n): n is string => !!n);
    const byline = authors.length ? (authors.length > 1 ? `${authors[0]} et al.` : authors[0]!) : null;

    // The category the paper was actually filed under wins over the query's
    // category, so a cross-listed paper is tagged by what it IS.
    const primary = entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)?.[1];
    const mapped = ARXIV_CATEGORIES.find((c) => c.cat === primary)?.topic ?? topic;

    const candidate: Partial<IngestedStory> = {
      origin: "research",
      externalId: `arxiv:${id}`,
      title: title.slice(0, 200),
      url: `https://arxiv.org/abs/${id}`,
      externalUrl: null,
      points: null,
      comments: null,
      createdAt: (() => {
        const p = field(entry, "published");
        return p && Number.isFinite(Date.parse(p)) ? new Date(p).toISOString() : new Date().toISOString();
      })(),
      author: byline,
      topics: mapped ? [mapped] : [],
    };
    if (isUsable(candidate)) out.push(candidate);
  }
  return out;
}

export async function fetchArxiv(
  fetchImpl: typeof fetch = fetch,
  categories = ARXIV_CATEGORIES,
): Promise<IngestedStory[]> {
  const out: IngestedStory[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const { cat, topic } of categories) {
    try {
      const res = await fetchImpl(searchUrl(cat), {
        headers: { accept: "application/atom+xml", "user-agent": "thebay.news aggregator contact@thebay.news" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const s of parseArxiv(await res.text(), topic)) {
        // Cross-listed papers appear under several categories; the first one
        // wins rather than the story being offered for insert repeatedly.
        if (seen.has(s.externalId)) continue;
        seen.add(s.externalId);
        out.push(s);
      }
    } catch (err) {
      errors.push(`${cat}=${(err as Error).message ?? err}`.slice(0, 40));
    }
  }
  // One category being down is a smaller harvest, not a failed run. All of them
  // down is arXiv being unreachable, which is worth reporting.
  if (errors.length === categories.length) throw new Error(errors.slice(0, 3).join(" "));
  return out;
}
