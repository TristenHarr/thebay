import { z } from "zod";
import type { RawEvent } from "../core/models/event";
import type { SourceConfig } from "../core/models/source";
import type { AdapterContext, SourceAdapter } from "./types";
import { fetchText, sleep } from "./util/http";
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

/** Balanced-brace extraction of `window.__SERVER_DATA__ = {...}`. */
export function extractAssignedJson(html: string, marker: string): any | null {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf("{", i);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let quote = "";
  for (let k = start; k < html.length; k++) {
    const c = html[k]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) inStr = false;
    } else if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, k + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function txt(v: any): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object") return v.text ?? v.html ?? undefined;
  return String(v);
}

export function getResults(data: any): any[] {
  const e = data?.search_data?.events;
  if (Array.isArray(e?.results)) return e.results;
  if (Array.isArray(e)) return e;
  if (Array.isArray(data?.events?.results)) return data.events.results;
  return [];
}

export function mapEbEvent(ev: any, cfg: SourceConfig<EbParams>): RawEvent | null {
  const title = txt(ev.name);
  const url = ev.url || ev.tickets_url || ev.vanity_url;
  const start = ev.start?.utc || ev.start_date || ev.start?.local;
  if (!title || !url || !start) return null;

  const venue = ev.primary_venue ?? ev.venue;
  const addr = venue?.address;
  const address =
    addr?.localized_address_display ||
    [addr?.address_1, addr?.city, addr?.region].filter(Boolean).join(", ") ||
    undefined;

  return {
    sourceId: cfg.id,
    sourceType: "eventbrite",
    externalId: ev.id ? String(ev.id) : undefined,
    title,
    description: txt(ev.summary) ?? txt(ev.description),
    startRaw: start,
    endRaw: ev.end?.utc || ev.end_date,
    timezoneHint: ev.start?.timezone,
    venueName: venue?.name,
    address,
    city: addr?.city,
    url,
    organizer: ev.primary_organizer?.name ?? ev.organizer?.name,
    imageUrl: ev.image?.url ?? ev.image?.original?.url ?? ev.logo?.url,
    isFree: typeof ev.is_free === "boolean" ? ev.is_free : undefined,
    priceText: ev.ticket_availability?.minimum_ticket_price?.display,
    raw: ev,
  };
}

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
