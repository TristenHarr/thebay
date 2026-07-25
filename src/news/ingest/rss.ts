/**
 * RSS 2.0 + Atom parsing.
 *
 * Workers have no DOMParser and pulling in a full XML library for this would be
 * dead weight, so this is a deliberately narrow tag-scanner: it reads the handful
 * of fields a link aggregator needs and ignores everything else. It is tolerant
 * by design — feeds in the wild are frequently malformed, and one bad <item>
 * must never sink the rest of the feed.
 */
import type { IngestedStory } from "./types";
import { isUsable } from "./types";
import { USER_AGENT } from "./hn";

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&nbsp;": " ",
};

/** Decode XML entities and numeric references in extracted text. */
export function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** Text of the first <tag>…</tag>, unwrapping CDATA. */
function tag(block: string, name: string): string | null {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  const m = re.exec(block);
  if (!m) return null;
  const inner = m[1]!.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  return decodeXml((cdata ? cdata[1]! : inner).trim());
}

/** Atom links are an attribute, not element text. Prefers rel="alternate". */
function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]!);
  const hrefOf = (attrs: string) => /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? null;
  const alternate = links.find((a) => /rel\s*=\s*["']alternate["']/i.test(a));
  const plain = links.find((a) => !/rel\s*=/i.test(a));
  const href = hrefOf(alternate ?? plain ?? links[0] ?? "");
  return href ? decodeXml(href) : null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function parseFeed(xml: string, feedId = "rss"): IngestedStory[] {
  const blocks = [
    ...String(xml ?? "").matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi),
  ].map((m) => m[0]);

  const out: IngestedStory[] = [];
  for (const b of blocks) {
    const title = tag(b, "title");
    const link = tag(b, "link") || atomLink(b);
    const guid = tag(b, "guid") || tag(b, "id") || link;
    const dateRaw = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date");
    const parsed = dateRaw ? Date.parse(dateRaw) : NaN;

    const candidate: Partial<IngestedStory> = {
      origin: "rss",
      // Namespace the id by feed: two feeds can legitimately reuse a guid.
      externalId: guid ? `${feedId}:${guid}`.slice(0, 200) : "",
      title: title ? stripTags(title) : "",
      url: link,
      externalUrl: null,
      points: null,
      comments: null,
      createdAt: new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString(),
      author: tag(b, "author") ? stripTags(tag(b, "author")!) : null,
      topics: [],
    };
    if (isUsable(candidate)) out.push(candidate);
  }
  return out;
}

export interface FeedConfig { id: string; url: string; topics?: string[]; enabled?: boolean }

/**
 * Fetch many feeds. Per-feed failures are isolated and counted; we only throw if
 * EVERY feed failed, matching the convention in src/sources/ical.ts.
 */
export async function fetchFeeds(
  feeds: FeedConfig[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ stories: IngestedStory[]; failed: string[] }> {
  const active = feeds.filter((f) => f.enabled !== false);
  const stories: IngestedStory[] = [];
  const failed: string[] = [];

  for (const f of active) {
    try {
      const res = await fetchImpl(f.url, { headers: { accept: "application/rss+xml, application/xml, text/xml", "user-agent": USER_AGENT } });
      if (!res.ok) throw new Error(String(res.status));
      const items = parseFeed(await res.text(), f.id);
      for (const it of items) stories.push(f.topics?.length ? { ...it, topics: f.topics } : it);
    } catch {
      failed.push(f.id);
    }
  }

  if (active.length && failed.length === active.length) throw new Error(`all ${active.length} feeds failed`);
  return { stories, failed };
}
