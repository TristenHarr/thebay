/**
 * Eventbrite's embedded-JSON mapping, the PURE half. No cheerio, no `fetch`, no Node — so a
 * browser client can share it.
 *
 * Split out for the same reason `util/jsonld-map.ts` was: the Chrome extension reads
 * `window.__SERVER_DATA__` off a live page with native DOM access and needs only the mapping,
 * while `./eventbrite.ts` additionally parses HTML with cheerio for its server-side path.
 * Importing the adapter dragged 600KB of HTML parser into a service worker that has a parser
 * built in.
 *
 * The mapping itself MUST stay shared. Two clients with their own idea of which Eventbrite field
 * is the start time would disagree about the same page, and consensus reads disagreement as
 * somebody lying (src/core/scrape/consensus.ts).
 */
import type { RawEvent } from "../core/models/event";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Only `id` is read — kept structural so this file needn't know the adapter's zod params. */
export interface MapCfg {
  id: string;
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

export function mapEbEvent(ev: any, cfg: MapCfg): RawEvent | null {
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
