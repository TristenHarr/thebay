import { describe, it, expect } from "vitest";
import { xpForLevel, levelForXp, levelProgress } from "../src/core/xp/levels";

describe("xp level curve — 100·(n-1)² cumulative", () => {
  it("maps levels to their cumulative XP thresholds", () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(100);
    expect(xpForLevel(3)).toBe(400);
    expect(xpForLevel(4)).toBe(900);
    expect(xpForLevel(5)).toBe(1600);
    expect(xpForLevel(11)).toBe(10000);
  });

  it("maps an XP total back to its level (inverse of the threshold)", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(-5)).toBe(1); // never below 1
    expect(levelForXp(99)).toBe(1);
    expect(levelForXp(100)).toBe(2);
    expect(levelForXp(399)).toBe(2);
    expect(levelForXp(400)).toBe(3);
    expect(levelForXp(1599)).toBe(4);
    expect(levelForXp(1600)).toBe(5);
  });

  it("is monotonic — more XP never lowers your level", () => {
    let prev = 1;
    for (let xp = 0; xp <= 12000; xp += 37) {
      const l = levelForXp(xp);
      expect(l).toBeGreaterThanOrEqual(prev);
      expect(xpForLevel(l)).toBeLessThanOrEqual(xp); // you've crossed your level's threshold
      expect(xpForLevel(l + 1)).toBeGreaterThan(xp); // but not the next
      prev = l;
    }
  });

  it("reports progress within the current level", () => {
    const p = levelProgress(150); // level 2 (base 100, next 400)
    expect(p.level).toBe(2);
    expect(p.xp).toBe(150);
    expect(p.xpIntoLevel).toBe(50);
    expect(p.xpForNext).toBe(300);
    expect(p.toNext).toBe(250);
    expect(p.pct).toBeCloseTo(50 / 300, 5);

    const start = levelProgress(0);
    expect(start).toMatchObject({ level: 1, xpIntoLevel: 0, xpForNext: 100, toNext: 100, pct: 0 });
  });
});
