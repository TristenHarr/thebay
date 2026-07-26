import { describe, it, expect } from "vitest";
import { encode, decodeBbox, neighbors, cellsInBbox } from "../src/core/geohash";

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const SF = { lat: 37.7749, lng: -122.4194 };

describe("geohash.encode", () => {
  it("matches the canonical reference vector", () => {
    // The well-known Wikipedia example.
    expect(encode(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
  });

  it("produces a base32 string of the requested precision", () => {
    const h = encode(SF.lat, SF.lng, 6);
    expect(h).toHaveLength(6);
    expect([...h].every((c) => BASE32.includes(c))).toBe(true);
    expect(encode(SF.lat, SF.lng, 6)).toBe(encode(SF.lat, SF.lng, 6)); // deterministic
  });

  it("is prefix-consistent: a coarser cell is the prefix of a finer one at the same point", () => {
    expect(encode(SF.lat, SF.lng, 4)).toBe(encode(SF.lat, SF.lng, 6).slice(0, 4));
    // SF sits in the '9q' quadrant
    expect(encode(SF.lat, SF.lng, 6).startsWith("9q")).toBe(true);
  });
});

describe("geohash.decodeBbox", () => {
  it("returns a box that contains the point it was encoded from", () => {
    const b = decodeBbox(encode(SF.lat, SF.lng, 6));
    expect(SF.lat).toBeGreaterThanOrEqual(b.minLat);
    expect(SF.lat).toBeLessThanOrEqual(b.maxLat);
    expect(SF.lng).toBeGreaterThanOrEqual(b.minLng);
    expect(SF.lng).toBeLessThanOrEqual(b.maxLng);
    // precision-6 cell is ~1.2km × 0.6km — sanity on size
    expect(b.maxLat - b.minLat).toBeLessThan(0.02);
    expect(b.maxLng - b.minLng).toBeLessThan(0.02);
  });
});

describe("geohash.neighbors", () => {
  it("returns up to 8 distinct same-length cells, excluding the center", () => {
    const cell = encode(SF.lat, SF.lng, 6);
    const ns = neighbors(cell);
    expect(ns.length).toBeGreaterThanOrEqual(8);
    expect(ns.length).toBeLessThanOrEqual(8);
    expect(new Set(ns).size).toBe(ns.length); // distinct
    expect(ns).not.toContain(cell); // center excluded
    expect(ns.every((n) => n.length === cell.length)).toBe(true);
  });
});

describe("geohash.cellsInBbox", () => {
  it("covers the box: the cell of an interior point is included", () => {
    const bbox = { minLat: 37.75, minLng: -122.45, maxLat: 37.80, maxLng: -122.40 };
    const cells = cellsInBbox(bbox, 6);
    expect(cells).toContain(encode(37.775, -122.42, 6)); // interior point
    expect(cells.length).toBeGreaterThan(0);
    expect(new Set(cells).size).toBe(cells.length); // distinct
  });

  it("returns more cells for a bigger box, and stays bounded for a tiny one", () => {
    const tiny = cellsInBbox({ minLat: 37.7749, minLng: -122.4194, maxLat: 37.7752, maxLng: -122.4191 }, 6);
    const big = cellsInBbox({ minLat: 37.6, minLng: -122.5, maxLat: 37.9, maxLng: -122.2 }, 6);
    expect(tiny.length).toBeGreaterThanOrEqual(1);
    expect(tiny.length).toBeLessThanOrEqual(6);
    expect(big.length).toBeGreaterThan(tiny.length);
  });
});
