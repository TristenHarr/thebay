#!/usr/bin/env node
/**
 * Build the offline pedestrian routing graph for the Bay from a Geofabrik extract.
 *
 *   curl -O https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf
 *   npm run build:walk-graph -- --pbf=norcal-latest.osm.pbf
 *   npm run build:walk-graph -- --pbf=norcal-latest.osm.pbf --no-elevation
 *   npm run build:walk-graph -- --pbf=norcal-latest.osm.pbf --upload
 *   npm run build:walk-graph -- --pbf=tiny.osm.pbf --out=/tmp/x --no-elevation
 *
 * Output: ONE binary CSR pack (src/core/nav/format.ts) — Int32 coords ×1e7, Uint32
 * offsets, Uint32 edge targets, Uint16 cost in decimetres, Uint8 flags, Uint16
 * elevation in metres, plus a compact street-name dictionary for named turns.
 * The browser fetches it once, hands the ArrayBuffer to the routing Web Worker as
 * a transferable, and creates typed-array views with zero parsing.
 *
 * Everything here is self-contained on purpose: a minimal protobuf reader, a
 * minimal PNG reader, and node:zlib. Adding an osm-pbf dependency to ship one
 * build script is not a trade worth making.
 *
 * MEASUREMENT, NOT ESTIMATION: it prints the real byte count of every CSR section
 * and of the finished pack.
 *
 * MEMORY: a NorCal extract references tens of millions of nodes. Run it with
 *   NODE_OPTIONS=--max-old-space-size=8192
 * (the npm script already does).
 */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { inflateSync } from "node:zlib";
import { BAY_BOUNDS } from "../src/core/geo.ts";
import { buildWalkGraph, FLAG_STEPS, FLAG_CROSSING, FLAG_INDOOR, FLAG_LIT } from "../src/core/nav/graph.ts";
import { encodeWalkGraph, walkGraphLayout } from "../src/core/nav/format.ts";

const ROOT = process.cwd();
const OUT_DIR = resolve(ROOT, "data/packs");
const DEM_DIR = resolve(ROOT, "data/terrarium");
/** Free, keyless AWS public dataset. z12 ≈ 30 m/px at Bay latitudes — plenty to
 *  tell a 20% block from a flat one over a 100 m street segment. */
const TERRARIUM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const DEM_ZOOM = 12;

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let i = -1, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${u[i]} (${n.toLocaleString()} bytes)`;
};
const log = (...a) => console.log(...a);

/* ── a minimal protobuf wire reader ──────────────────────────────────────────
 * Only what OSM PBF uses: varint, zigzag varint, length-delimited, and packed
 * repeated fields. Varints accumulate by multiplication rather than shifting so
 * 64-bit OSM ids (~1.3e10, well under 2^53) survive intact.
 */
class PB {
  constructor(buf, pos = 0, end = buf.length) { this.b = buf; this.p = pos; this.e = end; }
  get done() { return this.p >= this.e; }
  varint() {
    let result = 0, shift = 1, b;
    do { b = this.b[this.p++]; result += (b & 0x7f) * shift; shift *= 128; } while (b >= 0x80);
    return result;
  }
  svarint() { const n = this.varint(); return n % 2 ? -(n + 1) / 2 : n / 2; }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.p += 8;
    // NB: read the length into a local FIRST. `this.p += this.varint()` evaluates
    // the left-hand `this.p` before the call advances it, so it lands one length
    // varint short — which desyncs the whole stream into phantom wire types.
    else if (wire === 2) { const len = this.varint(); this.p += len; }
    else if (wire === 5) this.p += 4;
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
  /** Iterate (fieldNumber, wireType, reader) until `end`. */
  *fields() {
    while (!this.done) {
      const tag = this.varint();
      yield [tag >>> 3, tag & 7];
    }
  }
  sub() { const len = this.varint(); const r = new PB(this.b, this.p, this.p + len); this.p += len; return r; }
  bytes() { const len = this.varint(); const s = this.b.subarray(this.p, this.p + len); this.p += len; return s; }
  packed(kind) {
    const len = this.varint();
    const end = this.p + len;
    const out = [];
    while (this.p < end) out.push(kind === "s" ? this.svarint() : this.varint());
    return out;
  }
}

/* ── PBF blob iteration ──────────────────────────────────────────────────────*/
function* blobs(path) {
  const fd = openSync(path, "r");
  try {
    const total = statSync(path).size;
    let off = 0;
    const len4 = Buffer.alloc(4);
    while (off < total) {
      if (readSync(fd, len4, 0, 4, off) !== 4) break;
      const headerLen = len4.readInt32BE(0);
      off += 4;
      const headerBuf = Buffer.alloc(headerLen);
      readSync(fd, headerBuf, 0, headerLen, off);
      off += headerLen;
      let type = "", dataSize = 0;
      const h = new PB(headerBuf);
      for (const [f, w] of h.fields()) {
        if (f === 1 && w === 2) type = Buffer.from(h.bytes()).toString("utf8");
        else if (f === 3 && w === 0) dataSize = h.varint();
        else h.skip(w);
      }
      const blobBuf = Buffer.alloc(dataSize);
      readSync(fd, blobBuf, 0, dataSize, off);
      off += dataSize;
      yield { type, data: decodeBlob(blobBuf), progress: off / total };
    }
  } finally { closeSync(fd); }
}

function decodeBlob(buf) {
  const b = new PB(buf);
  let raw = null, zlibData = null;
  for (const [f, w] of b.fields()) {
    if (f === 1 && w === 2) raw = b.bytes();
    else if (f === 3 && w === 2) zlibData = b.bytes();
    else if (f === 4 || f === 5 || f === 6) { b.skip(w); throw new Error("this .osm.pbf uses lzma/lz4/zstd compression; re-export it with zlib (osmium cat -o out.osm.pbf in.osm.pbf)"); }
    else b.skip(w);
  }
  if (raw) return Buffer.from(raw);
  if (zlibData) return inflateSync(Buffer.from(zlibData));
  throw new Error("empty PBF blob");
}

/** Decode one PrimitiveBlock into { strings, granularity, latOff, lonOff, groups }. */
function primitiveBlock(buf) {
  const pb = new PB(buf);
  const strings = [];
  const groups = [];
  let granularity = 100, latOff = 0, lonOff = 0;
  for (const [f, w] of pb.fields()) {
    if (f === 1 && w === 2) {
      const st = pb.sub();
      for (const [sf, sw] of st.fields()) {
        if (sf === 1 && sw === 2) strings.push(Buffer.from(st.bytes()).toString("utf8"));
        else st.skip(sw);
      }
    } else if (f === 2 && w === 2) groups.push(pb.bytes());
    else if (f === 17 && w === 0) granularity = pb.varint();
    else if (f === 19 && w === 0) latOff = pb.svarint();
    else if (f === 20 && w === 0) lonOff = pb.svarint();
    else pb.skip(w);
  }
  return { strings, granularity, latOff, lonOff, groups };
}

/* ── which ways can you walk on ──────────────────────────────────────────────
 * The spec list, plus an explicit foot=yes/designated override, minus anything
 * that says foot=no or is a motorway. Precision over recall: a bogus edge routes
 * someone onto a freeway shoulder.
 */
const WALKABLE = new Set(["footway", "path", "pedestrian", "steps", "residential", "service", "living_street"]);
const NEVER = new Set(["motorway", "motorway_link", "trunk", "trunk_link", "construction", "proposed", "raceway"]);

function classifyWay(tags) {
  const hw = tags.highway;
  const foot = tags.foot;
  if (foot === "no" || tags.access === "private" || tags.access === "no") return null;
  if (hw && NEVER.has(hw)) return null;
  const allowed = (hw && WALKABLE.has(hw)) || foot === "yes" || foot === "designated";
  if (!allowed) return null;
  let flags = 0;
  if (hw === "steps") flags |= FLAG_STEPS;
  if (tags.footway === "crossing" || hw === "crossing" || tags.crossing) flags |= FLAG_CROSSING;
  if (tags.indoor === "yes" || hw === "corridor" || tags.tunnel === "building_passage") flags |= FLAG_INDOOR;
  if (tags.lit === "yes") flags |= FLAG_LIT;
  return { flags, name: tags.name || "", oneway: hw === "steps" && tags["oneway:foot"] === "yes" };
}

/* ── growable typed arrays ───────────────────────────────────────────────────*/
function grow(arr, need, Ctor) {
  if (need <= arr.length) return arr;
  let cap = Math.max(1024, arr.length);
  while (cap < need) cap *= 2;
  const next = new Ctor(cap);
  next.set(arr);
  return next;
}

/* ── pass 1: walkable ways + the node ids they reference ─────────────────────*/
function readWays(pbf) {
  let refs = new Float64Array(1 << 20), refN = 0;
  let wayStart = new Uint32Array(1 << 16), wayLen = new Uint32Array(1 << 16);
  let wayFlags = new Uint8Array(1 << 16), wayName = new Uint32Array(1 << 16), wayOneway = new Uint8Array(1 << 16);
  let wayN = 0;
  const nameDict = [""], nameIds = new Map([["", 0]]);
  let blocks = 0, lastPct = -1;

  for (const blob of blobs(pbf)) {
    if (blob.type !== "OSMData") continue;
    const { strings, groups } = primitiveBlock(blob.data);
    for (const gbuf of groups) {
      const g = new PB(gbuf);
      for (const [f, w] of g.fields()) {
        if (f !== 3 || w !== 2) { g.skip(w); continue; }
        const way = g.sub();
        const keys = [], vals = [];
        let wrefs = null;
        for (const [wf, ww] of way.fields()) {
          if (wf === 2 && ww === 2) keys.push(...way.packed("u"));
          else if (wf === 3 && ww === 2) vals.push(...way.packed("u"));
          else if (wf === 8 && ww === 2) wrefs = way.packed("s");
          else way.skip(ww);
        }
        if (!wrefs || wrefs.length < 2) continue;
        const tags = {};
        for (let i = 0; i < keys.length; i++) tags[strings[keys[i]]] = strings[vals[i]];
        const cls = classifyWay(tags);
        if (!cls) continue;

        // delta-decode the node refs
        let id = 0;
        refs = grow(refs, refN + wrefs.length, Float64Array);
        const start = refN;
        for (const d of wrefs) { id += d; refs[refN++] = id; }

        wayStart = grow(wayStart, wayN + 1, Uint32Array);
        wayLen = grow(wayLen, wayN + 1, Uint32Array);
        wayFlags = grow(wayFlags, wayN + 1, Uint8Array);
        wayName = grow(wayName, wayN + 1, Uint32Array);
        wayOneway = grow(wayOneway, wayN + 1, Uint8Array);
        let nid = nameIds.get(cls.name);
        if (nid === undefined) { nid = nameDict.length; nameDict.push(cls.name); nameIds.set(cls.name, nid); }
        wayStart[wayN] = start; wayLen[wayN] = wrefs.length; wayFlags[wayN] = cls.flags; wayName[wayN] = nid; wayOneway[wayN] = cls.oneway ? 1 : 0;
        wayN++;
      }
    }
    blocks++;
    const pct = Math.floor(blob.progress * 100);
    if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; process.stdout.write(`\r  pass 1 (ways)  ${pct}%  ${wayN.toLocaleString()} walkable ways, ${refN.toLocaleString()} refs`); }
  }
  process.stdout.write("\n");
  return { refs: refs.subarray(0, refN), wayStart, wayLen, wayFlags, wayName, wayOneway, wayN, nameDict, blocks };
}

/** Sorted unique ids + per-id reference counts (capped at 255 — we only need ≥2). */
function uniqueRefs(refs) {
  const sorted = Float64Array.from(refs).sort();
  const ids = new Float64Array(sorted.length);
  const counts = new Uint8Array(sorted.length);
  let n = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (n > 0 && ids[n - 1] === sorted[i]) { if (counts[n - 1] < 255) counts[n - 1]++; continue; }
    ids[n] = sorted[i]; counts[n] = 1; n++;
  }
  return { ids: ids.subarray(0, n), counts: counts.subarray(0, n) };
}

function bsearch(ids, id) {
  let lo = 0, hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid] === id) return mid;
    if (ids[mid] < id) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/* ── pass 2: coordinates for exactly those ids ───────────────────────────────*/
function readNodes(pbf, ids) {
  const lat = new Float64Array(ids.length).fill(NaN);
  const lon = new Float64Array(ids.length);
  let found = 0, lastPct = -1;
  for (const blob of blobs(pbf)) {
    if (blob.type !== "OSMData") continue;
    // Node tags are irrelevant here — pass 1 already decided what's walkable, so
    // this pass only needs coordinates. That's why the string table is skipped.
    const { granularity, latOff, lonOff, groups } = primitiveBlock(blob.data);
    for (const gbuf of groups) {
      const g = new PB(gbuf);
      for (const [f, w] of g.fields()) {
        if (f === 2 && w === 2) {
          // DenseNodes
          const d = g.sub();
          let dIds = null, dLat = null, dLon = null;
          for (const [df, dw] of d.fields()) {
            if (df === 1 && dw === 2) dIds = d.packed("s");
            else if (df === 8 && dw === 2) dLat = d.packed("s");
            else if (df === 9 && dw === 2) dLon = d.packed("s");
            else d.skip(dw);
          }
          if (!dIds || !dLat || !dLon) continue;
          let id = 0, la = 0, lo = 0;
          for (let i = 0; i < dIds.length; i++) {
            id += dIds[i]; la += dLat[i]; lo += dLon[i];
            const slot = bsearch(ids, id);
            if (slot >= 0 && Number.isNaN(lat[slot])) {
              lat[slot] = 1e-9 * (latOff + granularity * la);
              lon[slot] = 1e-9 * (lonOff + granularity * lo);
              found++;
            }
          }
        } else if (f === 1 && w === 2) {
          // plain Node (rare in modern extracts, but legal)
          const nd = g.sub();
          let id = 0, la = 0, lo = 0;
          for (const [nf, nw] of nd.fields()) {
            if (nf === 1 && nw === 0) id = nd.svarint();
            else if (nf === 8 && nw === 0) la = nd.svarint();
            else if (nf === 9 && nw === 0) lo = nd.svarint();
            else nd.skip(nw);
          }
          const slot = bsearch(ids, id);
          if (slot >= 0 && Number.isNaN(lat[slot])) {
            lat[slot] = 1e-9 * (latOff + granularity * la);
            lon[slot] = 1e-9 * (lonOff + granularity * lo);
            found++;
          }
        } else g.skip(w);
      }
    }
    const pct = Math.floor(blob.progress * 100);
    if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; process.stdout.write(`\r  pass 2 (nodes) ${pct}%  ${found.toLocaleString()} / ${ids.length.toLocaleString()} located`); }
  }
  process.stdout.write("\n");
  return { lat, lon, found };
}

/* ── elevation: Mapzen/AWS terrarium PNG tiles ───────────────────────────────
 * Without this, "avoid hills" is a checkbox that does nothing — so it is ON by
 * default and the script says loudly when it had to fall back to zeros.
 * terrarium encodes metres as (R·256 + G + B/256) − 32768.
 */
function pngRGB(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let p = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const row = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pbv = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pbv && pa <= pc ? a : pbv <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
}

const lngToTileX = (lng, z) => ((lng + 180) / 360) * 2 ** z;
const latToTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

async function loadElevation(latArr, lonArr) {
  mkdirSync(DEM_DIR, { recursive: true });
  // Only the tiles the graph actually touches — the Bay bbox is mostly ocean and
  // ridgeline with no footpaths, so this is a fraction of the bounding rectangle.
  const need = new Set();
  for (let i = 0; i < latArr.length; i++) {
    if (Number.isNaN(latArr[i])) continue;
    need.add(`${Math.floor(lngToTileX(lonArr[i], DEM_ZOOM))}/${Math.floor(latToTileY(latArr[i], DEM_ZOOM))}`);
  }
  log(`  DEM: z${DEM_ZOOM} terrarium — ${need.size} tiles cover the graph (cached in data/terrarium)`);

  const tiles = new Map();
  let fetched = 0, cached = 0, failed = 0, bytes = 0, done = 0;
  const keys = [...need];
  const CONCURRENCY = 16; // S3 is happy with this and it turns minutes into seconds
  const worker = async () => {
    for (;;) {
      const key = keys.pop();
      if (!key) return;
      const [x, y] = key.split("/").map(Number);
      const file = resolve(DEM_DIR, `${DEM_ZOOM}-${x}-${y}.png`);
      let buf = null;
      if (existsSync(file)) { buf = readFileSync(file); cached++; }
      else {
        try {
          const res = await fetch(TERRARIUM(DEM_ZOOM, x, y));
          if (!res.ok) { failed++; continue; }
          buf = Buffer.from(await res.arrayBuffer());
          writeFileSync(file, buf);
          fetched++;
        } catch { failed++; continue; }
      }
      bytes += buf.length;
      try { tiles.set(key, pngRGB(buf)); } catch { failed++; }
      if (++done % 20 === 0) process.stdout.write(`\r  DEM: ${done}/${need.size} (${fetched} fetched, ${cached} cached, ${failed} failed)`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write(`\r  DEM: ${done}/${need.size} tiles — ${fetched} fetched, ${cached} cached, ${failed} failed, ${fmtBytes(bytes)}\n`);

  const elev = new Uint16Array(latArr.length);
  let hits = 0;
  for (let i = 0; i < latArr.length; i++) {
    if (Number.isNaN(latArr[i])) continue;
    const fx = lngToTileX(lonArr[i], DEM_ZOOM), fy = latToTileY(latArr[i], DEM_ZOOM);
    const t = tiles.get(`${Math.floor(fx)}/${Math.floor(fy)}`);
    if (!t) continue;
    const px = Math.min(t.width - 1, Math.max(0, Math.floor((fx % 1) * t.width)));
    const py = Math.min(t.height - 1, Math.max(0, Math.floor((fy % 1) * t.height)));
    const o = (py * t.width + px) * t.channels;
    const metres = t.pixels[o] * 256 + t.pixels[o + 1] + t.pixels[o + 2] / 256 - 32768;
    elev[i] = Math.max(0, Math.min(65535, Math.round(metres)));
    hits++;
  }
  log(`  DEM: ${hits.toLocaleString()} / ${latArr.length.toLocaleString()} nodes given an elevation`);
  return { elev, hits };
}

/* ── main ────────────────────────────────────────────────────────────────────*/
const pbf = args.pbf || "norcal-latest.osm.pbf";
if (!existsSync(pbf)) {
  console.error(`
✗ No OSM extract at ${pbf}

  Download the NorCal extract (about 600 MB) and point --pbf at it:

    curl -O https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf
    npm run build:walk-graph -- --pbf=norcal-latest.osm.pbf

  Any .osm.pbf works as long as it covers BAY_BOUNDS and is zlib-compressed
  (the Geofabrik downloads are).
`);
  process.exit(1);
}

const t0 = Date.now();
log(`walk-graph ← ${basename(pbf)} (${fmtBytes(statSync(pbf).size)})`);
log(`bbox (BAY_BOUNDS): ${BAY_BOUNDS.minLng},${BAY_BOUNDS.minLat},${BAY_BOUNDS.maxLng},${BAY_BOUNDS.maxLat}`);

const ways = readWays(pbf);
if (ways.wayN === 0) { console.error("✗ No walkable ways found — is this really an OSM PBF?"); process.exit(1); }
const { ids, counts } = uniqueRefs(ways.refs);
log(`  ${ways.wayN.toLocaleString()} walkable ways · ${ids.length.toLocaleString()} distinct nodes`);

const { lat, lon } = readNodes(pbf, ids);

let elevation = new Uint16Array(ids.length);
if (args.elevation === "0" || args["no-elevation"]) {
  log("  ⚠ --no-elevation: every node gets 0 m. 'Avoid hills' will be INERT in this pack.");
} else {
  const r = await loadElevation(lat, lon);
  elevation = r.elev;
  if (r.hits === 0) log("  ⚠ No DEM tiles were usable — 'avoid hills' will be INERT in this pack.");
}

/* Compress each way to junction-to-junction edges: interior nodes that only one
 * way touches carry no decision, so they collapse into the edge's length. This is
 * what takes the graph from tens of millions of nodes to a few million. */
const inBay = (la, lo) => la > BAY_BOUNDS.minLat && la < BAY_BOUNDS.maxLat && lo > BAY_BOUNDS.minLng && lo < BAY_BOUNDS.maxLng;
const R = 6371000;
const metres = (aLa, aLo, bLa, bLo) => {
  const dLa = ((bLa - aLa) * Math.PI) / 180, dLo = ((bLo - aLo) * Math.PI) / 180;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos((aLa * Math.PI) / 180) * Math.cos((bLa * Math.PI) / 180) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

const vertexOf = new Int32Array(ids.length).fill(-1);
const nodes = [];
const edges = [];
let dropped = 0;
const vertex = (slot) => {
  if (vertexOf[slot] >= 0) return vertexOf[slot];
  const id = nodes.length;
  nodes.push({ lat: lat[slot], lng: lon[slot], elev: elevation[slot] });
  vertexOf[slot] = id;
  return id;
};

for (let w = 0; w < ways.wayN; w++) {
  const start = ways.wayStart[w], len = ways.wayLen[w];
  const slots = [];
  for (let i = 0; i < len; i++) {
    const slot = bsearch(ids, ways.refs[start + i]);
    if (slot < 0 || Number.isNaN(lat[slot]) || !inBay(lat[slot], lon[slot])) { slots.push(-1); continue; }
    slots.push(slot);
  }
  let anchor = -1, run = 0, prev = -1;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot < 0) { anchor = -1; run = 0; prev = -1; dropped++; continue; } // way leaves the bbox
    if (prev >= 0) run += metres(lat[prev], lon[prev], lat[slot], lon[slot]);
    const isJunction = counts[slot] >= 2 || i === 0 || i === slots.length - 1;
    if (anchor < 0) { anchor = slot; run = 0; }
    else if (isJunction) {
      if (anchor !== slot && run > 0) {
        edges.push({ a: vertex(anchor), b: vertex(slot), lengthM: run, flags: ways.wayFlags[w], name: ways.nameDict[ways.wayName[w]], oneway: ways.wayOneway[w] === 1 });
      }
      anchor = slot; run = 0;
    }
    prev = slot;
  }
}

log(`  ${nodes.length.toLocaleString()} graph vertices · ${edges.length.toLocaleString()} ways-segments (${dropped.toLocaleString()} refs outside the bbox)`);
if (nodes.length === 0) { console.error("✗ Nothing inside BAY_BOUNDS — wrong extract?"); process.exit(1); }

const graph = buildWalkGraph(nodes, edges);
const buf = encodeWalkGraph(graph);
const dictBytes = new TextEncoder().encode(JSON.stringify(graph.nameDict)).length;
const layout = walkGraphLayout(graph.nodeCount, graph.edgeCount, dictBytes);

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const id = `walk-bay-${stamp}.bin`;
const outDir = args.out ? resolve(ROOT, args.out) : OUT_DIR;
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, id);
writeFileSync(outPath, Buffer.from(buf));

log("\n── measured output ─────────────────────────────────────────────");
log(`  nodes            ${graph.nodeCount.toLocaleString()}`);
log(`  directed arcs    ${graph.edgeCount.toLocaleString()}`);
log(`  street names     ${graph.nameDict.length.toLocaleString()}`);
log(`  coords   (i32)   ${fmtBytes(8 * graph.nodeCount)}`);
log(`  elevation(u16)   ${fmtBytes(2 * graph.nodeCount)}`);
log(`  offsets  (u32)   ${fmtBytes(4 * (graph.nodeCount + 1))}`);
log(`  targets  (u32)   ${fmtBytes(4 * graph.edgeCount)}`);
log(`  cost     (u16)   ${fmtBytes(2 * graph.edgeCount)}`);
log(`  flags    (u8)    ${fmtBytes(graph.edgeCount)}`);
log(`  names    (u32)   ${fmtBytes(4 * graph.edgeCount)}`);
log(`  name dict        ${fmtBytes(dictBytes)}`);
log(`  ─────────────────────────────────────`);
log(`  ${id}  ${fmtBytes(layout.total)}`);
log(`  on disk          ${fmtBytes(statSync(outPath).size)}  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
log("────────────────────────────────────────────────────────────────");

if (args.upload) {
  execFileSync("npx", ["wrangler", "r2", "object", "put", `thebay-tiles/packs/${id}`, "--file", outPath, "--remote"], { stdio: "inherit" });
  log("\n✓ uploaded. GET /api/maps/packs now reports this real size.");
} else {
  log(`\nTo publish:\n  npx wrangler r2 object put thebay-tiles/packs/${id} --file ${outPath} --remote`);
}
