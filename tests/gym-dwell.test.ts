/**
 * Dwell time is the cap. This is the file that decides what "you were there" is worth.
 *
 * The rule the product wants: a host may reward you more for staying the evening than
 * for putting your face past the door. So the per-recipient ceiling is multiplied by
 * how long your VERIFIED presence lasted, and the only way to extend that is to still
 * be inside the geofence when the door code rotates.
 */
import { describe, it, expect } from "vitest";
import {
  DWELL_FLOOR_MIN,
  DWELL_FULL_MIN,
  DWELL_FLOOR_SHARE,
  dwellMultiplier,
  dwellMinutes,
  creditedMinutes,
} from "../src/core/gym/dwell";

describe("dwellMultiplier", () => {
  it("pays nothing for a drive-by", () => {
    expect(dwellMultiplier(0)).toBe(0);
    expect(dwellMultiplier(DWELL_FLOOR_MIN - 0.01)).toBe(0);
  });

  it("pays the floor share the moment you clear the floor, not zero", () => {
    // A cliff at both ends would mean someone who stayed exactly the minimum gets
    // nothing, which reads as broken rather than as a rule.
    expect(dwellMultiplier(DWELL_FLOOR_MIN)).toBeCloseTo(DWELL_FLOOR_SHARE, 6);
  });

  it("reaches exactly 1.0 at the full-credit mark and never exceeds it", () => {
    expect(dwellMultiplier(DWELL_FULL_MIN)).toBe(1);
    expect(dwellMultiplier(DWELL_FULL_MIN * 10)).toBe(1);
  });

  it("ramps monotonically between the floor and full credit", () => {
    let prev = -1;
    for (let m = 0; m <= DWELL_FULL_MIN + 10; m += 0.5) {
      const v = dwellMultiplier(m);
      expect(v, `at ${m} min`).toBeGreaterThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  it("is total — NaN, negatives and Infinity never throw and never exceed the range", () => {
    expect(dwellMultiplier(NaN)).toBe(0);
    expect(dwellMultiplier(-50)).toBe(0);
    expect(dwellMultiplier(Infinity)).toBe(1);
  });
});

describe("dwellMinutes", () => {
  it("measures the span between the first and last verified scan", () => {
    expect(dwellMinutes("2026-07-01T19:00:00Z", "2026-07-01T20:30:00Z")).toBe(90);
  });

  it("is 0 for a single scan, and never negative if the clocks disagree", () => {
    expect(dwellMinutes("2026-07-01T19:00:00Z", "2026-07-01T19:00:00Z")).toBe(0);
    expect(dwellMinutes("2026-07-01T20:00:00Z", "2026-07-01T19:00:00Z")).toBe(0);
  });

  it("is total — unparseable timestamps yield 0 rather than NaN", () => {
    expect(dwellMinutes("nonsense", "2026-07-01T19:00:00Z")).toBe(0);
    expect(dwellMinutes("2026-07-01T19:00:00Z", "")).toBe(0);
  });
});

describe("creditedMinutes", () => {
  it("credits a single scan at the floor so an honest attendee is never zeroed", () => {
    // You cannot get a presence row without a live geofenced scan inside the event
    // window, so simply having one is worth the floor tier. What it is NOT worth is
    // the full cap — that still takes staying.
    expect(creditedMinutes("2026-07-01T19:00:00Z", "2026-07-01T19:00:00Z")).toBe(DWELL_FLOOR_MIN);
    expect(dwellMultiplier(creditedMinutes("2026-07-01T19:00:00Z", "2026-07-01T19:00:00Z"))).toBeCloseTo(DWELL_FLOOR_SHARE, 6);
  });

  it("uses the real span once it beats the floor", () => {
    expect(creditedMinutes("2026-07-01T19:00:00Z", "2026-07-01T21:00:00Z")).toBe(120);
  });

  it("caps credit at the event's own length so a forgotten open tab cannot farm it", () => {
    // Someone whose last scan lands hours after the event ended must not be credited
    // for the gap. The window is the ceiling.
    const ev = { startUtc: "2026-07-01T18:00:00Z", endUtc: "2026-07-01T20:00:00Z" };
    expect(creditedMinutes("2026-07-01T18:30:00Z", "2026-07-02T04:00:00Z", ev)).toBe(120);
  });
});
