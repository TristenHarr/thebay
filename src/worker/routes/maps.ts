import { Hono } from "hono";
import type { R2Bucket, R2Object, R2ObjectBody } from "@cloudflare/workers-types";
import type { Env, Vars } from "../env";
import { parseRangeHeader, contentRange } from "../../core/maps/range";

/**
 * Offline map packs — the PMTiles vector basemap and the pedestrian routing graph,
 * both served straight out of R2 with HTTP Range.
 *
 * Range is the whole point. The Bay basemap is one multi-hundred-megabyte object;
 * the ONLINE map streams individual tiles out of it with byte-range reads, and the
 * OFFLINE download pulls the exact same object in resumable chunks. One artefact,
 * one URL, no tile server. R2 has no egress fees, which is the only reason
 * self-hosting a pack this size is affordable at all.
 *
 * Routes are thin by house rule: range arithmetic is pure and lives in
 * `src/core/maps/range.ts`, which is where it's exhaustively tested.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;

/** All packs live under this prefix so `list` is a manifest and nothing else leaks. */
export const PACK_PREFIX = "packs/";
/** Pack ids are immutable + date-stamped (`bay-z16-20260726.pmtiles`) — that's what
 *  makes `immutable` caching and the range-keyed edge cache safe. */
const PACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const IMMUTABLE = "public, max-age=31536000, immutable";

export type PackKind = "basemap" | "walk-graph" | "other";
export function packKind(id: string): PackKind {
  if (id.endsWith(".pmtiles")) return "basemap";
  if (id.startsWith("walk-")) return "walk-graph";
  return "other";
}
function contentTypeFor(id: string): string {
  if (id.endsWith(".pmtiles")) return "application/vnd.pmtiles";
  if (id.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

/** R2 exposes `httpEtag` (quoted, ready for a header) on Workers; the local test
 *  double only has `etag`. Accept either rather than special-casing the stub. */
function etagOf(obj: { httpEtag?: string; etag?: string }): string {
  const raw = obj.httpEtag ?? obj.etag ?? "";
  if (!raw) return "";
  return raw.startsWith('"') ? raw : `"${raw}"`;
}

/** Cache-API key for a range slice. Cloudflare's Cache API refuses to `put` a 206,
 *  so we fold the range into the key, store the slice as a 200 that keeps its
 *  `content-range`, and rebuild the 206 on the way out. Safe because pack ids are
 *  immutable — a rebuilt pack gets a new id and therefore new keys. */
function sliceKey(reqUrl: string, pack: string, offset: number, length: number): Request {
  const u = new URL(reqUrl);
  u.pathname = `/__packslice/${pack}`;
  u.search = `?o=${offset}&l=${length}`;
  return new Request(u.toString(), { method: "GET" });
}

/** The slice of the Cache API we use. Absent under Node (tests) — the route must
 *  work either way, so this returns null rather than assuming a Workers runtime. */
interface EdgeCache {
  match(r: Request): Promise<Response | undefined>;
  put(r: Request, res: Response): Promise<void>;
}
function edgeCache(): EdgeCache | null {
  return (globalThis as { caches?: { default?: EdgeCache } }).caches?.default ?? null;
}

export function mapsRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  /**
   * The pack manifest. The UI shows the REAL size from R2 here — never a build-time
   * guess — because "Download the Bay (412 MB)" is a promise about the user's data
   * plan and their phone's remaining storage.
   */
  app.get("/api/maps/packs", async (c) => {
    const bucket = c.env.TILES as R2Bucket | undefined;
    if (!bucket || typeof bucket.list !== "function") return c.json({ available: false, packs: [] });
    const listing = await bucket.list({ prefix: PACK_PREFIX }).catch(() => null);
    if (!listing) return c.json({ available: false, packs: [] });
    const packs = listing.objects
      .map((o: R2Object) => {
        const id = o.key.slice(PACK_PREFIX.length);
        return {
          id,
          kind: packKind(id),
          bytes: o.size,
          etag: etagOf(o),
          builtAt: o.uploaded instanceof Date ? o.uploaded.toISOString() : (o.uploaded ?? null),
          url: `/tiles/${id}`,
        };
      })
      .filter((p) => p.id.length > 0)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return c.json({ available: true, packs });
  });

  /**
   * Byte-range reads over a pack. 200 for the whole object, 206 for a slice,
   * 416 for a range past EOF, 400 for a malformed one, 404 for a missing object
   * OR a missing TILES binding — never a throw, because the map component asks
   * for tiles constantly and a 500 storm is indistinguishable from an outage.
   */
  app.get("/tiles/:pack", async (c) => {
    const pack = c.req.param("pack");
    if (!PACK_ID.test(pack) || pack.includes("..")) return c.text("bad pack id", 400);
    const bucket = c.env.TILES as R2Bucket | undefined;
    if (!bucket) return c.text("no pack store", 404);

    const head = (await bucket.head(`${PACK_PREFIX}${pack}`).catch(() => null)) as R2Object | null;
    if (!head) return c.notFound();
    const size = head.size;
    const etag = etagOf(head);
    const spec = parseRangeHeader(c.req.header("range"), size);
    if (spec.kind === "invalid") return c.text("malformed range", 400);
    if (spec.kind === "unsatisfiable") {
      return c.body(null, 416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes", etag });
    }

    const base: Record<string, string> = {
      "content-type": contentTypeFor(pack),
      "accept-ranges": "bytes",
      "cache-control": IMMUTABLE,
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "content-range, content-length, etag, accept-ranges",
    };
    if (etag) base.etag = etag;

    if (spec.kind === "none") {
      const obj = (await bucket.get(`${PACK_PREFIX}${pack}`).catch(() => null)) as R2ObjectBody | null;
      if (!obj) return c.notFound();
      return new Response(obj.body as unknown as ReadableStream, { status: 200, headers: { ...base, "content-length": String(size) } });
    }

    const { offset, length } = spec;
    const cache = edgeCache();
    const key = cache ? sliceKey(c.req.url, pack, offset, length) : null;
    if (cache && key) {
      const hit = await cache.match(key).catch(() => undefined);
      if (hit) return new Response(hit.body, { status: 206, headers: { ...Object.fromEntries(hit.headers), "x-tile-cache": "hit" } });
    }

    const obj = (await bucket.get(`${PACK_PREFIX}${pack}`, { range: { offset, length } }).catch(() => null)) as R2ObjectBody | null;
    if (!obj) return c.notFound();
    const headers = { ...base, "content-length": String(length), "content-range": contentRange(offset, length, size) };
    const res = new Response(obj.body as unknown as ReadableStream, { status: 206, headers });
    if (cache && key) {
      // Stored as a 200 (the Cache API rejects 206) but keeping content-range, so
      // the hit path above can rebuild an identical 206.
      const stored = new Response(res.clone().body, { status: 200, headers });
      let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
      try { ctx = c.executionCtx as unknown as { waitUntil(p: Promise<unknown>): void }; } catch { ctx = undefined; }
      const put = cache.put(key, stored).catch(() => undefined);
      if (ctx) ctx.waitUntil(put); else await put;
    }
    return res;
  });

  return app;
}
