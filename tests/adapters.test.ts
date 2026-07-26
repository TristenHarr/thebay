import { describe, it, expect } from "vitest";
import { mapLumaEvent } from "../src/sources/luma";
import { extractAssignedJson, getResults, mapEbEvent } from "../src/sources/eventbrite";
import { extractNextData, collectEvents, mapEvent as mapPartiful } from "../src/sources/partiful";
import { mapGenericItem, resolveUrlTemplate } from "../src/sources/generic-json";

const cfg = (over: Record<string, unknown> = {}) => ({ id: "src-1", params: {}, ...over }) as any;

// ── Luma ──────────────────────────────────────────────────────────────────────
describe("Luma adapter — mapLumaEvent", () => {
  it("maps a discover entry (event nested under .event, geo + slug→url)", () => {
    const raw = mapLumaEvent(
      {
        event: {
          api_id: "evt-abc", name: "AI Infra Night", start_at: "2026-08-01T18:00:00Z", end_at: "2026-08-01T21:00:00Z",
          timezone: "America/Los_Angeles", description_short: "For AI infra builders", slug: "ai-infra",
          geo_address_info: { name: "DNA Lounge", full_address: "375 11th St, San Francisco, CA", city: "San Francisco" },
          cover_url: "https://img/x.jpg",
        },
        calendar: { name: "SF AI Club" },
      },
      cfg({ id: "luma-bay" }),
    )!;
    expect(raw).toMatchObject({
      sourceId: "luma-bay", sourceType: "luma", externalId: "evt-abc", title: "AI Infra Night",
      startRaw: "2026-08-01T18:00:00Z", timezoneHint: "America/Los_Angeles", venueName: "DNA Lounge",
      city: "San Francisco", organizer: "SF AI Club", url: "https://lu.ma/ai-infra", isFree: true,
    });
  });

  it("absolutizes a full url, and returns null when title or start is missing", () => {
    expect(mapLumaEvent({ event: { name: "X", start_at: "2026-08-01T18:00:00Z", url: "https://lu.ma/e/full" } }, cfg())!.url).toBe("https://lu.ma/e/full");
    expect(mapLumaEvent({ event: { name: "No Start" } }, cfg())).toBeNull();
    expect(mapLumaEvent({ event: { start_at: "2026-08-01T18:00:00Z" } }, cfg())).toBeNull();
    expect(mapLumaEvent({}, cfg())).toBeNull();
  });
});

// ── Eventbrite ──────────────────────────────────────────────────────────────────
describe("Eventbrite adapter", () => {
  it("extractAssignedJson pulls a balanced JSON object out of an inline assignment (ignoring braces in strings)", () => {
    const html = `<script>window.__SERVER_DATA__ = {"a":1,"s":"has } brace","nested":{"b":2}};</script>`;
    expect(extractAssignedJson(html, "window.__SERVER_DATA__")).toEqual({ a: 1, s: "has } brace", nested: { b: 2 } });
    expect(extractAssignedJson("<script>nothing here</script>", "window.__SERVER_DATA__")).toBeNull();
  });

  it("getResults finds events across the shapes Eventbrite serves", () => {
    expect(getResults({ search_data: { events: { results: [{ id: 1 }] } } }).length).toBe(1);
    expect(getResults({ search_data: { events: [{ id: 2 }] } }).length).toBe(1);
    expect(getResults({ events: { results: [{ id: 3 }, { id: 4 }] } }).length).toBe(2);
    expect(getResults({}).length).toBe(0);
  });

  it("mapEbEvent maps fields, composes an address, and requires name/url/start", () => {
    const ev = {
      id: 999, name: { text: "Hardware Hackathon" }, url: "https://eventbrite.com/e/999",
      start: { utc: "2026-08-01T18:00:00Z", timezone: "America/Los_Angeles" }, end: { utc: "2026-08-01T22:00:00Z" },
      summary: "Robotics & PCB", is_free: false, ticket_availability: { minimum_ticket_price: { display: "$20" } },
      primary_venue: { name: "SF Hall", address: { address_1: "1 Market St", city: "San Francisco", region: "CA" } },
      primary_organizer: { name: "Hardware Club" },
    };
    const raw = mapEbEvent(ev, cfg({ id: "eb-hubs" }))!;
    expect(raw).toMatchObject({
      sourceId: "eb-hubs", externalId: "999", title: "Hardware Hackathon", url: "https://eventbrite.com/e/999",
      startRaw: "2026-08-01T18:00:00Z", venueName: "SF Hall", city: "San Francisco", organizer: "Hardware Club",
      isFree: false, priceText: "$20",
    });
    expect(raw.address).toBe("1 Market St, San Francisco, CA");
    expect(mapEbEvent({ name: "no url", start: { utc: "x" } }, cfg())).toBeNull();
  });
});

// ── Partiful ────────────────────────────────────────────────────────────────────
describe("Partiful adapter", () => {
  it("extractNextData parses the __NEXT_DATA__ blob", () => {
    const html = `<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"feedItems":[]}}}</script></html>`;
    expect(extractNextData(html)).toEqual({ props: { pageProps: { feedItems: [] } } });
    expect(extractNextData("<html>no next data</html>")).toBeNull();
  });

  it("collectEvents dedupes events by id across feedItems and sections", () => {
    const pp = {
      feedItems: [{ event: { id: "a", title: "A" } }, { id: "b", title: "B" }],
      sections: [{ items: [{ event: { id: "a", title: "A dup" } }] }, { events: [{ id: "c", title: "C" }] }],
    };
    expect(collectEvents(pp).map((e) => e.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("mapEvent builds the url from id, applies the free heuristic + fallbackCity, requires id/title/start", () => {
    const raw = mapPartiful(
      { id: "xyz", title: "Founder Mixer", startDate: "2026-08-01T18:00:00Z", locationInfo: { name: "Secret Loft" } },
      cfg({ params: { fallbackCity: "sf-bay" } }),
    )!;
    expect(raw).toMatchObject({ sourceType: "partiful", externalId: "xyz", url: "https://partiful.com/e/xyz", venueName: "Secret Loft", isFree: true });
    expect(mapPartiful({ title: "no id", startDate: "x" }, cfg())).toBeNull();
  });
});

// ── generic-json ────────────────────────────────────────────────────────────────
describe("generic-json adapter — mapGenericItem", () => {
  const fieldMap = { title: "name", startRaw: "when.start", url: "link", city: "venue.city", externalId: "id" };
  it("maps arbitrary JSON via the fieldMap, resolving dotted paths", () => {
    const raw = mapGenericItem({ id: 7, name: "Meetup", when: { start: "2026-08-01T18:00:00Z" }, link: "https://x/7", venue: { city: "Oakland" } }, fieldMap, "custom")!;
    expect(raw).toMatchObject({ sourceId: "custom", sourceType: "generic-json", externalId: "7", title: "Meetup", startRaw: "2026-08-01T18:00:00Z", url: "https://x/7", city: "Oakland" });
  });
  it("returns null when a required field (title/startRaw/url) can't be resolved", () => {
    expect(mapGenericItem({ name: "x", link: "u" }, fieldMap, "c")).toBeNull(); // no start
    expect(mapGenericItem({ when: { start: "t" }, link: "u" }, fieldMap, "c")).toBeNull(); // no title
    expect(mapGenericItem({ name: "x", when: { start: "t" } }, fieldMap, "c")).toBeNull(); // no url
  });
  it("resolveUrlTemplate fills {{now}} / {{today}} for time-relative APIs (Cerebral Valley)", () => {
    const now = new Date("2026-07-25T12:00:00Z");
    expect(resolveUrlTemplate("https://api/e?after={{now}}", now)).toBe("https://api/e?after=2026-07-25T12:00:00.000Z");
    expect(resolveUrlTemplate("https://api/e?d={{today}}", now)).toBe("https://api/e?d=2026-07-25");
    expect(resolveUrlTemplate("https://api/e?static=1", now)).toBe("https://api/e?static=1");
  });
});
