import { describe, it, expect } from "vitest";
import { serverRange, DAY, baseFilter, applyCategoryAndSort } from "../web/src/features/discover/filter";
import { windowRange } from "../src/core/search/window";

/**
 * The bridge between Discover's date chips and the server's window vocabulary.
 * Both sides must mean the same thing by "this weekend", or the online and offline
 * paths of the same screen disagree with each other.
 */
describe("serverRange — one date chip, two implementations that must agree", () => {
  it("maps the chips the server has a window for straight through", () => {
    expect(serverRange("today", null)).toEqual({ window: "today" });
    expect(serverRange("weekend", null)).toEqual({ window: "weekend" });
    expect(serverRange("7d", null)).toEqual({ window: "7d" });
    expect(serverRange("30d", null)).toEqual({ window: "30d" });
  });

  it("'upcoming' sends no window at all — the server default is already 'upcoming'", () => {
    expect(serverRange("upcoming", null)).toEqual({});
    expect(windowRange(undefined).to).toBeUndefined();
  });

  it("'all' opens the lower bound, because it is the one chip that includes the past", () => {
    const r = serverRange("all", null);
    expect(r.window).toBeUndefined();
    expect(Date.parse(r.from!)).toBe(0);
  });

  it("a trip is a literal range and overrides the chip, with the departure day included", () => {
    const r = serverRange("today", { from: "2026-08-01", to: "2026-08-03" });
    expect(r.window).toBeUndefined();
    expect(r.from).toBe("2026-08-01T00:00:00.000Z");
    // inclusive of the whole departure day — the same +1 day the client filter uses
    expect(Date.parse(r.to!)).toBe(Date.parse("2026-08-03T00:00:00.000Z") + DAY);
  });

  it("an incomplete trip falls back to the chip rather than sending a broken range", () => {
    expect(serverRange("7d", { from: "2026-08-01", to: "" })).toEqual({ window: "7d" });
    expect(serverRange("7d", null)).toEqual({ window: "7d" });
  });

  it("every window it emits is one the server actually implements", () => {
    for (const key of ["today", "weekend", "7d", "30d"] as const) {
      const w = serverRange(key, null).window!;
      const range = windowRange(w, Date.parse("2026-07-24T20:00:00Z"));
      expect(range.from).toBeTruthy();
      expect(range.to).toBeTruthy();
    }
  });
});

/**
 * The offline path is still the old client-side filter. It must keep working on the
 * shape `/api/events` returns, including tag ids mapped down to legacy slugs — that
 * mapping is the one thing the rewrite added to it.
 */
describe("offline path — legacy category slugs still filter a cached list", () => {
  const NOW = Date.parse("2026-06-10T20:00:00Z");
  const events = [
    { id: "a", title: "Hardware Hackathon", startUtc: "2026-06-12T02:00:00Z", timezone: "America/Los_Angeles", isFree: true, categories: ["hardware"], interestScore: 90, sources: [{ sourceId: "luma-yc" }] },
    { id: "b", title: "Rust Workshop", startUtc: "2026-06-13T18:00:00Z", timezone: "America/Los_Angeles", isFree: true, categories: ["software"], interestScore: 40, sources: [{ sourceId: "eb-hubs" }] },
  ];

  it("a selected `topic:hardware` chip maps to the cached `hardware` slug", () => {
    const base = baseFilter(events, { date: "30d", time: "any", q: "", free: false, trip: null }, NOW);
    const slugs = new Set(["topic:hardware"].map((t) => t.split(":").pop()!));
    expect(applyCategoryAndSort(base, slugs, "soonest").map((e) => e.id)).toEqual(["a"]);
  });

  it("no selection leaves the cached list intact", () => {
    const base = baseFilter(events, { date: "30d", time: "any", q: "", free: false, trip: null }, NOW);
    expect(applyCategoryAndSort(base, new Set(), "soonest").map((e) => e.id)).toEqual(["a", "b"]);
  });
});
