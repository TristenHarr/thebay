import * as cheerio from "cheerio";
import type { RawEvent } from "../../core/models/event";
import { collectEventNodes, mapJsonLdEvent, jsonLdToRawEvent } from "./jsonld-map";

/* eslint-disable @typescript-eslint/no-explicit-any */

// The pure mapping lives in ./jsonld-map so a browser client can share it (see that
// file's header). Re-exported here so every existing import site is unaffected.
export { mapJsonLdEvent, jsonLdToRawEvent, collectEventNodes } from "./jsonld-map";
export type { JsonLdRaw } from "./jsonld-map";

/** Pull every schema.org Event object out of a page's JSON-LD blocks. */
export function extractJsonLdEvents(html: string): any[] {
  const $ = cheerio.load(html);
  const out: any[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text().trim();
    if (!txt) return;
    let data: unknown;
    try {
      data = JSON.parse(txt);
    } catch {
      return;
    }
    collectEventNodes(data, out);
  });
  return out;
}

/** Extract JSON-LD events from HTML and map straight to RawEvents. */
export function jsonLdRawEvents(html: string, sourceId: string, sourceType: string): RawEvent[] {
  const out: RawEvent[] = [];
  for (const node of extractJsonLdEvents(html)) {
    const mapped = mapJsonLdEvent(node);
    if (mapped) out.push(jsonLdToRawEvent(mapped, sourceId, sourceType));
  }
  return out;
}
