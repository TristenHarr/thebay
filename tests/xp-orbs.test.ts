import { describe, it, expect } from "vitest";
import { orbsForCell, findOrb, epochFor, ORB_XP } from "../src/core/xp/orbs";
import { decodeBbox } from "../src/core/geohash";

describe("orbsForCell — deterministic, no-storage XP orb spawn", () => {
  it("is deterministic for the same cell + epoch (every client sees the same orbs)", () => {
    expect(orbsForCell("9q8yyk", 100)).toEqual(orbsForCell("9q8yyk", 100));
  });

  it("spawns 1-3 orbs INSIDE the cell bbox, tiered XP, stable ids", () => {
    const orbs = orbsForCell("9q8yyk", 100);
    expect(orbs.length).toBeGreaterThanOrEqual(1);
    expect(orbs.length).toBeLessThanOrEqual(3);
    const b = decodeBbox("9q8yyk");
    orbs.forEach((o, i) => {
      expect(o.lat).toBeGreaterThanOrEqual(b.minLat);
      expect(o.lat).toBeLessThanOrEqual(b.maxLat);
      expect(o.lng).toBeGreaterThanOrEqual(b.minLng);
      expect(o.lng).toBeLessThanOrEqual(b.maxLng);
      expect(ORB_XP).toContain(o.xp);
      expect(o.id).toBe(`9q8yyk:100:${i}`);
    });
  });

  it("changes across epochs", () => {
    expect(JSON.stringify(orbsForCell("9q8yyk", 100))).not.toBe(JSON.stringify(orbsForCell("9q8yyk", 101)));
  });

  it("findOrb round-trips an id back to the exact orb, and rejects junk", () => {
    const first = orbsForCell("9q8yyk", 100)[0]!;
    expect(findOrb(first.id)).toEqual(first);
    expect(findOrb("garbage")).toBeNull();
    expect(findOrb("9q8yyk:100:99")).toBeNull(); // index past the spawn count
    expect(findOrb("9q8yyk:notanumber:0")).toBeNull();
  });

  it("epochFor buckets time monotonically", () => {
    expect(epochFor(0)).toBe(0);
    expect(epochFor(Date.parse("2026-08-01T00:00:00Z"))).toBeGreaterThan(epochFor(Date.parse("2026-07-01T00:00:00Z")));
  });
});
