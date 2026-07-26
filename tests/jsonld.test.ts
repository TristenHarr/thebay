import { describe, it, expect } from "vitest";
import { extractJsonLdEvents, mapJsonLdEvent, jsonLdRawEvents } from "../src/sources/util/jsonld";

/** Wrap one or more JSON-LD objects in a page the way real sites emit them. */
const page = (...blocks: unknown[]) =>
  `<html><head>${blocks.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join("")}</head><body>x</body></html>`;

const EVENT = {
  "@context": "https://schema.org",
  "@type": "Event",
  name: "AI Founders Dinner",
  url: "https://ex.com/e/1",
  startDate: "2026-08-01T18:00:00-07:00",
  endDate: "2026-08-01T21:00:00-07:00",
  description: "An evening for AI founders.",
  location: { "@type": "Place", name: "DNA Lounge", address: { streetAddress: "375 11th St", addressLocality: "San Francisco", addressRegion: "CA", postalCode: "94103" } },
  image: "https://ex.com/img.jpg",
  offers: { "@type": "Offer", price: "0", priceCurrency: "$" },
  organizer: { "@type": "Organization", name: "SF AI Club" },
};

describe("JSON-LD extraction — the Eventbrite/Meetup/Partiful parsing backbone", () => {
  it("extracts a schema.org Event and maps every field", () => {
    const [raw] = jsonLdRawEvents(page(EVENT), "eb-hubs", "eventbrite");
    expect(raw).toMatchObject({
      sourceId: "eb-hubs",
      sourceType: "eventbrite",
      title: "AI Founders Dinner",
      url: "https://ex.com/e/1",
      startRaw: "2026-08-01T18:00:00-07:00",
      endRaw: "2026-08-01T21:00:00-07:00",
      venueName: "DNA Lounge",
      city: "San Francisco",
      organizer: "SF AI Club",
      imageUrl: "https://ex.com/img.jpg",
      isFree: true,
    });
    expect(raw!.address).toBe("375 11th St, San Francisco, CA, 94103");
  });

  it("finds events nested in @graph and itemListElement (how real pages wrap lists)", () => {
    const graph = { "@context": "https://schema.org", "@graph": [{ "@type": "WebSite" }, EVENT] };
    const list = { "@type": "ItemList", itemListElement: [{ "@type": "ListItem", item: { ...EVENT, name: "Second", url: "https://ex.com/e/2" } }] };
    expect(extractJsonLdEvents(page(graph)).length).toBe(1);
    const all = jsonLdRawEvents(page(graph, list), "s", "t");
    expect(all.map((e) => e.title).sort()).toEqual(["AI Founders Dinner", "Second"]);
  });

  it("matches Event subtypes and @type arrays (MusicEvent, BusinessEvent, …)", () => {
    expect(extractJsonLdEvents(page({ "@type": "MusicEvent", name: "x", url: "u", startDate: "2026-08-01" })).length).toBe(1);
    expect(extractJsonLdEvents(page({ "@type": ["Thing", "SocialEvent"], name: "x", url: "u", startDate: "2026-08-01" })).length).toBe(1);
    expect(extractJsonLdEvents(page({ "@type": "Product", name: "not an event" })).length).toBe(0);
  });

  it("drops unusable nodes (no title / url / startDate) instead of emitting junk", () => {
    expect(mapJsonLdEvent({ "@type": "Event", url: "u", startDate: "2026-08-01" })).toBeNull(); // no name
    expect(mapJsonLdEvent({ "@type": "Event", name: "x", startDate: "2026-08-01" })).toBeNull(); // no url
    expect(mapJsonLdEvent({ "@type": "Event", name: "x", url: "u" })).toBeNull(); // no date
    // falls back to @id when url is absent
    expect(mapJsonLdEvent({ "@type": "Event", name: "x", "@id": "https://id", startDate: "2026-08-01" })?.url).toBe("https://id");
  });

  it("survives malformed JSON in a script block (skips it, keeps the good ones)", () => {
    const html = `<script type="application/ld+json">{ not json </script>` + page(EVENT).replace(/<\/?html>|<\/?head>|<\/?body>|x/g, "");
    expect(jsonLdRawEvents(html, "s", "t").length).toBe(1);
  });

  it("parses offers into free/priced, and location given as a bare string", () => {
    expect(mapJsonLdEvent({ ...EVENT, offers: { price: "25", priceCurrency: "$" } })?.priceText).toBe("$25");
    expect(mapJsonLdEvent({ ...EVENT, offers: { price: 0 } })?.isFree).toBe(true);
    const s = mapJsonLdEvent({ ...EVENT, location: "123 Market St, SF" });
    expect(s?.address).toBe("123 Market St, SF");
  });

  it("picks the first image from string / array / object forms", () => {
    expect(mapJsonLdEvent({ ...EVENT, image: ["https://a.jpg", "https://b.jpg"] })?.imageUrl).toBe("https://a.jpg");
    expect(mapJsonLdEvent({ ...EVENT, image: { url: "https://c.jpg" } })?.imageUrl).toBe("https://c.jpg");
  });
});
