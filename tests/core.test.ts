import { describe, it, expect } from "vitest";
import { createNormalizer } from "../src/core/normalize/normalize";
import { dedupeWithinRun } from "../src/core/dedup";
import { titleSimilarity } from "../src/core/dedup/similarity";
import { localDay } from "../src/core/normalize/datetime";
import type { CityDef } from "../src/core/models/source";
import type { RawEvent } from "../src/core/models/event";

const cities: CityDef[] = [
  {
    id: "sf-bay",
    label: "SF Bay Area",
    timezone: "America/Los_Angeles",
    aliases: ["San Francisco", "SF", "Palo Alto", "Oakland"],
  },
];
const normalize = createNormalizer(cities);
const NOW = new Date("2026-07-21T00:00:00Z");

function raw(over: Partial<RawEvent>): RawEvent {
  return {
    sourceId: "s1",
    sourceType: "test",
    title: "Rust Meetup",
    startRaw: "2026-08-20T18:30:00",
    url: "https://example.com/e/1",
    city: "San Francisco",
    ...over,
  };
}

describe("normalize", () => {
  it("resolves city from a location string and converts to UTC", () => {
    const e = normalize(raw({ address: "123 Main St, Palo Alto, CA" }), NOW)!;
    expect(e.city).toBe("sf-bay");
    expect(e.timezone).toBe("America/Los_Angeles");
    // 18:30 PDT (UTC-7) => 01:30 UTC next day
    expect(e.startUtc).toBe("2026-08-21T01:30:00Z");
  });

  it("keeps unknown-city events (wide net)", () => {
    const e = normalize(raw({ city: "Reykjavik", address: "Iceland" }), NOW)!;
    expect(e.city).toBe("unknown");
  });

  it("drops events without a title or url", () => {
    expect(normalize(raw({ title: "" }), NOW)).toBeNull();
  });
});

describe("dedup", () => {
  it("collapses the same event from two sources by fingerprint", () => {
    const a = normalize(raw({ sourceId: "luma" }), NOW)!;
    const b = normalize(
      raw({ sourceId: "eventbrite", url: "https://eventbrite.com/x" }),
      NOW,
    )!;
    const merged = dedupeWithinRun([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sources).toHaveLength(2);
  });

  it("treats a different day as a distinct event", () => {
    const a = normalize(raw({}), NOW)!;
    const b = normalize(raw({ startRaw: "2026-08-27T18:30:00" }), NOW)!;
    expect(dedupeWithinRun([a, b])).toHaveLength(2);
  });

  it("fuzzy-matches near-identical titles at the same venue/day", () => {
    const a = normalize(raw({ title: "Rust & WASM Meetup", venueName: "GitHub HQ" }), NOW)!;
    const b = normalize(
      raw({
        title: "Rust and WASM Meetup!",
        venueName: "GitHub HQ",
        sourceId: "s2",
        url: "https://x.com/2",
      }),
      NOW,
    )!;
    expect(dedupeWithinRun([a, b])).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("titleSimilarity is high for reworded titles", () => {
    expect(titleSimilarity("Rust & WASM Meetup", "Rust and WASM Meetup")).toBeGreaterThan(0.85);
  });
  it("localDay respects timezone", () => {
    // 01:30 UTC is still the 20th in Los Angeles
    expect(localDay("2026-08-21T01:30:00Z", "America/Los_Angeles")).toBe("2026-08-20");
  });
});
