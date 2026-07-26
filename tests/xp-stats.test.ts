import { describe, it, expect } from "vitest";
import { founderStats, type FounderSnapshot } from "../src/core/xp/stats";

const EMPTY: FounderSnapshot = {
  technical: false, interests: [], mentorTopics: [], friends: 0, introsMade: 0,
  points: 0, level: 1, streakBest: 0, reviewAvg: null, reviewCount: 0, shadows: 0, checkins: 0,
};
const snap = (o: Partial<FounderSnapshot>): FounderSnapshot => ({ ...EMPTY, ...o });
const inRange = (s: Record<string, unknown>) => {
  for (const k of ["capital", "technical", "network", "momentum", "reach", "power"] as const) {
    expect(s[k], k).toBeGreaterThanOrEqual(0);
    expect(s[k], k).toBeLessThanOrEqual(100);
  }
};

describe("founderStats — derived RPG stats + rarity", () => {
  it("a blank profile is low across the board and common", () => {
    const s = founderStats(EMPTY);
    inRange(s as any);
    expect(s.power).toBeLessThan(20);
    expect(s.rarity).toBe("common");
  });

  it("a technical builder scores high on technical", () => {
    const s = founderStats(snap({ technical: true, interests: ["ai", "infra", "rust"] }));
    expect(s.technical).toBeGreaterThan(60);
    expect(s.technical).toBeGreaterThan(s.capital);
  });

  it("an investor scores high on capital", () => {
    const s = founderStats(snap({ interests: ["vc", "angel", "seed fund"], points: 700 }));
    expect(s.capital).toBeGreaterThan(50);
    expect(s.capital).toBeGreaterThan(s.technical);
  });

  it("a super-connector scores high on network", () => {
    const s = founderStats(snap({ friends: 60, introsMade: 12 }));
    expect(s.network).toBeGreaterThan(70);
  });

  it("word-boundary matching — 'ai' in 'email' does not count as technical", () => {
    const s = founderStats(snap({ interests: ["email marketing", "retail"] }));
    expect(s.technical).toBe(0);
  });

  it("a maxed founder is legendary, everything bounded 0..100", () => {
    const s = founderStats(snap({
      technical: true, interests: ["ai", "ml", "infra", "vc", "invest", "capital"], mentorTopics: ["systems", "fundraising"],
      friends: 500, introsMade: 80, points: 5000, level: 30, streakBest: 40, reviewAvg: 5, reviewCount: 40, shadows: 200, checkins: 200,
    }));
    inRange(s as any);
    expect(s.power).toBeGreaterThan(80);
    expect(s.power).toBeLessThanOrEqual(100);
    expect(s.rarity).toBe("legendary");
  });

  it("is deterministic", () => {
    const a = founderStats(snap({ friends: 10, interests: ["ai"] }));
    const b = founderStats(snap({ friends: 10, interests: ["ai"] }));
    expect(a).toEqual(b);
  });

  it("rarity climbs with power", () => {
    const order = ["common", "uncommon", "rare", "epic", "legendary"];
    const weak = founderStats(snap({ friends: 2 }));
    const mid = founderStats(snap({ friends: 25, introsMade: 5, technical: true, interests: ["ai"], level: 8 }));
    expect(order.indexOf(mid.rarity)).toBeGreaterThanOrEqual(order.indexOf(weak.rarity));
  });
});
