/**
 * The extension's fetching layer — the one part of a worker client that differs per
 * client. Everything else (lease, submit, release, the loop, politeness) is the shared
 * `src/net/client.ts`.
 *
 * Why an extension at all: Eventbrite blocks datacenter IPs, which is the whole reason the
 * catalog is produced on somebody's Mac today. A browser extension is the honest answer
 * rather than a clever one — it is a *real* Chrome, on a *real* residential connection,
 * with a genuine Chrome User-Agent that we are not spoofing, and the user's own session if
 * they happen to be logged in. Sources that refuse a server refuse it for reasons that
 * simply don't apply here.
 *
 * Two paths:
 *
 *   · `fetchJson` for recipes that are plain APIs. No tab, no rendering.
 *   · `viaTab` for recipes whose data is embedded in a page — JSON-LD, `__NEXT_DATA__`,
 *     `window.__SERVER_DATA__`. The page is opened in a background tab, a content script
 *     reads those blocks with native DOM APIs, and the SAME pure mappers the server-side
 *     adapters use turn them into RawEvents. Sharing the mappers is load-bearing: a mapper
 *     that drifted between clients would make two honest workers disagree about the same
 *     page and look like liars.
 *
 * This never normalises. It ships RawEvents and lets the server derive the fingerprint.
 */
import type { RawEvent } from "../../src/core/models/event";
import type { LeaseFromServer, Receipt } from "../../src/net/client";
import { collectEventNodes, mapJsonLdEvent, jsonLdToRawEvent } from "../../src/sources/util/jsonld-map";
import { mapGenericItem, resolveUrlTemplate } from "../../src/sources/generic-json";
// The `-map` modules, not the adapters: the adapters carry cheerio and p-retry, neither of
// which belongs in a service worker that already has a parser and a fetch.
import { getResults, mapEbEvent } from "../../src/sources/eventbrite-map";
import { collectEvents, mapEvent as mapPartifulEvent } from "../../src/sources/partiful";
import { getPath } from "../../src/util/object";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** What a content script sends back after reading a page. */
export interface PageHarvest {
  jsonLd: any[];
  nextData: any | null;
  serverData: any | null;
  url: string;
}

/** Recipe types this client can honestly do. Anything else is handed straight back so a
 *  CLI worker (which has Playwright, node-ical and the API tokens) gets it instead. */
export const SUPPORTED = new Set(["generic-json", "html", "eventbrite", "partiful", "luma"]);

export class UnsupportedRecipe extends Error {
  constructor(type: string) {
    super(`this client can't run '${type}' recipes`);
  }
}

/**
 * A parsed page → RawEvents.
 *
 * Three sources of truth on a listing page, in descending order of how standard they are:
 *
 *   · JSON-LD, which every adapter already understands — mapped by the shared pure mapper;
 *   · `window.__SERVER_DATA__`, which is how Eventbrite ships its search results — mapped by
 *     the SAME `getResults`/`mapEbEvent` the server-side adapter uses;
 *   · `__NEXT_DATA__`, which is how Partiful ships its feed — mapped by the same
 *     `collectEvents`/`mapEvent`.
 *
 * Reusing those three mappers rather than re-deriving the shapes is the point. A page's
 * embedded blob is not JSON-LD and has no `@type`, so a generic tree-walk finds nothing in
 * it; and a second, extension-only implementation of Eventbrite's field mapping would drift
 * from the server's, at which point two honest workers reading one page would disagree and
 * consensus would read that as somebody lying.
 */
export function harvestToRaws(h: PageHarvest, sourceId: string, sourceType: string): RawEvent[] {
  const out: RawEvent[] = [];
  const seen = new Set<string>();
  const push = (e: RawEvent | null) => {
    if (!e?.url || seen.has(e.url)) return; // the same event in JSON-LD *and* the blob
    seen.add(e.url);
    out.push(e);
  };

  const nodes: any[] = [];
  for (const block of h.jsonLd) collectEventNodes(block, nodes);
  for (const node of nodes) {
    const mapped = mapJsonLdEvent(node);
    if (mapped) push(jsonLdToRawEvent(mapped, sourceId, sourceType));
  }

  const cfg = { id: sourceId, type: sourceType, enabled: true, params: {} } as any;
  if (h.serverData) {
    for (const ev of getResults(h.serverData)) push(mapEbEvent(ev, cfg));
  }
  if (h.nextData) {
    const pp = h.nextData?.props?.pageProps ?? h.nextData;
    for (const ev of collectEvents(pp)) push(mapPartifulEvent(ev, cfg));
  }
  return out;
}

/** Read a JSON API directly. Chrome's own fetch, from the user's own connection. */
async function fetchApi(lease: LeaseFromServer): Promise<{ raws: RawEvent[]; receipts: Receipt[] }> {
  const params = lease.recipe.params as any;
  const url = resolveUrlTemplate(String(params.url ?? ""), new Date());
  const started = Date.now();
  const res = await fetch(url, { credentials: "omit" });
  const bytes = Number(res.headers.get("content-length") ?? 0) || undefined;
  const receipt: Receipt = {
    url,
    status: res.status,
    bytes,
    serverDate: res.headers.get("date") ?? undefined,
    etag: res.headers.get("etag") ?? undefined,
    elapsedMs: Date.now() - started,
  };
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = await res.json();

  const items = params.itemsPath ? (getPath(body, params.itemsPath) as any[]) : body;
  const raws: RawEvent[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    const mapped = mapGenericItem(item, params.fieldMap ?? {}, lease.sourceId);
    if (mapped) raws.push(mapped);
  }
  return { raws, receipts: [receipt] };
}

/**
 * Open the page in a background tab, let it render, read the embedded data, close the tab.
 *
 * `active: false` so the user's browsing isn't hijacked — this should feel like a
 * background daemon that happens to live in Chrome, not like something taking over.
 */
async function fetchViaTab(
  lease: LeaseFromServer,
  urls: string[],
  deps: { openTab: (url: string) => Promise<PageHarvest> },
): Promise<{ raws: RawEvent[]; receipts: Receipt[] }> {
  const raws: RawEvent[] = [];
  const receipts: Receipt[] = [];
  const failures: string[] = [];

  for (const url of urls) {
    const started = Date.now();
    try {
      const harvest = await deps.openTab(url);
      raws.push(...harvestToRaws(harvest, lease.sourceId, lease.recipe.type));
      receipts.push({ url, status: 200, elapsedMs: Date.now() - started });
    } catch (err) {
      failures.push(`${url}: ${(err as Error).message}`);
      receipts.push({ url, status: 0, elapsedMs: Date.now() - started });
    }
    // The client's own share of politeness, on top of the coordinator's spacing.
    if (urls.length > 1) await new Promise((r) => setTimeout(r, Math.max(0, lease.politeness.minGapMs || 0)));
  }

  // The adapters' contract, unchanged: throw only when the WHOLE source is unreachable.
  // One dead page is a skipped page; every page dead is a failed lease.
  if (failures.length === urls.length && urls.length > 0) throw new Error(`all ${urls.length} page(s) failed: ${failures[0]}`);
  return { raws, receipts };
}

/** The URLs a recipe wants visited, for the tab path. */
export function pagesFor(lease: LeaseFromServer): string[] {
  const p = lease.recipe.params as any;
  if (Array.isArray(p.urls)) return p.urls.map(String);
  if (p.url) return [resolveUrlTemplate(String(p.url), new Date())];

  if (lease.recipe.type === "eventbrite") {
    // The same shape src/sources/eventbrite.ts builds: location × query hub pages.
    const locations: string[] = Array.isArray(p.locations) ? p.locations : [];
    const queries: string[] = Array.isArray(p.queries) ? p.queries : ["technology"];
    const out: string[] = [];
    for (const loc of locations) for (const q of queries) out.push(`https://www.eventbrite.com/d/${loc}/${q}/`);
    return out;
  }
  if (lease.recipe.type === "partiful") return ["https://partiful.com/discover"];
  return [];
}

export function makeExecutor(deps: { openTab: (url: string) => Promise<PageHarvest> }) {
  return async function execute(lease: LeaseFromServer): Promise<{ raws: RawEvent[]; receipts: Receipt[] }> {
    const type = lease.recipe.type;
    if (!SUPPORTED.has(type)) throw new UnsupportedRecipe(type);

    // A pure JSON API needs no tab. `luma` is one too, and from a residential browser it
    // simply isn't blocked — which is the entire reason this client exists.
    const params = lease.recipe.params as any;
    if (type === "generic-json" || (type === "luma" && params.url)) return await fetchApi(lease);

    const pages = pagesFor(lease);
    if (!pages.length) throw new UnsupportedRecipe(`${type} (no page list could be derived)`);
    return await fetchViaTab(lease, pages, deps);
  };
}
