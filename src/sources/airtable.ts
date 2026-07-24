import { z } from "zod";
import type { RawEvent } from "../core/models/event";
import type { SourceConfig } from "../core/models/source";
import type { AdapterContext, SourceAdapter } from "./types";
import { fetchJson, sleep } from "./util/http";
import { asString } from "../util/object";

/* eslint-disable @typescript-eslint/no-explicit-any */

const FieldMap = z.record(z.string(), z.string());

const AirtableParams = z.object({
  mode: z.enum(["api", "share"]).default("share"),
  // api mode
  baseId: z.string().optional(),
  table: z.string().optional(),
  view: z.string().optional(),
  // share mode (public shared view/base — scraped via the browser)
  shareUrl: z.string().optional(),
  // auto-discovery: some curators (e.g. Kyosuke) publish a NEW shared Airtable every
  // couple of weeks via a newsletter. Point `discoverFrom` at their RSS/Atom feed and
  // we scrape every Airtable link in the newest post (union, deduped downstream), so
  // the source always tracks their latest edition instead of a frozen URL. `shareUrl`
  // is the fallback when discovery finds nothing.
  discoverFrom: z.string().optional(),
  maxDiscover: z.number().int().positive().max(60).default(40),
  maxScroll: z.number().int().positive().max(400).default(200),
  // canonical field -> Airtable column header name
  fieldMap: FieldMap.default({}),
});
type AirtableParams = z.infer<typeof AirtableParams>;

/* ------------------------------------------------------------------ */
/* api mode — official REST API (a base you own; needs AIRTABLE_TOKEN) */
/* ------------------------------------------------------------------ */

function buildFromMap(
  get: (name: string) => unknown,
  fieldMap: Record<string, string>,
  cfg: SourceConfig<AirtableParams>,
  externalId: string | undefined,
  fallbackUrl: string,
  now: Date,
): RawEvent | null {
  const g = (key: string): string | undefined => {
    const f = fieldMap[key];
    return f ? asString(get(f)) : undefined;
  };
  const title = g("title");
  const startText = g("startRaw");
  if (!title || !startText) return null;
  const startRaw = parseFuzzyWhen(startText, now) ?? startText;
  return {
    sourceId: cfg.id,
    sourceType: "airtable",
    externalId,
    title,
    description: g("description"),
    startRaw,
    endRaw: g("endRaw"),
    venueName: g("venueName"),
    address: g("address"),
    city: g("city"),
    url: g("url") || fallbackUrl,
    organizer: g("organizer"),
    imageUrl: g("imageUrl"),
  };
}

async function apiMode(
  cfg: SourceConfig<AirtableParams>,
  ctx: AdapterContext,
): Promise<RawEvent[]> {
  const { baseId, table, view, fieldMap } = cfg.params;
  const token = ctx.secrets.AIRTABLE_TOKEN;
  if (!token) throw new Error("airtable api mode needs AIRTABLE_TOKEN");
  if (!baseId || !table) throw new Error("airtable api mode needs baseId and table");

  const base = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;
  const out: RawEvent[] = [];
  let offset: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: "100" });
    if (view) params.set("view", view);
    if (offset) params.set("offset", offset);
    const data: any = await fetchJson(`${base}?${params.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    for (const rec of data?.records ?? []) {
      const r = buildFromMap(
        (name) => rec.fields?.[name],
        fieldMap,
        cfg,
        rec.id,
        `https://airtable.com/${baseId}`,
        ctx.now(),
      );
      if (r) out.push(r);
    }
    offset = data?.offset;
    if (offset) await sleep(250);
  } while (offset);

  ctx.logger.debug({ source: cfg.id, count: out.length }, "airtable api fetched");
  return out;
}

/* ------------------------------------------------------------------ */
/* share mode — public shared view/base scraped via the browser DOM.  */
/* Airtable serves shared bases as a framed msgpack sync stream (not   */
/* plain JSON), so we let Chromium render the grid and read it out —   */
/* robust across share types, and no token needed.                    */
/* ------------------------------------------------------------------ */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse freeform Airtable dates like "Mar 27 4:00PM" / "Mar 20-22" into a
 *  local ISO string. Returns null for values that don't look like this format
 *  (callers fall back to the raw text so real ISO dates pass straight through). */
export function parseFuzzyWhen(text: string, now: Date): string | null {
  const m = text.match(/([A-Za-z]{3,9})\.?\s*(\d{1,2})/);
  if (!m) return null;
  const mo = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  if (!mo) return null;
  const day = parseInt(m[2]!, 10);
  const t = text.match(/(\d{1,2})(?::(\d{2}))?\s*([APap][Mm])/);
  let hh = 9;
  let mm = 0;
  if (t) {
    hh = parseInt(t[1]!, 10) % 12;
    if (/pm/i.test(t[3]!)) hh += 12;
    mm = t[2] ? parseInt(t[2], 10) : 0;
  }
  // No year in the data: choose the year (prev / current / next) whose date
  // lands closest to `now`. So a year-less "Mar 21" viewed in July resolves to
  // *this* past March — not a fabricated next-March 8 months out. This keeps
  // past events correctly in the past (where they're filtered out) instead of
  // masquerading as upcoming, while still rolling forward across a year boundary
  // when next year genuinely is nearest (e.g. "Jan 5" viewed in December).
  const base = now.getFullYear();
  let year = base;
  let bestDist = Infinity;
  for (const y of [base - 1, base, base + 1]) {
    const dist = Math.abs(new Date(y, mo - 1, day, hh, mm).getTime() - now.getTime());
    if (dist < bestDist) {
      bestDist = dist;
      year = y;
    }
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${year}-${p(mo)}-${p(day)}T${p(hh)}:${p(mm)}:00`;
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Discover the share URL(s) to scrape. With `discoverFrom` set, read the curator's
 *  feed and return EVERY distinct Airtable link across ALL their posts (each edition
 *  publishes a fresh table; older editions are linked for reference too). We grab them
 *  all — newest first — so the site carries the curator's complete body of picks;
 *  downstream dedup + the date window sort upcoming vs. archive. Falls back to the
 *  static `shareUrl` if discovery finds nothing or errors. */
async function resolveShareUrls(
  cfg: SourceConfig<AirtableParams>,
  ctx: AdapterContext,
): Promise<string[]> {
  const { shareUrl, discoverFrom, maxDiscover } = cfg.params;
  const fallback = shareUrl ? [shareUrl] : [];
  if (!discoverFrom) return fallback;
  try {
    const res = await ctx.fetch(discoverFrom, {
      headers: { "user-agent": BROWSER_UA, accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    const xml = await res.text();
    // scan the WHOLE feed (all editions), preserving first-seen (newest-first) order
    const seen = new Set<string>();
    const found: string[] = [];
    for (const m of xml.matchAll(/https:\/\/airtable\.com\/app[A-Za-z0-9]+\/shr[A-Za-z0-9]+/g)) {
      if (!seen.has(m[0])) {
        seen.add(m[0]);
        found.push(m[0]);
      }
    }
    // always include the configured shareUrl too, in case it isn't linked in the feed
    if (shareUrl && !seen.has(shareUrl)) found.push(shareUrl);
    const capped = found.slice(0, maxDiscover);
    if (capped.length) {
      ctx.logger.info(
        { source: cfg.id, discovered: found.length, scraping: capped.length },
        "airtable editions discovered from feed",
      );
      return capped;
    }
    ctx.logger.warn({ source: cfg.id, discoverFrom }, "airtable discovery found no links, using fallback");
  } catch (err) {
    ctx.logger.warn({ source: cfg.id, err: String(err) }, "airtable discovery failed, using fallback shareUrl");
  }
  return fallback;
}

async function shareMode(
  cfg: SourceConfig<AirtableParams>,
  ctx: AdapterContext,
): Promise<RawEvent[]> {
  const urls = await resolveShareUrls(cfg, ctx);
  if (!urls.length) throw new Error("airtable share mode needs shareUrl or discoverFrom");

  // Grab EVERY edition he's published: scrape each discovered table and union them.
  // Downstream two-stage dedup collapses the heavy overlap between editions (each
  // newsletter re-lists recurring events), the date window keeps only upcoming ones
  // in the live feed, and the rest enrich the curator archive. One table failing
  // never sinks the others.
  const out: RawEvent[] = [];
  let okTables = 0;
  for (const url of urls) {
    try {
      const evs = await scrapeShare(url, cfg, ctx);
      out.push(...evs);
      okTables++;
    } catch (err) {
      ctx.logger.warn({ source: cfg.id, url, err: String(err) }, "airtable share url failed");
    }
  }
  ctx.logger.info(
    { source: cfg.id, tables: urls.length, okTables, rawEvents: out.length },
    "airtable editions scraped (union)",
  );
  return out;
}

/** Scrape a single Airtable shared grid via the rendered DOM. */
async function scrapeShare(
  shareUrl: string,
  cfg: SourceConfig<AirtableParams>,
  ctx: AdapterContext,
): Promise<RawEvent[]> {
  const { fieldMap, maxScroll } = cfg.params;

  return ctx.browser.withPage(async (page) => {
    await page.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("[data-rowid]", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // columnId -> header name
    const colMap: Record<string, string> = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      return Object.fromEntries(
        [...doc.querySelectorAll(".headerRow .cell[data-columnid]")].map((e: any) => [
          e.getAttribute("data-columnid"),
          e.innerText.trim(),
        ]),
      );
    });

    // scroll the virtualized grid until no new rows appear
    const rows: Record<string, Record<string, string>> = {};
    let stable = 0;
    for (let i = 0; i < maxScroll && stable < 6; i++) {
      const batch: Record<string, Record<string, string>> = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const byRow: Record<string, Record<string, string>> = {};
        for (const cell of doc.querySelectorAll("[data-rowid] .cell[data-columnid]")) {
          const host = cell.closest("[data-rowid]");
          if (!host) continue;
          const rid = host.getAttribute("data-rowid");
          (byRow[rid] ||= {})[cell.getAttribute("data-columnid")] = cell.innerText
            .replace(/\s+/g, " ")
            .trim();
        }
        return byRow;
      });
      for (const [rid, cells] of Object.entries(batch)) {
        rows[rid] = { ...rows[rid], ...cells };
      }
      const before = Object.keys(rows).length;
      await page.evaluate(() => {
        const doc = (globalThis as any).document;
        let best: any = null;
        for (const el of Array.from(doc.querySelectorAll("div")) as any[]) {
          if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200 &&
              (!best || el.scrollHeight > best.scrollHeight)) best = el;
        }
        if (best) best.scrollTop += best.clientHeight * 0.8;
      });
      await page.waitForTimeout(400);
      stable = Object.keys(rows).length === before ? stable + 1 : 0;
    }

    // resolve which columnId is which canonical field
    const nameOf = (patterns: RegExp) =>
      Object.keys(colMap).find((k) => patterns.test(colMap[k]!));
    const colFor = (canonical: string, fallback: RegExp): string | undefined => {
      const mapped = fieldMap[canonical];
      if (mapped) {
        const byName = Object.keys(colMap).find((k) => colMap[k] === mapped);
        if (byName) return byName;
      }
      return nameOf(fallback);
    };
    const cName = colFor("title", /name|event|title/i);
    const cDate = colFor("startRaw", /date|time|when/i);
    const cEnd = colFor("endRaw", /end/i);
    const cLoc = colFor("city", /location|place|city|where/i);
    const cUrl = colFor("url", /link|url|rsvp|register/i);
    const cHost = colFor("organizer", /host|organizer|organiser|by/i);
    const cDesc = colFor("description", /info|description|notes|details/i);

    const now = ctx.now();
    const out: RawEvent[] = [];
    for (const [rid, cells] of Object.entries(rows)) {
      const title = cName ? cells[cName] : undefined;
      const whenText = cDate ? cells[cDate] : undefined;
      if (!title || !whenText) continue;
      const start = parseFuzzyWhen(whenText, now) ?? whenText;
      out.push({
        sourceId: cfg.id,
        sourceType: "airtable",
        externalId: rid,
        title,
        description: cDesc ? cells[cDesc] : undefined,
        startRaw: start,
        endRaw: cEnd ? cells[cEnd] : undefined,
        city: cLoc ? cells[cLoc] : undefined,
        address: cLoc ? cells[cLoc] : undefined,
        url: (cUrl && cells[cUrl]) || shareUrl,
        organizer: cHost ? cells[cHost] : undefined,
        raw: cells,
      });
    }
    ctx.logger.info(
      { source: cfg.id, rows: Object.keys(rows).length, events: out.length },
      "airtable share scraped",
    );
    return out;
  });
}

export const airtableAdapter: SourceAdapter<AirtableParams> = {
  type: "airtable",
  parseParams(raw) {
    return AirtableParams.parse(raw);
  },
  async fetchEvents(cfg, ctx) {
    return cfg.params.mode === "api" ? apiMode(cfg, ctx) : shareMode(cfg, ctx);
  },
};
