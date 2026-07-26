/**
 * HTTP-level test harness: mounts the real Hono route factories against the D1
 * shim + in-memory KV/R2, so we can exercise routes end-to-end (auth, guards,
 * response shapes, the review-gate) the way a browser hits them — the coverage
 * layer between repo unit tests and Playwright.
 */
import { Hono } from "hono";
import { makeTestDb } from "./d1";
import { routeFactories } from "../../src/worker/routes";

/* eslint-disable @typescript-eslint/no-explicit-any */
function memoryKV() {
  const m = new Map<string, string>();
  return {
    async get(k: string) { return m.has(k) ? m.get(k)! : null; },
    async put(k: string, v: string) { m.set(k, v); },
    async delete(k: string) { m.delete(k); },
    _map: m,
  } as any;
}
/** In-memory R2 double. Implements the slice of the API our routes actually use:
 *  put/get/delete plus `head`, `list` and — crucially — RANGED `get`, without which
 *  a test of the map-pack route would pass while production served whole packs. */
function memoryR2() {
  const m = new Map<string, any>();
  // Bodies arrive as ArrayBuffer | Uint8Array | string; normalise so ranges can slice.
  const bytesOf = (v: any): Uint8Array | null => {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (typeof v === "string") return new TextEncoder().encode(v);
    return null;
  };
  const meta = (k: string, o: any) => ({
    key: k, size: o.size, etag: o.etag, httpEtag: `"${o.etag}"`, uploaded: o.uploaded, httpMetadata: o.httpMetadata,
  });
  let seq = 0;
  return {
    async put(k: string, v: any, opts?: any) {
      const b = bytesOf(v);
      m.set(k, { body: v, bytes: b, size: b ? b.byteLength : 0, etag: `e${++seq}`, uploaded: new Date("2026-07-26T08:00:00Z"), httpMetadata: opts?.httpMetadata });
    },
    async get(k: string, opts?: any) {
      const o = m.get(k);
      if (!o) return null;
      const r = opts?.range;
      if (r && o.bytes) {
        const slice = o.bytes.subarray(r.offset, r.offset + r.length);
        return { ...meta(k, o), body: slice, range: r };
      }
      return { ...meta(k, o), body: o.body };
    },
    async head(k: string) { const o = m.get(k); return o ? meta(k, o) : null; },
    async list(opts?: any) {
      const prefix = opts?.prefix ?? "";
      return { objects: [...m.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, o]) => meta(k, o)), truncated: false, delimitedPrefixes: [] };
    },
    async delete(k: string) { m.delete(k); },
    _map: m,
  } as any;
}

export interface TestApp {
  app: Hono<any>;
  env: any;
  raw: import("better-sqlite3").Database;
  d1: any;
}

/** A full test Env (D1 shim + in-memory KV/R2 + stubs). Exported so tests can also
 *  drive the REAL Worker app (middleware, onError, admin routes), not just routes. */
export function makeTestEnv(overrides: Record<string, any> = {}) {
  const { d1, raw } = makeTestDb();
  // The ASSETS stub RECORDS what was asked for. A stub that returns a constant
  // can't tell "served the events shell" from "served the news shell" — exactly
  // the bug class that host/SPA routing produces, and it fails silently with a
  // 200. Assert on assetLog instead of on the body.
  const assetLog: string[] = [];
  const env = {
    DB: d1,
    SESSIONS: memoryKV(),
    OAUTH_STATE: memoryKV(),
    PHOTOS: memoryR2(),
    TILES: memoryR2(), // offline map packs (PMTiles basemap + walk graph)
    GROUP_ROOM: {} as any,
    ASSETS: {
      fetch: async (r: Request) => {
        const p = new URL(typeof r === "string" ? r : r.url).pathname;
        assetLog.push(p);
        return new Response(`<!doctype html>asset:${p}`, { status: 200, headers: { "content-type": "text/html" } });
      },
    },
    DEV_LOGIN: "1",
    ...overrides,
  };
  return { env, d1, raw, assetLog };
}

export function makeTestApp(overrides: Record<string, any> = {}): TestApp {
  const { env, d1, raw } = makeTestEnv(overrides);
  // Mount EXACTLY the same route registry the Worker uses — a new route added to
  // routeFactories is automatically covered by every integration test. No drift.
  const app = new Hono<any>();
  for (const make of routeFactories) app.route("/", make());
  return { app, env, raw, d1 };
}

export interface ReqOpts { method?: string; cookie?: string; body?: any; raw?: any; headers?: Record<string, string> }

/** Fire a request at the test app. Returns { status, json, res }. */
export async function call(t: TestApp, path: string, opts: ReqOpts = {}): Promise<{ status: number; json: any; res: Response }> {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: any = opts.raw;
  if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
  const res = await t.app.fetch(new Request("http://test" + path, { method: opts.method || "GET", headers, body }), t.env);
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res };
}

/** Dev-login and return a reusable session cookie + the user object. */
export async function login(t: TestApp, email = "u@test.com", name = "User"): Promise<{ cookie: string; user: any }> {
  const res = await t.app.fetch(
    new Request("http://test/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, name }) }),
    t.env,
  );
  const setCookie = res.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0]!; // bay_session=<token>
  const body: any = await res.json();
  return { cookie, user: body.user };
}
