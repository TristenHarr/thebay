import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { encode } from "../src/core/geohash";

const SF = { lat: 37.7749, lng: -122.4194 };
let t: TestApp;
beforeEach(() => {
  t = makeTestApp();
});

describe("POST /api/movement/ping — mobbing", () => {
  it("requires auth and the Bay gate", async () => {
    expect((await call(t, "/api/movement/ping", { method: "POST", body: { ...SF } })).status).toBe(401);
    const ann = await login(t, "ann@x.com", "Ann");
    expect((await call(t, "/api/movement/ping", { method: "POST", cookie: ann.cookie, body: { lat: 34.05, lng: -118.24 } })).status).toBe(403); // LA
  });

  it("first ping earns nothing; moving earns XP and reports your level", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const p1 = await call(t, "/api/movement/ping", { method: "POST", cookie: ann.cookie, body: { ...SF } });
    expect(p1.status).toBe(200);
    expect(p1.json.xp).toBe(0);
    expect(p1.json.level.level).toBe(1);
    const p2 = await call(t, "/api/movement/ping", { method: "POST", cookie: ann.cookie, body: { lat: 37.7849, lng: -122.4194 } }); // ~1.1km north
    expect(p2.json.dist).toBeGreaterThan(500);
    expect(p2.json.xp).toBeGreaterThan(0);
  });
});

describe("trail + living map + admin tracker", () => {
  it("returns your trail and the anonymized live dots", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    await call(t, "/api/movement/ping", { method: "POST", cookie: ann.cookie, body: { ...SF, scope: "public" } });
    const trail = await call(t, "/api/movement/trail", { cookie: ann.cookie });
    expect(trail.json.trail.length).toBe(1);
    const live = await call(t, `/api/movement/live?cells=${encode(SF.lat, SF.lng, 6)}`);
    expect(live.status).toBe(200);
    expect(live.json.dots.length).toBe(1); // ann's fresh public ping
    expect(live.json.dots[0]).not.toHaveProperty("userId"); // anonymized
  });

  it("the admin tracker is admin-only (404 for everyone else)", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    expect((await call(t, "/api/admin/movement", { cookie: ann.cookie })).status).toBe(404);
  });
});
