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

/** Resolve a possibly-relative feed link against the feed's own URL.
 *  Several real feeds (Stanford AI's, for one) emit "/blog/thing/" rather than
 *  an absolute URL — dropping those loses real stories, and passing them through
 *  un-resolved fails canonicalization downstream. */
function absoluteLink(href: string | null, feedUrl?: string): string | null {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  if (!feedUrl) return null;
  try { return new URL(href, feedUrl).toString(); } catch { return null; }
}

export function parseFeed(xml: string, feedId = "rss", feedUrl?: string): IngestedStory[] {
  const blocks = [
    ...String(xml ?? "").matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi),
  ].map((m) => m[0]);

  const out: IngestedStory[] = [];
  for (const b of blocks) {
    const title = tag(b, "title");
    const link = absoluteLink(tag(b, "link") || atomLink(b), feedUrl);
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

export interface FeedConfig {
  id: string;
  url: string;
  topics?: string[];
  enabled?: boolean;
  max?: number;
  /**
   * Harvest this one from a residential IP instead of from the Worker.
   *
   * Some publishers rate-limit by IP, and a Worker shares Cloudflare's egress
   * with everyone on the platform, so it lands in someone else's bucket:
   * huggingface.co answers a laptop with 200 and the Worker with 429, forever.
   * The scheduled run skips these; `npm run scrape-news` collects them locally
   * and pushes. Same bridge the events scraper uses for Eventbrite.
   */
  local?: boolean;
}

/** Feeds the Worker should attempt. The rest belong to the local harvester. */
export const workerFeeds = (feeds: FeedConfig[]): FeedConfig[] => feeds.filter((f) => !f.local);
/** Feeds only a residential IP can fetch. */
export const localFeeds = (feeds: FeedConfig[]): FeedConfig[] => feeds.filter((f) => f.local && f.enabled !== false);

/**
 * How many items to take from any one feed per run.
 *
 * Feeds do not agree on what "recent" means. OpenAI's returns its ENTIRE
 * history — a single feed contributed 1,050 stories on the first run, 63% of
 * everything on the site, drowning 32 other sources. Feeds are ordered
 * newest-first by convention, so taking the head is both cheap and correct.
 */
export const MAX_ITEMS_PER_FEED = 12;

/**
 * Fetch many feeds. Per-feed failures are isolated and counted; we only throw if
 * EVERY feed failed, matching the convention in src/sources/ical.ts.
 */
/**
 * Feeds fetched at once.
 *
 * Sequential fetching does not scale past a handful of sources: at ~0.5s each,
 * 86 feeds is 45 seconds of a cron tick spent waiting on sockets. Bounded rather
 * than unbounded so we stay a polite client and stay well inside the Worker
 * subrequest budget.
 */
export const FEED_CONCURRENCY = 8;

export async function fetchFeeds(
  feeds: FeedConfig[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ stories: IngestedStory[]; failed: string[]; reasons: string[]; empty: string[] }> {
  const active = feeds.filter((f) => f.enabled !== false);
  const stories: IngestedStory[] = [];
  const failed: string[] = [];
  // WHY each one failed, kept separate so `failed` stays a plain list of ids for
  // callers that only count them. "feed:huggingface" every fifteen minutes for a
  // week told me nothing; "huggingface=HTTP 403" would have told me everything
  // in one glance. Exactly the lesson OpenAlex taught.
  const reasons: string[] = [];
  /**
   * Fetched fine, parsed to nothing. This is the DANGEROUS failure — it looks
   * like success. logicaffeine.com answers every path, including /feed.xml, with
   * its 182KB SPA shell and a 200; a feed like that would have sat in the config
   * forever contributing zero stories and never appearing in any failure list.
   */
  const empty: string[] = [];

  const one = async (f: FeedConfig) => {
    try {
      const res = await fetchImpl(f.url, { headers: { accept: "application/rss+xml, application/xml, text/xml", "user-agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseFeed(await res.text(), f.id, f.url);
      if (!parsed.length) empty.push(f.id);
      const items = parsed.slice(0, f.max ?? MAX_ITEMS_PER_FEED);
      for (const it of items) stories.push(f.topics?.length ? { ...it, topics: f.topics } : it);
    } catch (err) {
      failed.push(f.id);
      reasons.push(`${f.id}=${(err as Error).message ?? err}`.slice(0, 60));
    }
  };

  // Fixed-size worker pool over a shared cursor.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(FEED_CONCURRENCY, active.length) }, async () => {
    while (cursor < active.length) await one(active[cursor++]!);
  });
  await Promise.all(workers);

  if (active.length && failed.length === active.length) {
    throw new Error(`all ${active.length} feeds failed: ${reasons.slice(0, 3).join(" ")}`);
  }
  return { stories, failed, reasons, empty };
}
