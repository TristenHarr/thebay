import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
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
