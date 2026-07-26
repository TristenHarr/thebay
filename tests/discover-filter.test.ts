import { describe, it, expect } from "vitest";
import { inDateWindow, timeOfDay, baseFilter, categoryCounts, applyCategoryAndSort, communityCounts, COMMUNITY_LABELS } from "../web/src/features/discover/filter";

// Fixed clock: Wed 2026-06-10T20:00:00Z.
const NOW = Date.parse("2026-06-10T20:00:00Z");
const iso = (s: string) => new Date(s).toISOString();

describe("inDateWindow", () => {
  it("'today' includes events later today, excludes tomorrow and the far past", () => {
    expect(inDateWindow(iso("2026-06-10T23:00:00Z"), "today", null, NOW)).toBe(true);
    expect(inDateWindow(iso("2026-06-11T10:00:00Z"), "today", null, NOW)).toBe(false);
    expect(inDateWindow(iso("2026-06-09T10:00:00Z"), "today", null, NOW)).toBe(false); // yesterday
  });

  it("hides events that ended more than 6h ago, keeps just-passed ones", () => {
    expect(inDateWindow(iso("2026-06-10T13:00:00Z"), "upcoming", null, NOW)).toBe(false); // 7h ago
    expect(inDateWindow(iso("2026-06-10T16:00:00Z"), "upcoming", null, NOW)).toBe(true); // 4h ago
  });

  it("'7d' and '30d' bound the far end", () => {
    expect(inDateWindow(iso("2026-06-16T20:00:00Z"), "7d", null, NOW)).toBe(true);
    expect(inDateWindow(iso("2026-06-20T20:00:00Z"), "7d", null, NOW)).toBe(false);
    expect(inDateWindow(iso("2026-06-20T20:00:00Z"), "30d", null, NOW)).toBe(true);
  });

  it("'weekend' only matches Fri/Sat/Sun within ~9 days", () => {
    expect(inDateWindow(iso("2026-06-13T18:00:00Z"), "weekend", null, NOW)).toBe(true); // Sat
    expect(inDateWindow(iso("2026-06-11T18:00:00Z"), "weekend", null, NOW)).toBe(false); // Thu
  });

  it("'all' keeps even long-past events; a trip range overrides the window", () => {
    expect(inDateWindow(iso("2020-01-01T00:00:00Z"), "all", null, NOW)).toBe(true);
    const trip = { from: "2026-07-01", to: "2026-07-03" };
    expect(inDateWindow(iso("2026-07-02T18:00:00Z"), "today", trip, NOW)).toBe(true); // trip wins over 'today'
    expect(inDateWindow(iso("2026-07-05T18:00:00Z"), "today", trip, NOW)).toBe(false); // outside trip
  });
});

describe("timeOfDay", () => {
  it("buckets by the event's local hour, not UTC", () => {
    // 2026-06-10T20:00Z = 13:00 PDT → afternoon
    expect(timeOfDay(iso("2026-06-10T20:00:00Z"), "America/Los_Angeles")).toBe("afternoon");
    // 03:00Z = 20:00 previous day PDT → evening
    expect(timeOfDay(iso("2026-06-11T03:00:00Z"), "America/Los_Angeles")).toBe("evening");
    // 16:00Z = 09:00 PDT → morning
    expect(timeOfDay(iso("2026-06-10T16:00:00Z"), "America/Los_Angeles")).toBe("morning");
  });
  it("degrades to 'any' on a bad timezone", () => {
    expect(timeOfDay(iso("2026-06-10T20:00:00Z"), "Not/AZone")).toBe("any");
  });
});

describe("baseFilter + facets + sort", () => {
  const events = [
    { id: "a", title: "AI Infra Dinner", startUtc: iso("2026-06-12T02:00:00Z"), timezone: "America/Los_Angeles", isFree: true, categories: ["ai", "infra"], interestScore: 9, organizer: "Acme" },
    { id: "b", title: "Founder Brunch", startUtc: iso("2026-06-13T18:00:00Z"), timezone: "America/Los_Angeles", isFree: false, categories: ["ai"], interestScore: 5 },
    { id: "c", title: "Old Meetup", startUtc: iso("2026-01-01T18:00:00Z"), timezone: "America/Los_Angeles", isFree: true, categories: ["infra"], interestScore: 7 },
  ];

  it("applies date + free + text facets together", () => {
    expect(baseFilter(events, { date: "30d", time: "any", q: "", free: false, trip: null }, NOW).map((e) => e.id)).toEqual(["a", "b"]);
    expect(baseFilter(events, { date: "30d", time: "any", q: "", free: true, trip: null }, NOW).map((e) => e.id)).toEqual(["a"]);
    expect(baseFilter(events, { date: "30d", time: "any", q: "brunch", free: false, trip: null }, NOW).map((e) => e.id)).toEqual(["b"]);
    expect(baseFilter(events, { date: "all", time: "any", q: "", free: true, trip: null }, NOW).map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("category counts reflect the base list and sort/filter behave", () => {
    const base = baseFilter(events, { date: "30d", time: "any", q: "", free: false, trip: null }, NOW);
    expect(categoryCounts(base)).toEqual([["ai", 2], ["infra", 1]]);
    // sort by interest: a(9) before b(5)
    expect(applyCategoryAndSort(base, new Set(), "interesting").map((e) => e.id)).toEqual(["a", "b"]);
    // filter to infra only
    expect(applyCategoryAndSort(base, new Set(["infra"]), "soonest").map((e) => e.id)).toEqual(["a"]);
  });
});

describe("communities (browse by source)", () => {
  const ev = (id: string, sourceIds: string[], extra: any = {}) => ({
    id, title: id, startUtc: "2026-08-01T18:00:00Z", categories: ["tech"], interestScore: 50,
    sources: sourceIds.map((sourceId) => ({ sourceId })), ...extra,
  });
  const events = [
    ev("a", ["luma-bay-categories", "luma-yc"]),      // YC (also found by discover)
    ev("b", ["cerebral-valley"]),                       // Cerebral Valley
    ev("c", ["cerebral-valley", "luma-frontiertower"]), // both CV + Frontier Tower
    ev("d", ["eb-hubs"]),                               // a broad sweep — not a community
  ];

  it("counts events per curated community (once each), ignoring broad sweeps", () => {
    const counts = Object.fromEntries(communityCounts(events));
    expect(counts["cerebral-valley"]).toBe(2);
    expect(counts["luma-yc"]).toBe(1);
    expect(counts["luma-frontiertower"]).toBe(1);
    expect(counts["eb-hubs"]).toBeUndefined();          // broad sweeps aren't communities
    expect(counts["luma-bay-categories"]).toBeUndefined();
  });

  it("has friendly labels for the curated communities", () => {
    expect(COMMUNITY_LABELS["luma-yc"]).toBe("Y Combinator");
    expect(COMMUNITY_LABELS["cerebral-valley"]).toBe("Cerebral Valley");
  });

  it("filters the list to selected communities (OR), leaving other facets intact", () => {
    const cv = applyCategoryAndSort(events, new Set(), "soonest", new Set(["cerebral-valley"]));
    expect(cv.map((e) => e.id).sort()).toEqual(["b", "c"]);
    const cvOrYc = applyCategoryAndSort(events, new Set(), "soonest", new Set(["cerebral-valley", "luma-yc"]));
    expect(cvOrYc.map((e) => e.id).sort()).toEqual(["a", "b", "c"]);
    // no community selected → unchanged
    expect(applyCategoryAndSort(events, new Set(), "soonest").length).toBe(4);
  });
});
