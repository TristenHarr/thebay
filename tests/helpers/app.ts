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
function memoryR2() {
  const m = new Map<string, any>();
  return {
    async put(k: string, v: any, opts?: any) { m.set(k, { body: v, httpMetadata: opts?.httpMetadata }); },
    async get(k: string) { const o = m.get(k); return o ? { body: o.body, httpMetadata: o.httpMetadata } : null; },
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
  const env = {
    DB: d1,
    SESSIONS: memoryKV(),
    OAUTH_STATE: memoryKV(),
    PHOTOS: memoryR2(),
    GROUP_ROOM: {} as any,
    ASSETS: { fetch: async () => new Response("<!doctype html>asset", { status: 200, headers: { "content-type": "text/html" } }) },
    DEV_LOGIN: "1",
    ...overrides,
  };
  return { env, d1, raw };
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
