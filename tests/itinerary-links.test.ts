import { describe, it, expect } from "vitest";
import { locationQuery, mapLink, directionsLink, rideshareLinks, foodNearbyLink, eventLinks, BAY_TRANSIT } from "../web/src/features/itinerary/links";

const shack15 = { title: "Founder Dinner", venueName: "Shack15", address: "2 Marina Blvd", city: "San Francisco", latitude: 37.8065, longitude: -122.4324, url: "https://lu.ma/x", organizer: "Chris" };
const noCoords = { title: "Mystery Meetup", venueName: "Somewhere", city: "Oakland" };

describe("itinerary link builders", () => {
  it("builds a human location query, preferring venue+address+city", () => {
    expect(locationQuery(shack15)).toBe("Shack15, 2 Marina Blvd, San Francisco");
    expect(locationQuery({ title: "x", latitude: 37.7, longitude: -122.4 })).toBe("37.7,-122.4");
  });

  it("directions use coords + travel mode; transit is the default", () => {
    const d = directionsLink(shack15, "transit");
    expect(d).toContain("destination=37.8065%2C-122.4324");
    expect(d).toContain("travelmode=transit");
    expect(directionsLink(shack15, "driving")).toContain("travelmode=driving");
  });

  it("rideshare deep-links carry the dropoff coords (or fall back gracefully)", () => {
    const r = rideshareLinks(shack15);
    expect(r.uber).toContain("dropoff[latitude]=37.8065");
    expect(r.lyft).toContain("destination[latitude]=37.8065");
    expect(rideshareLinks(noCoords).uber).toBe("https://m.uber.com/");
  });

  it("map + food links are properly URL-encoded", () => {
    expect(mapLink(shack15)).toContain("query=Shack15%2C%202%20Marina%20Blvd%2C%20San%20Francisco");
    expect(foodNearbyLink(shack15)).toContain("restaurants%20near%20Shack15");
  });

  it("eventLinks yields destination/transport/eat/event sections, including the event page when a url exists", () => {
    const links = eventLinks(shack15);
    const sections = new Set(links.map((l) => l.section));
    expect(sections.has("Destination")).toBe(true);
    expect(sections.has("Transport")).toBe(true);
    expect(sections.has("Eat & do")).toBe(true);
    expect(links.some((l) => l.section === "Event" && l.url === "https://lu.ma/x")).toBe(true);
    // no url → no Event link
    expect(eventLinks(noCoords).some((l) => l.section === "Event")).toBe(false);
  });

  it("ships the Bay transit hub links", () => {
    expect(BAY_TRANSIT.map((t) => t.name)).toEqual(expect.arrayContaining(["BART", "Caltrain", "Muni", "511 Bay Area"]));
    expect(BAY_TRANSIT.every((t) => t.url.startsWith("https://"))).toBe(true);
  });
});
