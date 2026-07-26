import { z } from "zod";
import type { RawEvent } from "../core/models/event";
import type { SourceConfig } from "../core/models/source";
import type { AdapterContext, SourceAdapter } from "./types";
import { fetchText, sleep } from "./util/http";

/* eslint-disable @typescript-eslint/no-explicit-any */

const PartifulParams = z.object({
  city: z.string().optional(),
  cities: z.array(z.string()).optional(), // partiful city slugs: sf, la, nyc, bos, dc, chi, atx…
  fallbackCity: z.string().default("San Francisco Bay Area"),
});
type PartifulParams = z.infer<typeof PartifulParams>;

export function extractNextData(html: string): any | null {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return null;
  }
}

/** Walk the explore pageProps and collect every distinct event object. */
export function collectEvents(pp: any): any[] {
  const byId = new Map<string, any>();
  const pushItem = (it: any) => {
    const ev = it?.event ?? (it?.id && it?.title ? it : null);
    if (ev?.id && ev?.title) byId.set(ev.id, ev);
  };
  const pushArr = (arr: any) => Array.isArray(arr) && arr.forEach(pushItem);
  pushArr(pp?.feedItems);
  for (const sec of pp?.sections ?? []) {
    pushArr(sec?.feedItems);
    pushArr(sec?.items);
    pushArr(sec?.events);
  }
  if (pp?.trendingSection) pushArr(pp.trendingSection.feedItems ?? pp.trendingSection.items);
  return [...byId.values()];
}

function locationOf(ev: any): { name?: string; address?: string } {
  const li = ev.locationInfo ?? ev.location;
  if (!li) return {};
  if (typeof li === "string") return { name: li };
  return { name: li.name ?? li.locationName ?? li.venue, address: li.address ?? li.formattedAddress };
}

function imageOf(ev: any): string | undefined {
  const im = ev.image;
  if (!im) return undefined;
  if (typeof im === "string") return im;
  return im.url ?? im.src ?? im.original;
}

export function mapEvent(ev: any, cfg: SourceConfig<PartifulParams>): RawEvent | null {
  const title = ev.title;
  const startRaw = ev.startDate ?? ev.startsAt ?? ev.start;
  if (!title || !startRaw || !ev.id) return null;
  const loc = locationOf(ev);
  return {
    sourceId: cfg.id,
    sourceType: "partiful",
    externalId: ev.id,
    title,
    description: typeof ev.description === "string" ? ev.description : undefined,
    startRaw,
    endRaw: ev.endDate ?? ev.endsAt,
    timezoneHint: ev.timezone,
    venueName: loc.name,
    address: loc.address ?? loc.name,
    city: loc.name ?? loc.address ?? cfg.params.fallbackCity,
    url: `https://partiful.com/e/${ev.id}`,
    imageUrl: imageOf(ev),
    isFree: true, // Partiful is an RSVP platform — no paid ticketing in the flow
    raw: { id: ev.id, title },
  };
}

export const partifulAdapter: SourceAdapter<PartifulParams> = {
  type: "partiful",
  parseParams(raw) {
    return PartifulParams.parse(raw);
  },
  async fetchEvents(cfg, ctx) {
    const slugs = cfg.params.cities?.length
      ? cfg.params.cities
      : cfg.params.city
        ? [cfg.params.city]
        : ["sf"];
    const out: RawEvent[] = [];
    let failed = 0;
    for (const slug of slugs) {
      try {
        const html = await fetchText(`https://partiful.com/explore/${slug}`, {
          headers: { accept: "text/html" },
        });
        const nd = extractNextData(html);
        if (!nd) throw new Error("no __NEXT_DATA__ on Partiful explore page");
        for (const ev of collectEvents(nd.props?.pageProps ?? {})) {
          const r = mapEvent(ev, cfg);
          if (r) out.push(r);
        }
      } catch (err) {
        failed++;
        ctx.logger.warn(
          { source: cfg.id, slug, err: (err as Error).message },
          "partiful crawl failed",
        );
      }
      await sleep(300);
    }
    if (slugs.length > 0 && failed === slugs.length) {
      throw new Error(`all ${slugs.length} partiful crawls failed`);
    }
    ctx.logger.info({ source: cfg.id, count: out.length }, "partiful fetched");
    return out;
  },
};
