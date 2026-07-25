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

export async function fetchHn(fetchImpl: typeof fetch = fetch): Promise<IngestedStory[]> {
  const res = await fetchImpl(HN_FRONT_PAGE, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`hn ${res.status}`);
  return parseHn(await res.json());
}

/** Identifies us honestly to the sites we aggregate, with a contact path. */
export const USER_AGENT = "thebay.news aggregator (+https://thebay.news/about)";
