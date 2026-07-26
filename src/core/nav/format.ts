/**
 * The walk-graph binary container — PURE encode/decode, no I/O.
 *
 * One contiguous ArrayBuffer so the browser can `fetch` it (or read it straight
 * out of OPFS), hand it to the routing Web Worker as a transferable, and create
 * typed-array VIEWS over it with zero copying and zero parsing. Sections are
 * 4-byte aligned because an unaligned `new Int32Array(buf, off)` throws.
 *
 * Layout (little-endian, the only byte order any target we ship to uses):
 *
 *   0   char[8]  magic "BAYWALK1"
 *   8   u32      version
 *   12  u32      nodeCount  (n)
 *   16  u32      edgeCount  (m)   — directed arcs
 *   20  u32      dictBytes
 *   24  u32      reserved (0)
 *   28  u32      reserved (0)
 *   32  i32[2n]  coords    lat,lng interleaved ×1e7
 *       u16[n]   elevation metres
 *       u32[n+1] offsets
 *       u32[m]   targets
 *       u16[m]   cost      decimetres
 *       u8[m]    flags
 *       u32[m]   names     → nameDict index
 *       utf8     dict      JSON string array
 */
import type { WalkGraph } from "./graph";

export const WALK_GRAPH_MAGIC = "BAYWALK1";
export const WALK_GRAPH_VERSION = 1;
export const HEADER_BYTES = 32;

const align4 = (x: number) => (x + 3) & ~3;

export interface WalkGraphLayout {
  coords: number; elevation: number; offsets: number; targets: number;
  cost: number; flags: number; names: number; dict: number; total: number;
}

/** Byte offset of every section. Exported so encode, decode and the build script
 *  can never disagree about the layout. */
export function walkGraphLayout(nodeCount: number, edgeCount: number, dictBytes: number): WalkGraphLayout {
  const coords = HEADER_BYTES;
  const elevation = align4(coords + 8 * nodeCount);
  const offsets = align4(elevation + 2 * nodeCount);
  const targets = align4(offsets + 4 * (nodeCount + 1));
  const cost = align4(targets + 4 * edgeCount);
  const flags = align4(cost + 2 * edgeCount);
  const names = align4(flags + edgeCount);
  const dict = align4(names + 4 * edgeCount);
  return { coords, elevation, offsets, targets, cost, flags, names, dict, total: align4(dict + dictBytes) };
}

export function encodeWalkGraph(g: WalkGraph): ArrayBuffer {
  const dictBytes = new TextEncoder().encode(JSON.stringify(g.nameDict));
  const l = walkGraphLayout(g.nodeCount, g.edgeCount, dictBytes.length);
  const buf = new ArrayBuffer(l.total);
  const u8 = new Uint8Array(buf);
  u8.set(new TextEncoder().encode(WALK_GRAPH_MAGIC), 0);
  const head = new DataView(buf);
  head.setUint32(8, WALK_GRAPH_VERSION, true);
  head.setUint32(12, g.nodeCount, true);
  head.setUint32(16, g.edgeCount, true);
  head.setUint32(20, dictBytes.length, true);

  new Int32Array(buf, l.coords, 2 * g.nodeCount).set(g.coords);
  new Uint16Array(buf, l.elevation, g.nodeCount).set(g.elevation);
  new Uint32Array(buf, l.offsets, g.nodeCount + 1).set(g.offsets);
  new Uint32Array(buf, l.targets, g.edgeCount).set(g.targets);
  new Uint16Array(buf, l.cost, g.edgeCount).set(g.cost);
  u8.set(g.flags, l.flags);
  new Uint32Array(buf, l.names, g.edgeCount).set(g.names);
  u8.set(dictBytes, l.dict);
  return buf;
}

/** Views over `buf` — no copy. The caller must keep the buffer alive. */
export function decodeWalkGraph(buf: ArrayBuffer): WalkGraph {
  if (buf.byteLength < HEADER_BYTES) throw new Error("not a walk graph: buffer too small");
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 8));
  if (magic !== WALK_GRAPH_MAGIC) throw new Error(`not a walk graph: bad magic ${JSON.stringify(magic)}`);
  const head = new DataView(buf);
  const version = head.getUint32(8, true);
  if (version !== WALK_GRAPH_VERSION) throw new Error(`walk graph version ${version} is not supported (expected ${WALK_GRAPH_VERSION})`);
  const nodeCount = head.getUint32(12, true);
  const edgeCount = head.getUint32(16, true);
  const dictBytes = head.getUint32(20, true);
  const l = walkGraphLayout(nodeCount, edgeCount, dictBytes);
  if (buf.byteLength < l.dict + dictBytes) throw new Error("not a walk graph: truncated");

  let nameDict: string[] = [""];
  if (dictBytes > 0) {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, l.dict, dictBytes)));
    if (Array.isArray(parsed)) nameDict = parsed.map((s) => String(s));
  }
  return {
    nodeCount, edgeCount,
    coords: new Int32Array(buf, l.coords, 2 * nodeCount),
    elevation: new Uint16Array(buf, l.elevation, nodeCount),
    offsets: new Uint32Array(buf, l.offsets, nodeCount + 1),
    targets: new Uint32Array(buf, l.targets, edgeCount),
    cost: new Uint16Array(buf, l.cost, edgeCount),
    flags: new Uint8Array(buf, l.flags, edgeCount),
    names: new Uint32Array(buf, l.names, edgeCount),
    nameDict,
  };
}
