/**
 * End-to-end test of `scripts/build-walk-graph.mjs` against a SYNTHETIC .osm.pbf
 * we encode right here.
 *
 * The script contains a hand-written OSM-PBF reader (protobuf varints, zlib blobs,
 * delta-coded DenseNodes, packed way refs). None of that is exercised by the pure
 * router tests, and the real input is a 600 MB Geofabrik download that has no
 * business in a unit suite — so we write ~40 nodes of valid PBF, run the real
 * script as a subprocess, and route on the pack it produces.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { decodeWalkGraph } from "../src/core/nav/format";
import { FLAG_STEPS, edgeName, nodeLat, type WalkGraph } from "../src/core/nav/graph";
import { route } from "../src/core/nav/router";
import { nearestNode } from "../src/core/nav/spatial";

/* ── a minimal protobuf writer (mirror of the reader in the script) ──────────*/
const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) { out.push((v % 128) + 0x80); v = Math.floor(v / 128); }
  out.push(v);
  return out;
};
const zigzag = (n: number) => (n < 0 ? -n * 2 - 1 : n * 2);
const tag = (field: number, wire: number) => varint(field * 8 + wire);
const lenDelim = (field: number, body: number[] | Uint8Array) => [...tag(field, 2), ...varint(body.length), ...body];
const packedS = (field: number, vals: number[]) => lenDelim(field, vals.flatMap((v) => varint(zigzag(v))));
const packedU = (field: number, vals: number[]) => lenDelim(field, vals.flatMap((v) => varint(v)));
const str = (s: string) => [...new TextEncoder().encode(s)];
const deltas = (vals: number[]) => vals.map((v, i) => (i === 0 ? v : v - vals[i - 1]!));

interface PbfNode { id: number; lat: number; lng: number }
interface PbfWay { refs: number[]; tags: Record<string, string> }

function encodePbf(nodes: PbfNode[], ways: PbfWay[]): Buffer {
  // string table: index 0 must be "" per the OSM spec
  const strings = [""];
  const sid = (s: string) => { let i = strings.indexOf(s); if (i < 0) { i = strings.length; strings.push(s); } return i; };
  const wayBodies = ways.map((w) => {
    const keys: number[] = [], vals: number[] = [];
    for (const [k, v] of Object.entries(w.tags)) { keys.push(sid(k)); vals.push(sid(v)); }
    return [
      ...tag(1, 0), ...varint(1), // Way.id (int64)
      ...packedU(2, keys), ...packedU(3, vals),
      ...packedS(8, deltas(w.refs)),
    ];
  });

  const dense = [
    ...packedS(1, deltas(nodes.map((n) => n.id))),
    ...packedS(8, deltas(nodes.map((n) => Math.round(n.lat * 1e7)))),
    ...packedS(9, deltas(nodes.map((n) => Math.round(n.lng * 1e7)))),
  ];
  const groups = [
    ...lenDelim(2, [...lenDelim(2, dense)].slice(0)), // PrimitiveGroup{ dense }
    ...lenDelim(2, wayBodies.flatMap((b) => lenDelim(3, b))), // PrimitiveGroup{ ways }
  ];
  const block = [
    ...lenDelim(1, strings.flatMap((s) => lenDelim(1, str(s)))), // StringTable
    ...groups,
    ...tag(17, 0), ...varint(100), // granularity
  ];

  const out: Buffer[] = [];
  const push = (type: string, payload: number[]) => {
    const raw = Buffer.from(payload);
    const z = deflateSync(raw);
    const blob = Buffer.from([...tag(2, 0), ...varint(raw.length), ...lenDelim(3, [...z])]);
    const header = Buffer.from([...lenDelim(1, str(type)), ...tag(3, 0), ...varint(blob.length)]);
    const len = Buffer.alloc(4);
    len.writeInt32BE(header.length, 0);
    out.push(len, header, blob);
  };
  // OSMHeader first (the script skips it, but a real file always has one)
  push("OSMHeader", [...lenDelim(4, str("OsmSchema-V0.6"))]);
  push("OSMData", block);
  return Buffer.concat(out);
}

/* ── the fixture: an L of footway + a flight of steps + an excluded motorway ─*/
const LAT0 = 37.7749, LNG0 = -122.4194;
const DLAT = 100 / 111_320;                                     // ~100 m north
const DLNG = 100 / (111_320 * Math.cos((LAT0 * Math.PI) / 180)); // ~100 m east

const nodes: PbfNode[] = [
  { id: 1001, lat: LAT0, lng: LNG0 },
  { id: 1002, lat: LAT0, lng: LNG0 + DLNG },
  { id: 1003, lat: LAT0, lng: LNG0 + 2 * DLNG },
  { id: 1004, lat: LAT0 + DLAT, lng: LNG0 + 2 * DLNG },
  { id: 1005, lat: LAT0 + DLAT, lng: LNG0 },      // the steps shortcut, top end
  { id: 1006, lat: 34.0522, lng: -118.2437 },     // Los Angeles — must be dropped
];
const ways: PbfWay[] = [
  { refs: [1001, 1002, 1003], tags: { highway: "footway", name: "Test Path", lit: "yes" } },
  { refs: [1003, 1004], tags: { highway: "residential", name: "Test Avenue" } },
  { refs: [1004, 1005], tags: { highway: "footway", name: "Upper Walk" } },
  { refs: [1001, 1005], tags: { highway: "steps", name: "Test Steps" } },
  { refs: [1001, 1002], tags: { highway: "motorway", name: "Freeway Nope" } },
  { refs: [1003, 1006], tags: { highway: "footway", name: "Teleport Way" } }, // leaves the bbox
];

let g: WalkGraph;
let stdout = "";
let packBytes = 0;

beforeAll(() => {
  const dir = mkdtempSync(resolve(tmpdir(), "walkgraph-"));
  const pbf = resolve(dir, "tiny.osm.pbf");
  writeFileSync(pbf, encodePbf(nodes, ways));
  stdout = execFileSync(
    resolve(process.cwd(), "node_modules/.bin/tsx"),
    [resolve(process.cwd(), "scripts/build-walk-graph.mjs"), `--pbf=${pbf}`, `--out=${dir}`, "--no-elevation"],
    { encoding: "utf8", cwd: process.cwd() },
  );
  const packName = readdirSync(dir).find((f) => f.startsWith("walk-bay-") && f.endsWith(".bin"))!;
  const buf = readFileSync(resolve(dir, packName));
  packBytes = buf.length;
  g = decodeWalkGraph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}, 120_000);

describe("scripts/build-walk-graph.mjs (real script, synthetic PBF)", () => {
  it("prints measured byte counts, never estimates", () => {
    expect(stdout).toMatch(/measured output/);
    expect(stdout).toMatch(/on disk\s+\d+/);
    expect(stdout).toMatch(/directed arcs\s+\d/);
    expect(packBytes).toBeGreaterThan(64);
  });

  it("keeps the walkable ways and drops the motorway", () => {
    expect(g.nameDict).toContain("Test Path");
    expect(g.nameDict).toContain("Test Steps");
    expect(g.nameDict).toContain("Test Avenue");
    expect(g.nameDict).not.toContain("Freeway Nope");
  });

  it("drops the out-of-bbox node so nothing routes to Los Angeles", () => {
    for (let i = 0; i < g.nodeCount; i++) expect(nodeLat(g, i)).toBeGreaterThan(36);
    expect(nearestNode(g, 34.0522, -118.2437, { maxMetres: 5000 })).toBe(-1);
  });

  it("collapses non-junction interior nodes into edge length", () => {
    // 1002 is interior to a single way ⇒ not a vertex. 1001/1003/1004/1005 are.
    expect(g.nodeCount).toBe(4);
    // …and the collapsed Test Path edge carries the full ~200 m
    const a = nearestNode(g, LAT0, LNG0)!;
    const b = nearestNode(g, LAT0, LNG0 + 2 * DLNG)!;
    const r = route(g, a, b)!;
    expect(r).not.toBeNull();
    expect(r.distanceM).toBeGreaterThan(195);
    expect(r.distanceM).toBeLessThan(215);
    expect(r.steps[0]!.street).toBe("Test Path");
  });

  it("tags the steps arc so avoid-stairs has something to avoid", () => {
    let stairArcs = 0, stairNames = new Set<string>();
    for (let e = 0; e < g.edgeCount; e++) if (g.flags[e]! & FLAG_STEPS) { stairArcs++; stairNames.add(edgeName(g, e)); }
    expect(stairArcs).toBe(2); // one way ⇒ two directed arcs
    expect([...stairNames]).toEqual(["Test Steps"]);
  });

  it("routes around the stairs when asked", () => {
    const bottom = nearestNode(g, LAT0, LNG0)!;
    const top = nearestNode(g, LAT0 + DLAT, LNG0)!;
    expect(route(g, bottom, top)!.stairs).toBe(1);
    const stepFree = route(g, bottom, top, { avoidStairs: true })!;
    expect(stepFree.stairs).toBe(0);
    expect(stepFree.distanceM).toBeGreaterThan(route(g, bottom, top)!.distanceM);
  });
});
