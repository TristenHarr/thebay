import { describe, it, expect } from "vitest";
import { createNormalizer } from "../src/core/normalize/normalize";
import { dedupeWithinRun } from "../src/core/dedup";
import { loadCities } from "../src/config/load";

const normalize = createNormalizer(loadCities());
const NOW = new Date("2026-07-25T00:00:00Z");
const base = { sourceId: "s", sourceType: "test", externalId: "e", url: "https://x/e", startRaw: "2026-08-01T18:00:00Z" };
const ev = (over: Record<string, unknown>) => normalize({ ...base, title: "Test", ...over } as any, NOW);

describe("event info quality — clean titles, real dates, no junk stored", () => {
  it("cleans titles: strips HTML and collapses whitespace", () => {
    expect(ev({ title: "  <b>AI</b>   Founders\n Summit " })?.title).toBe("AI Founders Summit");
    expect(ev({ title: "Robotics &amp; Hardware" })?.title).toBe("Robotics & Hardware");
  });

  it("rejects events missing the essentials (never stores a blank)", () => {
    expect(ev({ title: "" })).toBeNull();
    expect(ev({ title: "   " })).toBeNull();
    expect(ev({ title: "X", url: "" })).toBeNull();
    expect(ev({ title: "X", startRaw: "definitely not a date" })).toBeNull();
  });

  it("parses dates to correct UTC, honoring the resolved city's timezone", () => {
    // 10:00 with no zone, at an SF (America/Los_Angeles, PDT = UTC-7 in August) venue → 17:00Z
    const e = ev({ title: "Morning Talk", startRaw: "2026-08-01T10:00:00", address: "1 Market St, San Francisco, CA 94105" });
    expect(e?.city).toBe("sf-bay");
    expect(e?.startUtc).toBe("2026-08-01T17:00:00Z");
    // an explicit offset is respected as-is
    expect(ev({ startRaw: "2026-08-01T12:00:00-04:00" })?.startUtc).toBe("2026-08-01T16:00:00Z");
  });

  it("always produces the fields the store + dedup rely on", () => {
    const e = ev({ title: "Complete Event" })!;
    expect(e.startUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(e.timezone).toBeTruthy();
    expect(e.city).toBeTruthy();
    expect(e.fingerprint).toBeTruthy();
    expect(e.contentHash).toBeTruthy();
    expect(Array.isArray(e.categories)).toBe(true);
    expect(e.url).toBe("https://x/e");
  });

  it("dedupes the same event seen twice in a run (same title+day+city), unioning sources", () => {
    const a = normalize({ ...base, title: "Founder Dinner", sourceId: "luma", externalId: "l1", url: "https://luma/e", address: "San Jose, CA" } as any, NOW)!;
    const b = normalize({ ...base, title: "founder   dinner", sourceId: "eventbrite", externalId: "e1", url: "https://eb/e", address: "San Jose, CA" } as any, NOW)!;
    expect(a.fingerprint).toBe(b.fingerprint); // title normalization + same day + same city
    const merged = dedupeWithinRun([a, b]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.sources.length).toBe(2); // both sources preserved
  });

  it("keeps distinct events distinct (different day or title → different fingerprint)", () => {
    const day1 = ev({ title: "AI Meetup", startRaw: "2026-08-01T18:00:00Z", address: "SF, CA" })!;
    const day2 = ev({ title: "AI Meetup", startRaw: "2026-08-08T18:00:00Z", address: "SF, CA" })!;
    const other = ev({ title: "Different Meetup", startRaw: "2026-08-01T18:00:00Z", address: "SF, CA" })!;
    expect(new Set([day1.fingerprint, day2.fingerprint, other.fingerprint]).size).toBe(3);
    expect(dedupeWithinRun([day1, day2, other]).length).toBe(3);
  });
});
