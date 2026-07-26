import { z } from "zod";
import type { RawEvent } from "../core/models/event";
import type { SourceAdapter } from "./types";
import { fetchJson } from "./util/http";
import { asString, getPath } from "../util/object";

/* eslint-disable @typescript-eslint/no-explicit-any */

const GenericJsonParams = z.object({
  url: z.string().min(1),
  itemsPath: z.string().default(""),
  fieldMap: z.record(z.string(), z.string()),
});
type GenericJsonParams = z.infer<typeof GenericJsonParams>;

/** Map one arbitrary JSON item onto a RawEvent via the source's fieldMap. Pure +
 *  exported so the mapping contract is unit-testable without a live fetch. */
export function mapGenericItem(item: any, fieldMap: Record<string, string>, sourceId: string): RawEvent | null {
  const g = (key: string): string | undefined => {
    const f = fieldMap[key];
    return f ? asString(getPath(item, f)) : undefined;
  };
  const title = g("title");
  const startRaw = g("startRaw");
  const link = g("url");
  if (!title || !startRaw || !link) return null;
  return {
    sourceId,
    sourceType: "generic-json",
    externalId: g("externalId"),
    title,
    description: g("description"),
    startRaw,
    endRaw: g("endRaw"),
    venueName: g("venueName"),
    address: g("address"),
    city: g("city"),
    url: link,
    organizer: g("organizer"),
    imageUrl: g("imageUrl"),
    raw: item,
  };
}

export const genericJsonAdapter: SourceAdapter<GenericJsonParams> = {
  type: "generic-json",
  parseParams(raw) {
    return GenericJsonParams.parse(raw);
  },
  async fetchEvents(cfg, ctx) {
    const { url, itemsPath, fieldMap } = cfg.params;
    const data = await fetchJson<any>(url);
    const items = itemsPath ? getPath(data, itemsPath) : data;
    const list: any[] = Array.isArray(items) ? items : [];

    const out: RawEvent[] = [];
    for (const item of list) {
      const mapped = mapGenericItem(item, fieldMap, cfg.id);
      if (mapped) out.push(mapped);
    }
    ctx.logger.debug({ source: cfg.id, count: out.length }, "generic-json fetched");
    return out;
  },
};
