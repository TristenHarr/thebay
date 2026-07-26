import { describe, it, expect } from "vitest";
import { decayFactor, trustScore, freshness, HALF_LIFE } from "../src/core/places/trust";

/**
 * Trust decay is the whole reason a crowd map stays true: a confirmation is a
 * statement about a moment, not a fact forever. Parking legality rots in hours;
 * a café's free wifi is still there in three months. Hence a per-kind half-life
 * and one pure function everything (ranking, the map, the API) agrees on.
 */

const T0 = "2026-07-26T12:00:00.000Z";
const hoursAfter = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * 3600_000).toISOString();

const place = (over: Partial<Parameters<typeof trustScore>[0]> = {}) => ({
  confirms: 1,
  disputes: 0,
  createdAt: T0,
  lastConfirmedAt: null as string | null,
  halfLifeHours: 24,
  ...over,
});

describe("decayFactor", () => {
  it("is exactly 1 at age 0 and never NaN", () => {
    expect(decayFactor(0, 24)).toBe(1);
    expect(Number.isNaN(decayFactor(0, 0))).toBe(false);
    expect(Number.isNaN(decayFactor(NaN, 24))).toBe(false);
    expect(Number.isNaN(decayFactor(10, NaN))).toBe(false);
  });

  it("decays monotonically with age and never goes negative", () => {
    let prev = decayFactor(0, 24);
    for (const age of [1, 6, 12, 24, 48, 240, 10_000]) {
      const f = decayFactor(age, 24);
      expect(f).toBeLessThan(prev);
      expect(f).toBeGreaterThanOrEqual(0);
      prev = f;
    }
  });

  it("decays slower for a longer half-life — parking rots, free wifi doesn't", () => {
    const ageH = 72;
    expect(decayFactor(ageH, HALF_LIFE.parking)).toBeLessThan(decayFactor(ageH, HALF_LIFE.default));
    expect(decayFactor(ageH, HALF_LIFE.default)).toBeLessThan(1);
  });

  it("clamps a negative (future-dated) age to 0 rather than amplifying", () => {
    expect(decayFactor(-100, 24)).toBe(1);
  });
});

describe("trustScore", () => {
  it("is confirms − 1.5·disputes at age zero", () => {
    expect(trustScore(place({ confirms: 4, disputes: 0 }), T0)).toBeCloseTo(4, 10);
    expect(trustScore(place({ confirms: 4, disputes: 2 }), T0)).toBeCloseTo(1, 10);
  });

  it("weighs a dispute heavier than a confirm — two disputes beat one confirm", () => {
    expect(trustScore(place({ confirms: 1, disputes: 1 }), T0)).toBeLessThan(0);
    expect(trustScore(place({ confirms: 2, disputes: 1 }), T0)).toBeGreaterThan(0);
    expect(trustScore(place({ confirms: 3, disputes: 2 }), T0)).toBeCloseTo(0, 10);
  });

  it("decays toward zero as the last confirmation ages", () => {
    const p = place({ confirms: 5, halfLifeHours: 12 });
    const now = trustScore(p, T0);
    const later = trustScore(p, hoursAfter(T0, 12));
    const muchLater = trustScore(p, hoursAfter(T0, 120));
    expect(later).toBeLessThan(now);
    expect(muchLater).toBeLessThan(later);
    expect(muchLater).toBeGreaterThan(0);
  });

  it("a fresh confirmation resets the clock (lastConfirmedAt wins over createdAt)", () => {
    const stale = place({ confirms: 3, createdAt: T0, halfLifeHours: 6 });
    const refreshed = place({ confirms: 3, createdAt: T0, lastConfirmedAt: hoursAfter(T0, 47), halfLifeHours: 6 });
    const at = hoursAfter(T0, 48);
    expect(trustScore(refreshed, at)).toBeGreaterThan(trustScore(stale, at));
  });

  it("a disputed place stays negative however long it sits (decay shrinks, never flips sign)", () => {
    const p = place({ confirms: 0, disputes: 3, halfLifeHours: 24 });
    for (const h of [0, 24, 500]) expect(trustScore(p, hoursAfter(T0, h))).toBeLessThan(0);
  });

  it("never returns NaN, whatever garbage it is handed", () => {
    const junk = [
      place({ createdAt: "not-a-date" }),
      place({ lastConfirmedAt: "nope" }),
      place({ halfLifeHours: 0 }),
      place({ halfLifeHours: -5 }),
      place({ confirms: NaN as unknown as number }),
      place({ disputes: undefined as unknown as number }),
    ];
    for (const p of junk) expect(Number.isFinite(trustScore(p, T0))).toBe(true);
  });
});

describe("freshness", () => {
  it("labels a place by how recently the crowd vouched for it", () => {
    const p = place({ confirms: 2, halfLifeHours: 24 });
    expect(freshness(p, T0)).toBe("fresh");
    expect(freshness(p, hoursAfter(T0, 30))).toBe("aging");
    expect(freshness(p, hoursAfter(T0, 400))).toBe("stale");
  });

  it("calls a net-disputed place disputed regardless of age", () => {
    expect(freshness(place({ confirms: 0, disputes: 1 }), T0)).toBe("disputed");
  });
});
