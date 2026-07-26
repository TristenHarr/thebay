/**
 * Hacker News, via the public Algolia API — one request returns the whole front
 * page, versus ~30 for the Firebase item-by-item API. No key required.
 *
 * Parsing is pure and separate from fetching so the mapping is testable without
 * the network.
 */
import type { IngestedStory } from "./types";
import { isUsable } from "./types";

export const HN_FRONT_PAGE = "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30";
/**
 * Show HN and Ask HN, by tag. Show HN is the highest-signal builder content on
 * HN and fits a founder audience better than the general front page; Ask HN is
 * where the discussion is. Both are the same endpoint and quota as the front
 * page, so they add reach without adding a failure mode.
 *
 * Points-filtered because these tags are unmoderated firehoses otherwise.
 */
export const HN_TAG_FEEDS: { id: string; url: string }[] = [
  { id: "show_hn", url: "https://hn.algolia.com/api/v1/search?tags=show_hn&numericFilters=points%3E20&hitsPerPage=20" },
  { id: "ask_hn", url: "https://hn.algolia.com/api/v1/search?tags=ask_hn&numericFilters=points%3E30&hitsPerPage=15" },
];
export const HN_ITEM = (id: string) => `https://news.ycombinator.com/item?id=${id}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseHn(payload: any): IngestedStory[] {
  const hits: any[] = Array.isArray(payload?.hits) ? payload.hits : [];
  const out: IngestedStory[] = [];
  for (const h of hits) {
    const externalId = String(h?.objectID ?? "");
    const title = String(h?.title ?? h?.story_title ?? "").trim();
    // Ask HN / Show HN text posts have no url — link to the HN thread itself.
    const url = typeof h?.url === "string" && h.url ? h.url : null;
    const candidate: Partial<IngestedStory> = {
      origin: "hn",
      externalId,
      title,
      url,
      externalUrl: externalId ? HN_ITEM(externalId) : null,
      points: Number.isFinite(h?.points) ? h.points : null,
      comments: Number.isFinite(h?.num_comments) ? h.num_comments : null,
      createdAt: h?.created_at ? new Date(h.created_at).toISOString() : new Date().toISOString(),
      author: h?.author ? String(h.author) : null,
      topics: [],
    };
    if (isUsable(candidate)) out.push(candidate);
  }
  return out;
}

async function fetchTag(url: string, fetchImpl: typeof fetch): Promise<IngestedStory[]> {
  const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`hn ${res.status}`);
  return parseHn(await res.json());
}

export async function fetchHn(fetchImpl: typeof fetch = fetch): Promise<IngestedStory[]> {
  return fetchTag(HN_FRONT_PAGE, fetchImpl);
}

/**
 * Show HN + Ask HN. Isolated per tag: if one query fails the other still lands,
 * matching how the RSS adapter treats individual feeds. Throws only if every
 * tag failed, so the caller's per-source isolation still sees a real failure.
 */
export async function fetchHnTags(fetchImpl: typeof fetch = fetch): Promise<IngestedStory[]> {
  const out: IngestedStory[] = [];
  let failed = 0;
  for (const t of HN_TAG_FEEDS) {
    try { out.push(...(await fetchTag(t.url, fetchImpl))); }
    catch { failed++; }
  }
  if (failed === HN_TAG_FEEDS.length) throw new Error(`all ${failed} hn tag feeds failed`);
  return out;
}

/** Identifies us honestly to the sites we aggregate, with a contact path. */
export const USER_AGENT = "thebay.news aggregator (+https://thebay.news/about)";
