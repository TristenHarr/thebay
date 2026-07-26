/**
 * schema.org JSON-LD → RawEvent, the PURE half. No cheerio, no DOM, no Node — so this
 * runs in the Worker, in the CLI, and inside a Chrome extension's service worker.
 *
 * The split exists for that last one. `./jsonld.ts` parses HTML with cheerio, which is
 * both large and pointless in a browser that already has a parser: the extension reads
 * `script[type="application/ld+json"]` with native DOM APIs and then maps the parsed
 * objects with exactly the code below. Same mapping, one implementation — which matters,
 * because a mapper that drifted between clients would make two honest workers disagree
 * about the same page and look like they were lying.
 */
import type { RawEvent } from "../../core/models/event";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Walk a parsed JSON-LD tree collecting every schema.org Event node. */
export function collectEventNodes(node: any, out: any[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectEventNodes(n, out);
    return;
  }
  if (node && typeof node === "object") {
    const type = node["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => typeof t === "string" && /Event/i.test(t))) {
      out.push(node);
    }
    if (node["@graph"]) collectEventNodes(node["@graph"], out);
    if (node.itemListElement) collectEventNodes(node.itemListElement, out);
    if (node.item) collectEventNodes(node.item, out);
  }
}

function locationParts(loc: any): {
  venueName?: string;
  address?: string;
  city?: string;
} {
  if (!loc) return {};
  const l = Array.isArray(loc) ? loc[0] : loc;
  if (typeof l === "string") return { address: l };
  const venueName = l?.name;
  const addr = l?.address;
  let address: string | undefined;
  let city: string | undefined;
  if (typeof addr === "string") address = addr;
  else if (addr && typeof addr === "object") {
    city = addr.addressLocality;
    address = [
      addr.streetAddress,
      addr.addressLocality,
      addr.addressRegion,
      addr.postalCode,
    ]
      .filter(Boolean)
      .join(", ");
  }
  return { venueName, address, city };
}

function firstImage(image: any): string | undefined {
  if (!image) return undefined;
  if (typeof image === "string") return image;
  if (Array.isArray(image)) return firstImage(image[0]);
  if (typeof image === "object") return image.url || image.contentUrl;
  return undefined;
}

function offerInfo(offers: any): { isFree?: boolean; priceText?: string } {
  if (!offers) return {};
  const o = Array.isArray(offers) ? offers[0] : offers;
  const price = o?.price ?? o?.lowPrice;
  if (price === undefined || price === null) return {};
  const num = Number(price);
  if (!Number.isNaN(num)) {
    if (num === 0) return { isFree: true, priceText: "Free" };
    return { isFree: false, priceText: `${o.priceCurrency ?? "$"}${price}` };
  }
  return { priceText: String(price) };
}

export interface JsonLdRaw {
  title: string;
  url: string;
  startRaw?: string;
  endRaw?: string;
  description?: string;
  venueName?: string;
  address?: string;
  city?: string;
  imageUrl?: string;
  isFree?: boolean;
  priceText?: string;
  organizer?: string;
  raw: any;
}

/** Map a JSON-LD Event node into loose RawEvent-ish fields. Returns null if unusable. */
export function mapJsonLdEvent(node: any): JsonLdRaw | null {
  const title: string | undefined = node?.name;
  const url: string | undefined =
    node?.url || node?.["@id"] || node?.mainEntityOfPage;
  const startRaw: string | undefined = node?.startDate;
  if (!title || !url || !startRaw) return null;

  const loc = locationParts(node.location);
  const offers = offerInfo(node.offers);
  const organizer =
    (typeof node.organizer === "object" ? node.organizer?.name : node.organizer) ??
    (typeof node.performer === "object" ? node.performer?.name : undefined);

  return {
    title,
    url,
    startRaw,
    endRaw: node.endDate,
    description: typeof node.description === "string" ? node.description : undefined,
    venueName: loc.venueName,
    address: loc.address,
    city: loc.city,
    imageUrl: firstImage(node.image),
    isFree: offers.isFree,
    priceText: offers.priceText,
    organizer,
    raw: node,
  };
}

export function jsonLdToRawEvent(
  j: JsonLdRaw,
  sourceId: string,
  sourceType: string,
): RawEvent {
  return {
    sourceId,
    sourceType,
    title: j.title,
    url: j.url,
    startRaw: j.startRaw!,
    endRaw: j.endRaw,
    description: j.description,
    venueName: j.venueName,
    address: j.address,
    city: j.city,
    imageUrl: j.imageUrl,
    isFree: j.isFree,
    priceText: j.priceText,
    organizer: j.organizer,
    raw: j.raw,
  };
}
