/**
 * The browser client's fetching layer.
 *
 * The extension exists for one reason: Eventbrite blocks datacenter IPs, which is why the
 * catalog is produced on somebody's laptop today. A real Chrome on a real residential
 * connection isn't a trick, it's just a browser — and its User-Agent is genuinely Chrome's,
 * which is more than the server-side adapter can say (src/sources/util/http.ts spoofs one).
 *
 * What's tested here is the part that could silently diverge: that this client produces the
 * SAME RawEvents from the same page as the server-side adapters do, that it declines work it
 * can't honestly do instead of failing it, and that it never normalises.
 */
import { describe, it, expect } from "vitest";
import { harvestToRaws, pagesFor, makeExecutor, SUPPORTED, UnsupportedRecipe, type PageHarvest } from "../extension/src/executor";
import { jsonLdRawEvents } from "../src/sources/util/jsonld";
import type { LeaseFromServer } from "../src/net/client";

const lease = (over: Partial<LeaseFromServer> = {}): LeaseFromServer => ({
  leaseId: "L1",
  jobId: "J1",
  sourceId: "src",
  recipeId: "R1",
  windowStart: "2026-07-26T12:00:00.000Z",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  recipe: { type: "html", params: {}, host: "example.com" },
  politeness: { host: "example.com", minGapMs: 0, disallow: [] },
  ...over,
});

/** A schema.org Event exactly as a real listing page embeds it. */
const EVENT_LD = {
  "@context": "https://schema.org",
  "@type": "Event",
  name: "AI Infra Night",
  url: "https://example.com/e/ai-infra-night",
  startDate: "2026-08-01T18:00:00-07:00",
  endDate: "2026-08-01T21:00:00-07:00",
  description: "Talks on inference at the edge.",
  image: ["https://example.com/img.jpg"],
  location: {
    "@type": "Place",
    name: "Shack15",
    address: { "@type": "PostalAddress", streetAddress: "1 Ferry Building", addressLocality: "San Francisco", addressRegion: "CA", postalCode: "94111" },
  },
  organizer: { "@type": "Organization", name: "Bay Infra" },
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

const harvest = (over: Partial<PageHarvest> = {}): PageHarvest => ({
  jsonLd: [EVENT_LD],
  nextData: null,
  serverData: null,
  url: "https://example.com/list",
  ...over,
});

describe("extension executor — page harvesting", () => {
  it("produces exactly what the server-side adapter produces from the same page", () => {
    // The load-bearing assertion of this whole file. If the browser path and the cheerio
    // path ever disagree, two honest workers looking at one page would disagree, and
    // consensus would read that as somebody lying.
    const html = `<html><head><script type="application/ld+json">${JSON.stringify(EVENT_LD)}</script></head><body></body></html>`;
    const viaCheerio = jsonLdRawEvents(html, "src", "html");
    const viaBrowser = harvestToRaws(harvest(), "src", "html");
    expect(viaBrowser).toEqual(viaCheerio);
    expect(viaBrowser[0]).toMatchObject({
      title: "AI Infra Night",
      venueName: "Shack15",
      city: "San Francisco",
      isFree: true,
      organizer: "Bay Infra",
    });
  });

  it("ships RAW events — no fingerprint, no resolved times", () => {
    const [e] = harvestToRaws(harvest(), "src", "html");
    expect(e).toHaveProperty("startRaw");
    expect(e).not.toHaveProperty("fingerprint");
    expect(e).not.toHaveProperty("startUtc");
    expect(e).not.toHaveProperty("id");
  });

  it("reads Eventbrite's __SERVER_DATA__ with the SAME mapper the server adapter uses", () => {
    // The real shape, not a JSON-LD lookalike: `search_data.events.results` with
    // Eventbrite's own field names. A second, extension-only mapping of these fields is
    // exactly the drift this shares code to avoid.
    const serverData = {
      search_data: {
        events: {
          results: [
            {
              id: "5551212",
              name: { text: "Robotics Demo Day" },
              url: "https://www.eventbrite.com/e/robotics-demo-day-5551212",
              start: { utc: "2026-08-03T01:00:00Z", timezone: "America/Los_Angeles" },
              end: { utc: "2026-08-03T04:00:00Z" },
              is_free: true,
              summary: { text: "Arms, legs and grippers." },
              primary_venue: { name: "Frontier Tower", address: { localized_address_display: "995 Market St, San Francisco, CA", city: "San Francisco" } },
              primary_organizer: { name: "Bay Robotics" },
            },
          ],
        },
      },
    };
    const raws = harvestToRaws(harvest({ jsonLd: [], serverData }), "eb-hubs", "eventbrite");
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatchObject({
      sourceId: "eb-hubs",
      sourceType: "eventbrite",
      externalId: "5551212",
      title: "Robotics Demo Day",
      venueName: "Frontier Tower",
      city: "San Francisco",
      organizer: "Bay Robotics",
      isFree: true,
    });
  });

  it("reads Partiful's __NEXT_DATA__ feed with its own mapper", () => {
    const nextData = {
      props: {
        pageProps: {
          feedItems: [{ event: { id: "abc123", title: "Founder Speed Dating", startDate: "2026-08-04T02:00:00Z", locationInfo: { name: "The Midway" } } }],
        },
      },
    };
    const raws = harvestToRaws(harvest({ jsonLd: [], nextData }), "partiful-discover", "partiful");
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatchObject({
      sourceType: "partiful",
      externalId: "abc123",
      title: "Founder Speed Dating",
      url: "https://partiful.com/e/abc123",
      venueName: "The Midway",
    });
  });

  it("counts an event once when it appears in BOTH json-ld and the embedded blob", () => {
    // Real pages do this constantly, and double-reporting would make an honest worker look
    // like it was inventing events.
    const serverData = {
      search_data: {
        events: {
          results: [{ id: "1", name: { text: "AI Infra Night" }, url: EVENT_LD.url, start: { utc: "2026-08-02T01:00:00Z" } }],
        },
      },
    };
    const raws = harvestToRaws(harvest({ serverData }), "src", "html");
    expect(raws).toHaveLength(1);
  });

  it("walks @graph and itemListElement, the way real listing pages nest", () => {
    const graph = { "@context": "https://schema.org", "@graph": [{ "@type": "WebPage" }, EVENT_LD] };
    expect(harvestToRaws(harvest({ jsonLd: [graph] }), "s", "html")).toHaveLength(1);
    const list = {
      "@type": "ItemList",
      itemListElement: [{ "@type": "ListItem", item: { ...EVENT_LD, url: "https://example.com/e/a" } }, { "@type": "ListItem", item: { ...EVENT_LD, url: "https://example.com/e/b" } }],
    };
    expect(harvestToRaws(harvest({ jsonLd: [list] }), "s", "html")).toHaveLength(2);
  });

  it("skips unusable nodes rather than throwing on a messy page", () => {
    const junk = [{ "@type": "Event" }, { "@type": "Event", name: "No date or url" }, null, "a string", 42];
    expect(harvestToRaws(harvest({ jsonLd: junk as any }), "s", "html")).toEqual([]);
    expect(harvestToRaws(harvest({ jsonLd: [] }), "s", "html")).toEqual([]);
  });
});

describe("extension executor — what it will and won't take on", () => {
  it("declines recipe types it cannot honestly run", async () => {
    // `ical` needs node-ical; `airtable`'s share mode needs credentials. Declining hands
    // the job straight back so a CLI worker gets it — far better than failing it and
    // looking unreliable.
    expect(SUPPORTED.has("ical")).toBe(false);
    expect(SUPPORTED.has("airtable")).toBe(false);
    const execute = makeExecutor({ openTab: async () => harvest() });
    await expect(execute(lease({ recipe: { type: "ical", params: { urls: ["https://x/y.ics"] }, host: "x" } }))).rejects.toThrow(UnsupportedRecipe);
  });

  it("derives Eventbrite's hub pages the same way the server adapter does", () => {
    const pages = pagesFor(
      lease({ recipe: { type: "eventbrite", params: { locations: ["ca--san-francisco", "ca--oakland"], queries: ["technology", "startup"] }, host: "www.eventbrite.com" } }),
    );
    expect(pages).toEqual([
      "https://www.eventbrite.com/d/ca--san-francisco/technology/",
      "https://www.eventbrite.com/d/ca--san-francisco/startup/",
      "https://www.eventbrite.com/d/ca--oakland/technology/",
      "https://www.eventbrite.com/d/ca--oakland/startup/",
    ]);
  });

  it("prefers an explicit url list, and resolves a {{now}} template", () => {
    expect(pagesFor(lease({ recipe: { type: "html", params: { urls: ["https://a/1", "https://a/2"] }, host: "a" } }))).toHaveLength(2);
    const [url] = pagesFor(lease({ recipe: { type: "html", params: { url: "https://a/e?after={{now}}" }, host: "a" } }));
    expect(url).toMatch(/^https:\/\/a\/e\?after=20/); // substituted, not left as a literal
  });

  it("refuses a recipe it can't derive any page for, instead of visiting nothing", async () => {
    const execute = makeExecutor({ openTab: async () => harvest() });
    await expect(execute(lease({ recipe: { type: "html", params: {}, host: "x" } }))).rejects.toThrow(/no page list/);
  });

  it("visits every page and merges what it finds", async () => {
    const visited: string[] = [];
    const execute = makeExecutor({
      openTab: async (url) => {
        visited.push(url);
        return harvest({ jsonLd: [{ ...EVENT_LD, url: `https://example.com/e/${visited.length}` }] });
      },
    });
    const out = await execute(lease({ recipe: { type: "html", params: { urls: ["https://a/1", "https://a/2"] }, host: "a" } }));
    expect(visited).toEqual(["https://a/1", "https://a/2"]);
    expect(out.raws).toHaveLength(2);
    expect(out.receipts).toHaveLength(2);
  });

  it("keeps going when ONE page fails, and fails only when every page does", async () => {
    // The adapters' existing contract, preserved: a dead page is a skipped page; a dead
    // source is a failed lease, which is what tells the coordinator to back the host off.
    let n = 0;
    const flaky = makeExecutor({
      openTab: async () => {
        if (++n === 1) throw new Error("tab crashed");
        return harvest();
      },
    });
    const out = await flaky(lease({ recipe: { type: "html", params: { urls: ["https://a/1", "https://a/2"] }, host: "a" } }));
    expect(out.raws).toHaveLength(1);
    expect(out.receipts.find((r) => r.status === 0)).toBeTruthy(); // the failure is recorded

    const dead = makeExecutor({
      openTab: async () => {
        throw new Error("every tab crashed");
      },
    });
    await expect(dead(lease({ recipe: { type: "html", params: { urls: ["https://a/1", "https://a/2"] }, host: "a" } }))).rejects.toThrow(/all 2 page/);
  });

  it("reads a plain JSON API without opening a tab at all", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ events: [{ id: "e1", name: "Compilers After Dark", startDateTime: "2026-08-02T19:00:00-07:00", url: "https://cv.ai/e/1" }] }), {
        status: 200,
        headers: { "content-type": "application/json", date: "Sun, 26 Jul 2026 12:00:00 GMT", etag: 'W/"abc"' },
      })) as any;
    try {
      let tabsOpened = 0;
      const execute = makeExecutor({
        openTab: async () => {
          tabsOpened++;
          return harvest();
        },
      });
      const out = await execute(
        lease({
          recipe: {
            type: "generic-json",
            params: {
              url: "https://api.cerebralvalley.ai/v1/e?after={{now}}",
              itemsPath: "events",
              fieldMap: { title: "name", startRaw: "startDateTime", url: "url", externalId: "id" },
            },
            host: "api.cerebralvalley.ai",
          },
        }),
      );
      expect(tabsOpened).toBe(0);
      expect(out.raws).toHaveLength(1);
      expect(out.raws[0]).toMatchObject({ title: "Compilers After Dark", externalId: "e1" });
      // The receipt carries the host's own headers — cheap to report honestly, awkward to fake.
      expect(out.receipts[0]).toMatchObject({ status: 200, serverDate: "Sun, 26 Jul 2026 12:00:00 GMT", etag: 'W/"abc"' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("treats a non-2xx API response as a source failure, with the receipt kept", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as any;
    try {
      const execute = makeExecutor({ openTab: async () => harvest() });
      await expect(
        execute(lease({ recipe: { type: "generic-json", params: { url: "https://api.x/e", fieldMap: {} }, host: "api.x" } })),
      ).rejects.toThrow(/503/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
