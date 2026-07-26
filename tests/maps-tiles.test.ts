import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestApp, call, type TestApp } from "./helpers/app";
import { parseRangeHeader, contentRange } from "../src/core/maps/range";

/** 4 KB of deterministic bytes so range slices are checkable. */
const PACK = new Uint8Array(4096).map((_, i) => i & 0xff);
const PACK_ID = "bay-z15-20260726.pmtiles"; // the planet build tops out at z15 (measured)

let t: TestApp;
beforeEach(async () => {
  t = makeTestApp();
  await t.env.TILES.put(`packs/${PACK_ID}`, PACK.buffer.slice(0), { httpMetadata: { contentType: "application/vnd.pmtiles" } });
});

/** Binary-safe request — `call()` drains the body as text, which corrupts a tile. */
async function get(app: TestApp, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.app.fetch(new Request("http://test" + path, { headers }), app.env);
}
async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

describe("Range header parsing (pure)", () => {
  it("parses the three RFC 9110 forms", () => {
    expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ kind: "range", offset: 0, length: 100 });
    expect(parseRangeHeader("bytes=100-", 1000)).toEqual({ kind: "range", offset: 100, length: 900 });
    expect(parseRangeHeader("bytes=-50", 1000)).toEqual({ kind: "range", offset: 950, length: 50 });
  });

  it("clamps an end past EOF and treats no/odd headers as a full body", () => {
    expect(parseRangeHeader("bytes=990-5000", 1000)).toEqual({ kind: "range", offset: 990, length: 10 });
    expect(parseRangeHeader(null, 1000)).toEqual({ kind: "none" });
    expect(parseRangeHeader("items=0-1", 1000)).toEqual({ kind: "none" });
    expect(parseRangeHeader("bytes=0-1,5-6", 1000)).toEqual({ kind: "none" }); // multipart: serve whole
  });

  it("flags unsatisfiable and malformed ranges", () => {
    expect(parseRangeHeader("bytes=1000-1200", 1000).kind).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=-0", 1000).kind).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=50-10", 1000).kind).toBe("invalid");
    expect(parseRangeHeader("bytes=abc-def", 1000).kind).toBe("invalid");
    expect(parseRangeHeader("bytes=0-99", 0).kind).toBe("unsatisfiable");
  });

  it("formats content-range", () => {
    expect(contentRange(0, 100, 1000)).toBe("bytes 0-99/1000");
    expect(contentRange(950, 50, 1000)).toBe("bytes 950-999/1000");
  });
});

describe("GET /tiles/:pack", () => {
  it("serves the whole pack with accept-ranges + immutable caching", async () => {
    const res = await get(t, `/tiles/${PACK_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("4096");
    expect(res.headers.get("cache-control")).toMatch(/immutable/);
    expect(res.headers.get("etag")).toBeTruthy();
    expect((await bytesOf(res)).length).toBe(4096);
  });

  it("answers a Range request with 206 and exactly the requested bytes", async () => {
    const res = await get(t, `/tiles/${PACK_ID}`, { range: "bytes=127-254" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 127-254/4096");
    expect(res.headers.get("content-length")).toBe("128");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const body = await bytesOf(res);
    expect(body.length).toBe(128);
    expect(body[0]).toBe(127 & 0xff);
    expect(body[127]).toBe(254 & 0xff);
  });

  it("supports an open-ended and a suffix range (what a PMTiles client actually sends)", async () => {
    const head = await get(t, `/tiles/${PACK_ID}`, { range: "bytes=0-126" });
    expect(head.status).toBe(206);
    expect((await bytesOf(head)).length).toBe(127); // the PMTiles v3 header

    const tail = await get(t, `/tiles/${PACK_ID}`, { range: "bytes=-16" });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe("bytes 4080-4095/4096");
  });

  it("416s an unsatisfiable range and 400s a malformed one", async () => {
    const over = await call(t, `/tiles/${PACK_ID}`, { headers: { range: "bytes=9999-" } });
    expect(over.status).toBe(416);
    expect(over.res.headers.get("content-range")).toBe("bytes */4096");
    expect((await call(t, `/tiles/${PACK_ID}`, { headers: { range: "bytes=50-10" } })).status).toBe(400);
  });

  it("404s a missing object and a missing TILES binding — never throws", async () => {
    expect((await call(t, "/tiles/nope.pmtiles")).status).toBe(404);
    const noBinding = makeTestApp({ TILES: undefined });
    expect((await call(noBinding, `/tiles/${PACK_ID}`)).status).toBe(404);
    expect((await call(noBinding, `/tiles/${PACK_ID}`, { headers: { range: "bytes=0-10" } })).status).toBe(404);
  });

  it("rejects a traversal-shaped pack id", async () => {
    expect((await call(t, "/tiles/..%2F..%2Fsecrets")).status).toBe(400);
    expect((await call(t, "/tiles/a b.pmtiles")).status).toBe(400);
  });
});

describe("GET /api/maps/packs", () => {
  it("reports the REAL byte size from R2 (never a guess)", async () => {
    const { status, json } = await call(t, "/api/maps/packs");
    expect(status).toBe(200);
    expect(json.available).toBe(true);
    const pack = json.packs.find((p: any) => p.id === PACK_ID);
    expect(pack).toBeTruthy();
    expect(pack.bytes).toBe(4096);
    expect(pack.url).toBe(`/tiles/${PACK_ID}`);
    expect(pack.kind).toBe("basemap");
    expect(typeof pack.etag).toBe("string");
  });

  it("classifies the walking graph pack and sorts packs by id", async () => {
    await t.env.TILES.put("packs/walk-bay-20260726.bin", new Uint8Array(10).buffer);
    const { json } = await call(t, "/api/maps/packs");
    expect(json.packs.map((p: any) => p.id)).toEqual([PACK_ID, "walk-bay-20260726.bin"].sort());
    expect(json.packs.find((p: any) => p.id.startsWith("walk-")).kind).toBe("walk-graph");
  });

  it("degrades to an empty manifest with no TILES binding (no 500)", async () => {
    const { status, json } = await call(makeTestApp({ TILES: undefined }), "/api/maps/packs");
    expect(status).toBe(200);
    expect(json).toEqual({ available: false, packs: [] });
  });
});

describe("edge cache fronting", () => {
  const realCaches = (globalThis as any).caches;
  afterEach(() => { (globalThis as any).caches = realCaches; });

  it("stores a range slice and replays it as a 206 on the next hit", async () => {
    const store = new Map<string, Response>();
    let puts = 0;
    (globalThis as any).caches = {
      default: {
        async match(req: Request) { const hit = store.get(req.url); return hit ? hit.clone() : undefined; },
        async put(req: Request, res: Response) { puts++; store.set(req.url, res); },
      },
    };
    const first = await get(t, `/tiles/${PACK_ID}`, { range: "bytes=10-19" });
    expect(first.status).toBe(206);
    expect(Array.from(await bytesOf(first))).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(puts).toBe(1);

    const second = await get(t, `/tiles/${PACK_ID}`, { range: "bytes=10-19" });
    expect(second.status).toBe(206);
    expect(second.headers.get("content-range")).toBe("bytes 10-19/4096");
    expect(second.headers.get("x-tile-cache")).toBe("hit");
    expect(Array.from(await bytesOf(second))).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(puts).toBe(1); // served from cache, not re-stored
  });
});

describe("through the REAL Worker app (global middleware + harden)", () => {
  it("keeps 206 status, content-range and the body intact after hardening", async () => {
    // harden() mutates/rebuilds every response. A Range reply is the one shape
    // where that can quietly turn into a 200 with the wrong body, so assert it
    // against the actual Worker export rather than the route factory alone.
    const worker = (await import("../src/worker/index")).default;
    const { makeTestEnv } = await import("./helpers/app");
    const { env } = makeTestEnv();
    await env.TILES.put(`packs/${PACK_ID}`, PACK.buffer.slice(0));

    const res = await worker.fetch(
      new Request(`https://thebay.events/tiles/${PACK_ID}`, { headers: { range: "bytes=1000-1015" } }),
      env as any,
      { waitUntil() {}, passThroughOnException() {} } as any,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 1000-1015/4096");
    expect(res.headers.get("strict-transport-security")).toBeTruthy(); // hardened
    expect(res.headers.get("cache-control")).toMatch(/immutable/);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(16);
    expect(body[0]).toBe(1000 & 0xff);

    // …and the manifest survives the API CORS + hardening layers too
    const manifest = await worker.fetch(new Request("https://thebay.events/api/maps/packs"), env as any, { waitUntil() {}, passThroughOnException() {} } as any);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("access-control-allow-origin")).toBe("*");
    expect((await manifest.json() as any).packs[0].bytes).toBe(4096);
  });
});
