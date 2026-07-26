import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, makeTestEnv, call, login, type TestApp } from "./helpers/app";
import { routeFactories } from "../src/worker/routes";
import { Hono } from "hono";
import { encode } from "../src/core/geohash";

const SF = { lat: 37.7749, lng: -122.4194 };
const SJ = { lat: 37.3382, lng: -121.8863 };
const LA = { lat: 34.0522, lng: -118.2437 };
const cellOf = (p: { lat: number; lng: number }) => encode(p.lat, p.lng, 6);

let t: TestApp;
beforeEach(() => {
  t = makeTestApp();
});

describe("POST /api/shadows — auth + Bay gate + validation", () => {
  it("requires auth", async () => {
    const r = await call(t, "/api/shadows", { method: "POST", body: { ...SF, kind: "thought", body: "gm" } });
    expect(r.status).toBe(401);
  });

  it("rejects a post from outside the Bay (403)", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    const r = await call(t, "/api/shadows", { method: "POST", cookie, body: { ...LA, kind: "thought", body: "from LA" } });
    expect(r.status).toBe(403);
  });

  it("rejects a thought with no body, and a photo with no media (400)", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    expect((await call(t, "/api/shadows", { method: "POST", cookie, body: { ...SF, kind: "thought", body: "   " } })).status).toBe(400);
    expect((await call(t, "/api/shadows", { method: "POST", cookie, body: { ...SF, kind: "photo" } })).status).toBe(400);
  });

  it("casts a valid thought and reads it back by cell", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    const posted = await call(t, "/api/shadows", { method: "POST", cookie, body: { ...SF, kind: "thought", body: "anyone at the infra dinner?" } });
    expect(posted.status).toBe(200);
    expect(posted.json.ok).toBe(true);
    expect(posted.json.cell).toBe(cellOf(SF));
    expect(posted.json.replaced).toBeNull();
    expect(typeof posted.json.expiresAt).toBe("string");

    const read = await call(t, `/api/shadows?cells=${cellOf(SF)}`);
    expect(read.status).toBe(200);
    expect(read.json.shadows.length).toBe(1);
    expect(read.json.shadows[0]).toMatchObject({ kind: "thought", body: "anyone at the infra dinner?" });
    expect(read.json.shadows[0].author.displayName).toBe("Ann");
  });
});

describe("1-per-account — a new shadow replaces the old", () => {
  it("evicts the previous shadow and reports what it replaced", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    const first = await call(t, "/api/shadows", { method: "POST", cookie, body: { ...SF, kind: "thought", body: "first" } });
    const second = await call(t, "/api/shadows", { method: "POST", cookie, body: { ...SJ, kind: "thought", body: "second" } });
    expect(second.json.replaced.id).toBe(first.json.id);
    expect(second.json.replaced.cell).toBe(cellOf(SF));
    // old cell is now empty, new cell has the one shadow
    expect((await call(t, `/api/shadows?cells=${cellOf(SF)}`)).json.shadows.length).toBe(0);
    expect((await call(t, `/api/shadows?cells=${cellOf(SJ)}`)).json.shadows.length).toBe(1);
    // and /mine reflects the current one
    const mine = await call(t, "/api/shadows/mine", { cookie });
    expect(mine.json.active.id).toBe(second.json.id);
    expect(mine.json.active.cell).toBe(cellOf(SJ));
  });
});

describe("reactions (toggle), report (hide), delete (own only)", () => {
  it("adds and removes a reaction", async () => {
    const author = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");
    const posted = await call(t, "/api/shadows", { method: "POST", cookie: author.cookie, body: { ...SF, kind: "thought", body: "hi" } });
    const id = posted.json.id;
    expect((await call(t, `/api/shadows/${id}/react`, { method: "POST", cookie: bob.cookie, body: { emoji: "🔥" } })).status).toBe(200);
    let read = await call(t, `/api/shadows?cells=${cellOf(SF)}`);
    expect(read.json.shadows[0].reactions["🔥"]).toBe(1);
    await call(t, `/api/shadows/${id}/react`, { method: "POST", cookie: bob.cookie, body: { emoji: "🔥", on: false } });
    read = await call(t, `/api/shadows?cells=${cellOf(SF)}`);
    expect(read.json.shadows[0].reactions["🔥"]).toBeUndefined();
  });

  it("rejects an emoji outside the palette (400)", async () => {
    const author = await login(t, "ann@x.com", "Ann");
    const posted = await call(t, "/api/shadows", { method: "POST", cookie: author.cookie, body: { ...SF, kind: "thought", body: "hi" } });
    const r = await call(t, `/api/shadows/${posted.json.id}/react`, { method: "POST", cookie: author.cookie, body: { emoji: "💩" } });
    expect(r.status).toBe(400);
  });

  it("a report hides the shadow (pending re-audit)", async () => {
    const author = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");
    const posted = await call(t, "/api/shadows", { method: "POST", cookie: author.cookie, body: { ...SF, kind: "thought", body: "spam" } });
    expect((await call(t, `/api/shadows/${posted.json.id}/report`, { method: "POST", cookie: bob.cookie })).status).toBe(200);
    expect((await call(t, `/api/shadows?cells=${cellOf(SF)}`)).json.shadows.length).toBe(0);
  });

  it("only the author can delete their shadow", async () => {
    const author = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");
    const posted = await call(t, "/api/shadows", { method: "POST", cookie: author.cookie, body: { ...SF, kind: "thought", body: "mine" } });
    const id = posted.json.id;
    expect((await call(t, `/api/shadows/${id}`, { method: "DELETE", cookie: bob.cookie })).json.deleted).toBe(false);
    expect((await call(t, `/api/shadows/${id}`, { method: "DELETE", cookie: author.cookie })).json.deleted).toBe(true);
    expect((await call(t, `/api/shadows?cells=${cellOf(SF)}`)).json.shadows.length).toBe(0);
  });
});

describe("connection shadows require a real person", () => {
  it("rejects an unknown connectionUserId (400) and accepts a real one", async () => {
    const author = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");
    expect(
      (await call(t, "/api/shadows", { method: "POST", cookie: author.cookie, body: { ...SF, kind: "connection", connectionUserId: "nope" } })).status,
    ).toBe(400);
    const ok = await call(t, "/api/shadows", { method: "POST", cookie: author.cookie, body: { ...SF, kind: "connection", connectionUserId: bob.user.id, body: "met bob" } });
    expect(ok.status).toBe(200);
    expect((await call(t, `/api/shadows?cells=${cellOf(SF)}`)).json.shadows[0].connectionUserId).toBe(bob.user.id);
  });
});

describe("moderation", () => {
  it("hard-screens a clear threat on post (422) and never persists it", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    const r = await call(t, "/api/shadows", { method: "POST", cookie, body: { ...SF, kind: "thought", body: "kill yourself" } });
    expect(r.status).toBe(422);
    expect((await call(t, `/api/shadows?cells=${cellOf(SF)}`)).json.shadows.length).toBe(0);
  });

  it("the async LLM audit retracts a shadow the model blocks", async () => {
    // A test app with a fake Workers-AI binding that blocks, plus a real
    // ExecutionContext so we can drain the post-response audit deterministically.
    const { env, d1 } = makeTestEnv({ AI: { run: async () => ({ response: '{"allow": false, "reason": "targeted hate"}' }) } });
    const app = new Hono<any>();
    for (const make of routeFactories) app.route("/", make());
    const tasks: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p), passThroughOnException() {} };

    const fetchCtx = async (path: string, opts: any = {}) => {
      const headers: Record<string, string> = { ...(opts.headers || {}) };
      if (opts.cookie) headers.cookie = opts.cookie;
      let body: any;
      if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
      const res = await app.fetch(new Request("http://test" + path, { method: opts.method || "GET", headers, body }), env, ctx as any);
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    };

    // dev-login
    const loginRes = await app.fetch(
      new Request("http://test/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ann@x.com", name: "Ann" }) }),
      env,
      ctx as any,
    );
    const cookie = (loginRes.headers.get("set-cookie") || "").split(";")[0]!;

    const posted = await fetchCtx("/api/shadows", { method: "POST", cookie, body: { ...SF, kind: "thought", body: "borderline text the model will block" } });
    expect(posted.status).toBe(200); // posts instantly (passes the hard-screen)
    await Promise.allSettled(tasks); // drain the async audit
    // the model blocked it → retracted from every future read
    expect((await fetchCtx(`/api/shadows?cells=${cellOf(SF)}`)).json.shadows.length).toBe(0);
    const row = d1 && (await d1.prepare("SELECT mod_status, mod_reason FROM shadows WHERE id=?").bind(posted.json.id).first());
    expect(row.mod_status).toBe("blocked");
    expect(row.mod_reason).toBe("targeted hate");
  });
});

describe("POST /api/shadows/media — ephemeral rich-content upload", () => {
  it("stores a photo to R2 and the key round-trips into a photo shadow", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const up = await call(t, "/api/shadows/media?kind=photo", { method: "POST", cookie, raw: png, headers: { "content-type": "image/png" } });
    expect(up.status).toBe(200);
    expect(up.json.mediaKey).toMatch(/^shadows\//);
    const posted = await call(t, "/api/shadows", { method: "POST", cookie, body: { ...SF, kind: "photo", mediaKey: up.json.mediaKey, body: "sunset at the hackathon" } });
    expect(posted.status).toBe(200);
    const read = await call(t, `/api/shadows?cells=${cellOf(SF)}`);
    expect(read.json.shadows[0]).toMatchObject({ kind: "photo", mediaKey: up.json.mediaKey });
  });

  it("rejects a wrong content-type, an unknown kind, and video when unconfigured", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    expect((await call(t, "/api/shadows/media?kind=photo", { method: "POST", cookie, raw: new Uint8Array([1]), headers: { "content-type": "text/plain" } })).status).toBe(400);
    expect((await call(t, "/api/shadows/media?kind=bogus", { method: "POST", cookie, raw: new Uint8Array([1]), headers: { "content-type": "image/png" } })).status).toBe(400);
    expect((await call(t, "/api/shadows/media?kind=video", { method: "POST", cookie, raw: new Uint8Array([1]), headers: { "content-type": "video/mp4" } })).status).toBe(503);
  });
});

describe("GET /api/shadows/heat — zoomed-out aggregate", () => {
  it("groups active shadows by coarse cell and is edge-cacheable", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");
    await call(t, "/api/shadows", { method: "POST", cookie: ann.cookie, body: { ...SF, kind: "thought", body: "sf" } });
    await call(t, "/api/shadows", { method: "POST", cookie: bob.cookie, body: { ...SJ, kind: "thought", body: "sj" } });
    const heat = await call(t, "/api/shadows/heat?precision=4");
    expect(heat.status).toBe(200);
    expect(heat.json.precision).toBe(4);
    const map = Object.fromEntries(heat.json.cells.map((h: any) => [h.cell, h.count]));
    expect(map[encode(SF.lat, SF.lng, 4)]).toBe(1);
    expect(map[encode(SJ.lat, SJ.lng, 4)]).toBe(1);
    expect(heat.res.headers.get("cache-control")).toContain("max-age");
  });
});
