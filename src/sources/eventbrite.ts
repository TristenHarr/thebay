import { z } from "zod";
import type { RawEvent } from "../core/models/event";
import type { SourceConfig } from "../core/models/source";
import type { AdapterContext, SourceAdapter } from "./types";
import { fetchText, sleep } from "./util/http";
import { extractAssignedJson, getResults, mapEbEvent } from "./eventbrite-map";
import { jsonLdRawEvents } from "./util/jsonld";

/* eslint-disable @typescript-eslint/no-explicit-any */

const EbParams = z.object({
  mode: z.enum(["scrape", "browser"]).default("scrape"),
  // single (back-compat) …
  location: z.string().default("ca--san-francisco"),
  query: z.string().default("events"),
  // … or fan out over the whole matrix
  locations: z.array(z.string()).optional(),
  queries: z.array(z.string()).optional(),
  url: z.string().optional(),
  maxPages: z.number().int().positive().max(50).default(10),
  maxScroll: z.number().int().positive().max(200).default(30),
  pageDelayMs: z.number().int().nonnegative().max(10_000).optional(),
  crawlDelayMs: z.number().int().nonnegative().max(10_000).optional(),
});
type EbParams = z.infer<typeof EbParams>;

interface Crawl {
  loc: string;
  q: string;
}

function crawls(p: EbParams): Crawl[] {
  const locs = p.locations?.length ? p.locations : [p.location];
  const qs = p.queries?.length ? p.queries : [p.query];
  const out: Crawl[] = [];
  for (const loc of locs) for (const q of qs) out.push({ loc, q });
  return out;
}

function buildUrl(location: string, query: string, page: number): string {
  return `https://www.eventbrite.com/d/${location}/${query}/?page=${page}`;
}

// The pure mapping lives in ./eventbrite-map so a browser client can share it without
// pulling in cheerio. Re-exported here so existing import sites are unaffected.
export { extractAssignedJson, getResults, mapEbEvent } from "./eventbrite-map";

/** One (location, query) crawl over its pages, via plain fetch. */
async function scrapeCrawl(
  c: Crawl,
  p: EbParams,
  cfg: SourceConfig<EbParams>,
): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  let pageCount = p.maxPages;
  for (let page = 1; page <= Math.min(p.maxPages, pageCount); page++) {
    const url =
      p.url && page === 1 && !p.locations && !p.queries
        ? p.url
        : buildUrl(c.loc, c.q, page);
    const html = await fetchText(url, {
      headers: { accept: "text/html", referer: "https://www.eventbrite.com/" },
    });
    const data = extractAssignedJson(html, "window.__SERVER_DATA__");
    if (data) {
      pageCount = Number(data.page_count) || pageCount;
      for (const ev of getResults(data)) {
        const r = mapEbEvent(ev, cfg);
        if (r) out.push(r);
      }
    } else {
      out.push(...jsonLdRawEvents(html, cfg.id, "eventbrite"));
      break;
    }
    if (page >= pageCount) break;
    // Global per-host gate (util/http) paces Eventbrite; extra delay only if set.
    if (p.pageDelayMs) await sleep(p.pageDelayMs);
  }
  return out;
}

async function scrapeMode(
  cfg: SourceConfig<EbParams>,
  ctx: AdapterContext,
): Promise<RawEvent[]> {
  const p = cfg.params;
  const list = crawls(p);
  const out: RawEvent[] = [];
  let failed = 0;
  for (const c of list) {
    try {
      const r = await scrapeCrawl(c, p, cfg);
      out.push(...r);
      ctx.logger.debug(
        { source: cfg.id, loc: c.loc, q: c.q, count: r.length },
        "eb crawl",
      );
    } catch (err) {
      failed++;
      ctx.logger.warn(
        { source: cfg.id, loc: c.loc, q: c.q, err: (err as Error).message },
        "eb crawl failed",
      );
    }
    if (p.crawlDelayMs) await sleep(p.crawlDelayMs);
  }
  // If every crawl failed, surface it as a source-level error (likely blocked).
  if (list.length > 0 && failed === list.length) {
    throw new Error(`all ${list.length} eventbrite crawls failed`);
  }
  ctx.logger.info(
    { source: cfg.id, crawls: list.length, failed, count: out.length },
    "eventbrite scraped",
  );
  return out;
}

async function browserMode(
  cfg: SourceConfig<EbParams>,
  ctx: AdapterContext,
): Promise<RawEvent[]> {
  const p = cfg.params;
  const list = crawls(p);
  return ctx.browser.withPage(async (page) => {
    const out: RawEvent[] = [];
    for (const c of list) {
      let pageCount = p.maxPages;
      for (let n = 1; n <= Math.min(p.maxPages, pageCount); n++) {
        const url = buildUrl(c.loc, c.q, n);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForTimeout(1200);
        for (let s = 0; s < 3; s++) {
          await page.mouse.wheel(0, 4000);
          await page.waitForTimeout(350);
        }
        const data = await page.evaluate(
          () => (globalThis as any).__SERVER_DATA__ ?? null,
        );
        if (data) {
          pageCount = Number(data.page_count) || pageCount;
          for (const ev of getResults(data)) {
            const r = mapEbEvent(ev, cfg);
            if (r) out.push(r);
          }
        } else {
          const html = await page.content();
          out.push(...jsonLdRawEvents(html, cfg.id, "eventbrite"));
        }
        if (n >= pageCount) break;
      }
    }
    ctx.logger.info(
      { source: cfg.id, crawls: list.length, count: out.length },
      "eventbrite browser-discovered",
    );
    return out;
  });
}

export const eventbriteAdapter: SourceAdapter<EbParams> = {
  type: "eventbrite",
  parseParams(raw) {
    return EbParams.parse(raw);
  },
  async fetchEvents(cfg, ctx) {
    return cfg.params.mode === "browser"
      ? browserMode(cfg, ctx)
      : scrapeMode(cfg, ctx);
  },
};
