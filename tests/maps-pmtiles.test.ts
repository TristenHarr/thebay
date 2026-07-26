import { describe, it, expect } from "vitest";
import {
  PMTILES_HEADER_BYTES, findPmtilesEntry, parsePmtilesDirectory, parsePmtilesHeader,
  resolveTile, zxyToTileId, type DirEntry, type PmtilesHeader,
} from "../src/core/maps/pmtiles";
import { BAY_BOUNDS } from "../src/core/geo";

/* ── build a valid v3 header so the parser is tested against real bytes ───────*/
function makeHeader(over: Partial<Record<string, number>> = {}): ArrayBuffer {
  const buf = new ArrayBuffer(PMTILES_HEADER_BYTES);
  const v = new DataView(buf);
  for (let i = 0; i < 7; i++) v.setUint8(i, "PMTiles".charCodeAt(i));
  v.setUint8(7, 3);
  v.setBigUint64(8, BigInt(over.rootDirOffset ?? 127), true);
  v.setBigUint64(16, BigInt(over.rootDirLength ?? 240), true);
  v.setBigUint64(24, BigInt(over.metadataOffset ?? 367), true);
  v.setBigUint64(32, BigInt(over.metadataLength ?? 512), true);
  v.setBigUint64(40, BigInt(over.leafDirsOffset ?? 879), true);
  v.setBigUint64(48, BigInt(over.leafDirsLength ?? 4096), true);
  v.setBigUint64(56, BigInt(over.tileDataOffset ?? 4975), true);
  v.setBigUint64(64, BigInt(over.tileDataLength ?? 4_100_000_000), true); // > 2^32
  v.setBigUint64(72, BigInt(1_234_567), true);
  v.setBigUint64(80, BigInt(1_000_000), true);
  v.setBigUint64(88, BigInt(999_000), true);
  v.setUint8(96, 1);   // clustered
  v.setUint8(97, 2);   // internal compression: gzip
  v.setUint8(98, 2);   // tile compression: gzip
  v.setUint8(99, 1);   // tile type: mvt
  v.setUint8(100, 0);
  v.setUint8(101, 16);
  v.setInt32(102, Math.round(BAY_BOUNDS.minLng * 1e7), true);
  v.setInt32(106, Math.round(BAY_BOUNDS.minLat * 1e7), true);
  v.setInt32(110, Math.round(BAY_BOUNDS.maxLng * 1e7), true);
  v.setInt32(114, Math.round(BAY_BOUNDS.maxLat * 1e7), true);
  v.setUint8(118, 11);
  v.setInt32(119, Math.round(-122.33 * 1e7), true);
  v.setInt32(123, Math.round(37.66 * 1e7), true);
  return buf;
}

/* ── the columnar directory encoding, written by hand ─────────────────────────*/
const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) { out.push((v % 128) + 0x80); v = Math.floor(v / 128); }
  out.push(v);
  return out;
};
/** `offsets`: pass null for an entry to use the "0 ⇒ contiguous" shorthand. */
function encodeDirectory(entries: { tileId: number; runLength: number; length: number; offset: number | null }[]): Uint8Array {
  const bytes: number[] = [...varint(entries.length)];
  let last = 0;
  for (const e of entries) { bytes.push(...varint(e.tileId - last)); last = e.tileId; }
  for (const e of entries) bytes.push(...varint(e.runLength));
  for (const e of entries) bytes.push(...varint(e.length));
  for (const e of entries) bytes.push(...varint(e.offset === null ? 0 : e.offset + 1));
  return new Uint8Array(bytes);
}

describe("PMTiles v3 header", () => {
  it("parses every field, including 64-bit lengths past 2^32", () => {
    const h = parsePmtilesHeader(makeHeader());
    expect(h.rootDirOffset).toBe(127);
    expect(h.rootDirLength).toBe(240);
    expect(h.leafDirsOffset).toBe(879);
    expect(h.tileDataOffset).toBe(4975);
    expect(h.tileDataLength).toBe(4_100_000_000);
    expect(h.clustered).toBe(true);
    expect(h.internalCompression).toBe("gzip");
    expect(h.tileCompression).toBe("gzip");
    expect(h.tileType).toBe("mvt");
    expect(h.minZoom).toBe(0);
    expect(h.maxZoom).toBe(16);
    // the bbox survives the ×1e7 int round-trip — it IS BAY_BOUNDS
    expect(h.bounds[0]).toBeCloseTo(BAY_BOUNDS.minLng, 6);
    expect(h.bounds[1]).toBeCloseTo(BAY_BOUNDS.minLat, 6);
    expect(h.bounds[2]).toBeCloseTo(BAY_BOUNDS.maxLng, 6);
    expect(h.bounds[3]).toBeCloseTo(BAY_BOUNDS.maxLat, 6);
    expect(h.centerZoom).toBe(11);
  });

  it("rejects a non-PMTiles buffer, a v2 archive and a short read", () => {
    expect(() => parsePmtilesHeader(new ArrayBuffer(PMTILES_HEADER_BYTES))).toThrow(/not a PMTiles/);
    const v2 = makeHeader();
    new DataView(v2).setUint8(7, 2);
    expect(() => parsePmtilesHeader(v2)).toThrow(/v2 is not supported/);
    expect(() => parsePmtilesHeader(new ArrayBuffer(64))).toThrow(/too short/);
  });
});

describe("Hilbert tile ids", () => {
  it("matches the spec's documented ordering", () => {
    expect(zxyToTileId(0, 0, 0)).toBe(0);
    // z1 walks the Hilbert curve: (0,0) → (0,1) → (1,1) → (1,0)
    expect(zxyToTileId(1, 0, 0)).toBe(1);
    expect(zxyToTileId(1, 0, 1)).toBe(2);
    expect(zxyToTileId(1, 1, 1)).toBe(3);
    expect(zxyToTileId(1, 1, 0)).toBe(4);
    expect(zxyToTileId(2, 0, 0)).toBe(5); // first tile of z2 = 1 + 4
    expect(zxyToTileId(3, 0, 0)).toBe(21); // 1 + 4 + 16
  });

  it("is a bijection within a zoom level (no two tiles share an id)", () => {
    for (const z of [1, 2, 3, 4, 5]) {
      const n = 2 ** z;
      const ids = new Set<number>();
      for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) ids.add(zxyToTileId(z, x, y));
      expect(ids.size).toBe(n * n);
      // and the level occupies a contiguous block
      expect(Math.max(...ids) - Math.min(...ids)).toBe(n * n - 1);
    }
  });

  it("maps an aligned square block to a CONTIGUOUS id run — the property streaming relies on", () => {
    // A Hilbert curve sends any aligned 2^k × 2^k block to exactly 4^k consecutive
    // ids. That is why one viewport of tiles falls in one or two byte ranges. A
    // row-major layout would span 7·64+7 = 455 ids for the same 8×8 block.
    const z = 6, n = 2 ** z, block = 8;
    for (let bx = 0; bx < n; bx += block) {
      for (let by = 0; by < n; by += block) {
        let min = Infinity, max = -Infinity;
        for (let x = bx; x < bx + block; x++) {
          for (let y = by; y < by + block; y++) {
            const id = zxyToTileId(z, x, y);
            min = Math.min(min, id); max = Math.max(max, id);
          }
        }
        expect(max - min).toBe(block * block - 1);
      }
    }
  });

  it("rejects out-of-range tiles", () => {
    expect(() => zxyToTileId(1, 2, 0)).toThrow(/out of range/);
    expect(() => zxyToTileId(30, 0, 0)).toThrow(/out of range/);
  });
});

describe("PMTiles directories", () => {
  it("round-trips delta ids, run lengths and explicit offsets", () => {
    const dir = parsePmtilesDirectory(encodeDirectory([
      { tileId: 5, runLength: 1, length: 100, offset: 0 },
      { tileId: 7, runLength: 3, length: 250, offset: 100 },
      { tileId: 20, runLength: 1, length: 40, offset: 4000 },
    ]));
    expect(dir.map((e) => e.tileId)).toEqual([5, 7, 20]);
    expect(dir.map((e) => e.offset)).toEqual([0, 100, 4000]);
    expect(dir.map((e) => e.length)).toEqual([100, 250, 40]);
    expect(dir.map((e) => e.runLength)).toEqual([1, 3, 1]);
  });

  it("applies the offset-0 'contiguous with the previous entry' shorthand", () => {
    const dir = parsePmtilesDirectory(encodeDirectory([
      { tileId: 0, runLength: 1, length: 10, offset: 0 },
      { tileId: 1, runLength: 1, length: 20, offset: null }, // ⇒ 10
      { tileId: 2, runLength: 1, length: 30, offset: null }, // ⇒ 30
      { tileId: 3, runLength: 1, length: 5, offset: null },  // ⇒ 60
    ]));
    expect(dir.map((e) => e.offset)).toEqual([0, 10, 30, 60]);
  });

  it("parses an empty directory and refuses a truncated one", () => {
    expect(parsePmtilesDirectory(encodeDirectory([]))).toEqual([]);
    expect(() => parsePmtilesDirectory(new Uint8Array([5]))).toThrow(/truncated/);
  });

  it("finds the greatest entry ≤ the target", () => {
    const entries: DirEntry[] = [5, 9, 14, 30].map((tileId) => ({ tileId, offset: 0, length: 1, runLength: 1 }));
    expect(findPmtilesEntry(entries, 4)).toBeNull();
    expect(findPmtilesEntry(entries, 5)!.tileId).toBe(5);
    expect(findPmtilesEntry(entries, 13)!.tileId).toBe(9);
    expect(findPmtilesEntry(entries, 999)!.tileId).toBe(30);
    expect(findPmtilesEntry([], 1)).toBeNull();
  });
});

describe("tile resolution", () => {
  const header: PmtilesHeader = parsePmtilesHeader(makeHeader());
  const entry = (tileId: number, runLength: number, offset: number, length: number): DirEntry => ({ tileId, runLength, offset, length });

  it("returns an absolute tile range inside the run", () => {
    const r = resolveTile(header, [entry(100, 4, 512, 64)], 103);
    expect(r).toEqual({ kind: "tile", offset: header.tileDataOffset + 512, length: 64 });
  });

  it("treats a tile id past the run as absent, not an error", () => {
    expect(resolveTile(header, [entry(100, 4, 512, 64)], 104)).toEqual({ kind: "absent" });
    expect(resolveTile(header, [entry(100, 4, 512, 64)], 99)).toEqual({ kind: "absent" });
    expect(resolveTile(header, [], 1)).toEqual({ kind: "absent" });
  });

  it("follows a runLength-0 entry into the leaf directory section", () => {
    const r = resolveTile(header, [entry(0, 0, 2048, 300)], 12345);
    expect(r).toEqual({ kind: "leaf", offset: header.leafDirsOffset + 2048, length: 300 });
  });

  it("treats a zero-length leaf pointer as absent (a deleted branch)", () => {
    expect(resolveTile(header, [entry(0, 0, 2048, 0)], 5)).toEqual({ kind: "absent" });
  });
});
