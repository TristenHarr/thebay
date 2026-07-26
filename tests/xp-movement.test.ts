import { describe, it, expect } from "vitest";
import { segmentXp, DAILY_MOVEMENT_XP_CAP, IMPLAUSIBLE_MPS } from "../src/core/xp/movement";

describe("segmentXp — distance→XP with anti-teleport caps + speed flags", () => {
  it("awards XP for a plausible walk (25m = 1 XP)", () => {
    const r = segmentXp(100, 60_000); // 100m over 60s ≈ 1.7 m/s
    expect(r.xp).toBe(4);
    expect(r.flagged).toBe(false);
    expect(r.mps).toBeCloseTo(1.7, 1);
  });

  it("gives nothing for no movement (or negative)", () => {
    expect(segmentXp(0, 10_000).xp).toBe(0);
    expect(segmentXp(-50, 10_000).xp).toBe(0);
  });

  it("flags implausible speed but still grants (semi-cheatable by design)", () => {
    const r = segmentXp(1000, 30_000); // 1000m over 30s ≈ 33 m/s (driving / spoof)
    expect(r.mps).toBeGreaterThan(IMPLAUSIBLE_MPS);
    expect(r.flagged).toBe(true);
    expect(r.xp).toBeGreaterThan(0); // still earns — but the tracker sees the flag
  });

  it("caps a single teleport segment so you can't farm one giant jump", () => {
    const r = segmentXp(50_000, 3_600_000); // 50km over an hour — a GPS jump
    expect(r.counted).toBeLessThanOrEqual(1500);
    expect(r.flagged).toBe(true); // distance beyond the per-segment cap → flagged
    expect(r.xp).toBeLessThanOrEqual(Math.floor(1500 / 25));
  });

  it("exposes a sane daily cap", () => {
    expect(DAILY_MOVEMENT_XP_CAP).toBeGreaterThan(0);
    expect(DAILY_MOVEMENT_XP_CAP).toBeLessThanOrEqual(2000);
  });
});
