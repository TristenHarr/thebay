import { z } from "zod";
import type { RawEvent } from "../core/models/event";
import type { SourceConfig } from "../core/models/source";
import type { AdapterContext, SourceAdapter } from "./types";
import { fetchJson, fetchText, sleep } from "./util/http";

/* eslint-disable @typescript-eslint/no-explicit-any */

const LumaParams = z.object({
  mode: z.enum(["discover", "calendar"]).default("discover"),
  slug: z.string().optional(),
  slugs: z.array(z.string()).optional(), // sweep several place/category slugs
  city: z.string().optional(), // cities.json id → pulls coordinates
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  calendarApiId: z.string().optional(),
  url: z.string().optional(),
  urls: z.array(z.string()).optional(), // several lu.ma/<slug> community calendars
  period: z.enum(["future", "past", "all"]).default("future"),
  maxPages: z.number().int().positive().max(50).default(10),
});
type LumaParams = z.infer<typeof LumaParams>;

const LUMA_HEADERS = {
  accept: "application/json",
  referer: "https://lu.ma/",
  origin: "https://lu.ma",
};

function pick(...vals: any[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return undefined;
}

function mapLumaEvent(entry: any, cfg: SourceConfig<LumaParams>): RawEvent | null {
  const ev = entry?.event ?? entry;
  if (!ev) return null;
  const title = pick(ev.name);
  const startRaw = pick(ev.start_at, ev.start_at_utc);
  if (!title || !startRaw) return null;

  let url = pick(ev.url, ev.slug);
  if (url && !/^https?:\/\//i.test(url)) url = `https://lu.ma/${url.replace(/^\//, "")}`;
  if (!url) url = "https://lu.ma/";

  const geo = ev.geo_address_info ?? ev.geo_address ?? {};
  return {
    sourceId: cfg.id,
    sourceType: "luma",
    externalId: pick(ev.api_id, ev.event_api_id),
    title,
    description: pick(ev.description_short, ev.description),
    startRaw,
    endRaw: pick(ev.end_at),
    timezoneHint: pick(ev.timezone),
    venueName: pick(geo.name, geo.place_name),
    address: pick(geo.full_address, geo.address, geo.description),
    city: pick(geo.city, geo.city_state, geo.region),
    url,
    organizer: pick(entry?.calendar?.name, ev.host?.name, ev.calendar?.name),
    imageUrl: pick(ev.cover_url, ev.cover_image_url),
    // Heuristic: Luma discover exposes no price; the vast majority of these
    // community events are free RSVP, so treat them as free.
    isFree: true,
    raw: ev,
  };
}

async function fetchPaged(
  base: string,
  extra: Record<string, string>,
  maxPages: number,
  cfg: SourceConfig<LumaParams>,
  ctx: AdapterContext,
): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ pagination_limit: "50", ...extra });
    if (cursor) params.set("pagination_cursor", cursor);
    const data: any = await fetchJson(`${base}?${params.toString()}`, {
      headers: LUMA_HEADERS,
    });
    const entries: any[] = data?.entries ?? data?.events ?? [];
    for (const e of entries) {
      const r = mapLumaEvent(e, cfg);
      if (r) out.push(r);
    }
    if (!data?.has_more || !data?.next_cursor) break;
    cursor = data.next_cursor;
    await sleep(300);
  }
  ctx.logger.debug({ source: cfg.id, count: out.length }, "luma fetched");
  return out;
}

async function resolveCalendarId(url: string): Promise<string> {
  const html = await fetchText(url, { headers: { accept: "text/html" } });
  const m =
    html.match(/"calendar_api_id":"(cal-[^"]+)"/) ||
    html.match(/"api_id":"(cal-[^"]+)"/) ||
    html.match(/(cal-[A-Za-z0-9]+)/);
  if (!m) throw new Error(`Could not resolve Luma calendar id from ${url}`);
  return m[1]!;
}

export const lumaAdapter: SourceAdapter<LumaParams> = {
  type: "luma",
  parseParams(raw) {
    return LumaParams.parse(raw);
  },
  async fetchEvents(cfg, ctx) {
    const p = cfg.params;
    if (p.mode === "calendar") {
      const urls = p.urls?.length ? p.urls : p.url ? [p.url] : [];
      const calIds: string[] = p.calendarApiId ? [p.calendarApiId] : [];
      let failed = 0;
      for (const url of urls) {
        try {
          calIds.push(await resolveCalendarId(url));
        } catch (err) {
          failed++;
          ctx.logger.warn(
            { source: cfg.id, url, err: (err as Error).message },
            "luma calendar resolve failed",
          );
        }
      }
      if (!calIds.length) throw new Error("luma calendar mode: no calendars resolved");

      const out: RawEvent[] = [];
      for (const calId of calIds) {
        try {
          out.push(
            ...(await fetchPaged(
              "https://api.luma.com/calendar/get-items",
              { calendar_api_id: calId, period: p.period },
              p.maxPages,
              cfg,
              ctx,
            )),
          );
        } catch (err) {
          failed++;
          ctx.logger.warn(
            { source: cfg.id, calId, err: (err as Error).message },
            "luma calendar fetch failed",
          );
        }
      }
      return out;
    }

    // discover mode — sweep one or more slugs
    const slugs = p.slugs?.length ? p.slugs : p.slug ? [p.slug] : [];
    if (!slugs.length) throw new Error("luma discover mode needs slug or slugs");

    let lat = p.latitude;
    let lng = p.longitude;
    if ((lat == null || lng == null) && p.city) {
      const city = ctx.cities.find((c) => c.id === p.city);
      if (city?.latitude != null && city?.longitude != null) {
        lat = city.latitude;
        lng = city.longitude;
      }
    }

    const out: RawEvent[] = [];
    let failed = 0;
    for (const slug of slugs) {
      const extra: Record<string, string> = { slug };
      // Category slugs require coordinates; place slugs (e.g. "sf") don't.
      if (lat != null && lng != null) {
        extra.latitude = String(lat);
        extra.longitude = String(lng);
      }
      try {
        out.push(
          ...(await fetchPaged(
            "https://api.luma.com/discover/get-paginated-events",
            extra,
            p.maxPages,
            cfg,
            ctx,
          )),
        );
      } catch (err) {
        failed++;
        ctx.logger.warn(
          { source: cfg.id, slug, err: (err as Error).message },
          "luma discover crawl failed",
        );
      }
    }
    if (slugs.length > 0 && failed === slugs.length) {
      throw new Error(`all ${slugs.length} luma discover crawls failed`);
    }
    return out;
  },
};
