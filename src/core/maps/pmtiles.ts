/**
 * PMTiles v3 decoding — PURE. No fetch, no decompression, no MapLibre.
 *
 * The browser half (sources, gzip, caching, the `pmtiles://` protocol) lives in
 * `web/src/features/map/pmtiles.ts` and imports this. Splitting it this way is not
 * bookkeeping: the Hilbert tile ordering and the columnar directory encoding are
 * exactly where a silent off-by-one produces a *blank map* rather than an error,
 * so they belong somewhere a unit test can reach them without a DOM.
 *
 * Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 */

/** A v3 header is a fixed 127 bytes at offset 0 — the first range read of a session. */
export const PMTILES_HEADER_BYTES = 127;

export type Compression = "unknown" | "none" | "gzip" | "brotli" | "zstd";
const COMPRESSION: Compression[] = ["unknown", "none", "gzip", "brotli", "zstd"];
export type TileType = "unknown" | "mvt" | "png" | "jpeg" | "webp" | "avif";
const TILE_TYPE: TileType[] = ["unknown", "mvt", "png", "jpeg", "webp", "avif"];

export interface PmtilesHeader {
  rootDirOffset: number; rootDirLength: number;
  metadataOffset: number; metadataLength: number;
  leafDirsOffset: number; leafDirsLength: number;
  tileDataOffset: number; tileDataLength: number;
  addressedTiles: number; tileEntries: number; tileContents: number;
  clustered: boolean;
  internalCompression: Compression;
  tileCompression: Compression;
  tileType: TileType;
  minZoom: number; maxZoom: number;
  /** [minLng, minLat, maxLng, maxLat] */
  bounds: [number, number, number, number];
  center: [number, number];
  centerZoom: number;
}

/** PMTiles stores offsets as uint64. Byte offsets stay exact as Numbers well past
 *  any plausible pack size (2^53 bytes), so we convert rather than thread BigInt. */
const u64 = (v: DataView, off: number) => Number(v.getBigUint64(off, true));

export function parsePmtilesHeader(buf: ArrayBuffer): PmtilesHeader {
  if (buf.byteLength < PMTILES_HEADER_BYTES) throw new Error("not a PMTiles archive: header too short");
  const v = new DataView(buf);
  let magic = "";
  for (let i = 0; i < 7; i++) magic += String.fromCharCode(v.getUint8(i));
  if (magic !== "PMTiles") throw new Error(`not a PMTiles archive (magic ${JSON.stringify(magic)})`);
  const version = v.getUint8(7);
  if (version !== 3) throw new Error(`PMTiles v${version} is not supported (need v3)`);
  return {
    rootDirOffset: u64(v, 8), rootDirLength: u64(v, 16),
    metadataOffset: u64(v, 24), metadataLength: u64(v, 32),
    leafDirsOffset: u64(v, 40), leafDirsLength: u64(v, 48),
    tileDataOffset: u64(v, 56), tileDataLength: u64(v, 64),
    addressedTiles: u64(v, 72), tileEntries: u64(v, 80), tileContents: u64(v, 88),
    clustered: v.getUint8(96) === 1,
    internalCompression: COMPRESSION[v.getUint8(97)] ?? "unknown",
    tileCompression: COMPRESSION[v.getUint8(98)] ?? "unknown",
    tileType: TILE_TYPE[v.getUint8(99)] ?? "unknown",
    minZoom: v.getUint8(100), maxZoom: v.getUint8(101),
    bounds: [v.getInt32(102, true) / 1e7, v.getInt32(106, true) / 1e7, v.getInt32(110, true) / 1e7, v.getInt32(114, true) / 1e7],
    centerZoom: v.getUint8(118),
    center: [v.getInt32(119, true) / 1e7, v.getInt32(123, true) / 1e7],
  };
}

/**
 * z/x/y → the archive's tile id.
 *
 * Tiles are ordered along a Hilbert curve within each zoom level, after all
 * shallower levels. That's why a viewport's worth of tiles usually lands in one
 * or two contiguous byte ranges — the property the whole streaming design leans on.
 */
export function zxyToTileId(z: number, x: number, y: number): number {
  if (z < 0 || z > 26) throw new Error(`pmtiles: zoom ${z} out of range`);
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) throw new Error(`pmtiles: tile ${z}/${x}/${y} out of range`);
  let acc = 0;
  for (let t = 0; t < z; t++) acc += 4 ** t;
  let tx = x, ty = y, d = 0;
  for (let s = n / 2; s > 0; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { tx = s - 1 - tx; ty = s - 1 - ty; }
      const swap = tx; tx = ty; ty = swap;
    }
  }
  return acc + d;
}

export interface DirEntry {
  tileId: number;
  offset: number;
  length: number;
  /** 0 ⇒ this entry points at a LEAF DIRECTORY, not a tile. */
  runLength: number;
}

/** Varint reader over a decompressed directory blob. */
class VarintReader {
  p = 0;
  constructor(private b: Uint8Array) {}
  read(): number {
    let result = 0, shift = 1, byte: number;
    do {
      if (this.p >= this.b.length) throw new Error("pmtiles: directory truncated");
      byte = this.b[this.p++]!;
      result += (byte & 0x7f) * shift;
      shift *= 128;
    } while (byte >= 0x80);
    return result;
  }
}

/**
 * Directories are COLUMNAR: the entry count, then every delta-coded tile id, then
 * every run length, then every length, then every offset — where an offset of 0
 * means "immediately after the previous entry" (the common clustered case).
 */
export function parsePmtilesDirectory(buf: ArrayBuffer | Uint8Array): DirEntry[] {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new VarintReader(bytes);
  const n = r.read();
  const entries: DirEntry[] = new Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) { last += r.read(); entries[i] = { tileId: last, offset: 0, length: 0, runLength: 0 }; }
  for (let i = 0; i < n; i++) entries[i]!.runLength = r.read();
  for (let i = 0; i < n; i++) entries[i]!.length = r.read();
  for (let i = 0; i < n; i++) {
    const v = r.read();
    if (v === 0 && i > 0) {
      const prev = entries[i - 1]!;
      entries[i]!.offset = prev.offset + prev.length;
    } else {
      entries[i]!.offset = v - 1;
    }
  }
  return entries;
}

/** The entry with the largest tileId ≤ `tileId`, or null. */
export function findPmtilesEntry(entries: DirEntry[], tileId: number): DirEntry | null {
  let lo = 0, hi = entries.length - 1, best: DirEntry | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = entries[mid]!;
    if (e.tileId <= tileId) { best = e; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

export type Resolution =
  /** No tile here — ocean, or outside the extract's bbox. NOT an error. */
  | { kind: "absent" }
  /** Read `length` bytes at `offset` (already absolute) and decompress with tileCompression. */
  | { kind: "tile"; offset: number; length: number }
  /** Read a leaf directory at `offset`/`length`, parse it, and resolve again. */
  | { kind: "leaf"; offset: number; length: number };

/**
 * One step of the lookup: given a directory and the header, say whether the tile
 * is here, absent, or one directory deeper. Keeping this pure is what lets the
 * async browser half be a five-line loop.
 */
export function resolveTile(header: PmtilesHeader, dir: DirEntry[], tileId: number): Resolution {
  const entry = findPmtilesEntry(dir, tileId);
  if (!entry) return { kind: "absent" };
  if (entry.runLength > 0) {
    if (tileId >= entry.tileId + entry.runLength) return { kind: "absent" };
    return { kind: "tile", offset: header.tileDataOffset + entry.offset, length: entry.length };
  }
  if (entry.length === 0) return { kind: "absent" };
  return { kind: "leaf", offset: header.leafDirsOffset + entry.offset, length: entry.length };
}
