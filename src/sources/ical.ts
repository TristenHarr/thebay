import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ical from "node-ical";
import { z } from "zod";
import type { RawEvent } from "../core/models/event";
import type { SourceAdapter } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const IcalParams = z.object({
  url: z.string().optional(),
  urls: z.array(z.string()).optional(),
});
type IcalParams = z.infer<typeof IcalParams>;

function valOf(v: any): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.val === "string") return v.val;
  return undefined;
}

function organizerName(org: any): string | undefined {
  if (!org) return undefined;
  if (typeof org === "string") return org.replace(/^mailto:/i, "");
  if (typeof org === "object") {
    return (
      org.params?.CN ||
      (typeof org.val === "string" ? org.val.replace(/^mailto:/i, "") : undefined)
    );
  }
  return undefined;
}

export const icalAdapter: SourceAdapter<IcalParams> = {
  type: "ical",
  parseParams(raw) {
    return IcalParams.parse(raw);
  },
  async fetchEvents(cfg, ctx) {
    const p = cfg.params;
    const urls = p.urls?.length ? p.urls : p.url ? [p.url] : [];
    if (!urls.length) throw new Error("ical source needs url or urls");

    const out: RawEvent[] = [];
    let failed = 0;
    for (const url of urls) {
      try {
        const isHttp = /^https?:\/\//i.test(url);
        const data = (
          isHttp
            ? await ical.async.fromURL(url)
            : ical.sync.parseICS(await readFile(resolve(process.cwd(), url), "utf8"))
        ) as Record<string, any>;
        for (const key of Object.keys(data)) {
          const v = data[key];
          if (!v || v.type !== "VEVENT") continue;
          const title = valOf(v.summary);
          if (!title || !(v.start instanceof Date)) continue;
          const tz = (v.start as any).tz;
          const eventUrl =
            valOf(v.url) ||
            (isHttp ? url : `https://eventers.local/ical/${encodeURIComponent(v.uid || key)}`);
          const location = valOf(v.location);
          out.push({
            sourceId: cfg.id,
            sourceType: "ical",
            externalId: valOf(v.uid) || key,
            title,
            description: valOf(v.description),
            startRaw: v.start,
            endRaw: v.end instanceof Date ? v.end : undefined,
            timezoneHint: typeof tz === "string" ? tz : undefined,
            address: location,
            city: location,
            url: eventUrl,
            organizer: organizerName(v.organizer),
            raw: { uid: v.uid, summary: title },
          });
        }
      } catch (err) {
        failed++;
        ctx.logger.warn(
          { source: cfg.id, url, err: (err as Error).message },
          "ical feed failed",
        );
      }
    }
    if (urls.length > 0 && failed === urls.length) {
      throw new Error(`all ${urls.length} ical feeds failed`);
    }
    ctx.logger.debug({ source: cfg.id, count: out.length }, "ical parsed");
    return out;
  },
};
