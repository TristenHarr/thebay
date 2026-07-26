import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { orbsForCell, epochFor } from "../src/core/xp/orbs";
import { encode } from "../src/core/geohash";

let t: TestApp;
const SF = { lat: 37.7749, lng: -122.4194 };
const cell = encode(SF.lat, SF.lng, 6);
beforeEach(() => {
  t = makeTestApp();
});

describe("GET /api/orbs", () => {
  it("returns the current-epoch orbs for the visible cells", async () => {
    const r = await call(t, `/api/orbs?cells=${cell}`);
    expect(r.status).toBe(200);
    expect(r.json.epoch).toBe(epochFor(Date.now()));
    expect(r.json.orbs.length).toBe(orbsForCell(cell, r.json.epoch).length);
  });
});

describe("POST /api/orbs/pickup", () => {
  it("grants XP when you're on top of an orb, and only once", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const orb = orbsForCell(cell, epochFor(Date.now()))[0]!;
    const first = await call(t, "/api/orbs/pickup", { method: "POST", cookie: ann.cookie, body: { orbId: orb.id, lat: orb.lat, lng: orb.lng } });
    expect(first.status).toBe(200);
    expect(first.json.ok).toBe(true);
    expect(first.json.xp).toBe(orb.xp);
    expect(first.json.level.xp).toBe(orb.xp);
    // second grab of the same orb → no double XP
    const second = await call(t, "/api/orbs/pickup", { method: "POST", cookie: ann.cookie, body: { orbId: orb.id, lat: orb.lat, lng: orb.lng } });
    expect(second.json.ok).toBe(false);
    expect(second.json.reason).toMatch(/already/);
    // and a picked orb drops out of the listing
    const list = await call(t, `/api/orbs?cells=${cell}`, { cookie: ann.cookie });
    expect(list.json.orbs.find((o: any) => o.id === orb.id)).toBeUndefined();
  });

  it("rejects a pickup from too far away, and an unknown orb", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const orb = orbsForCell(cell, epochFor(Date.now()))[0]!;
    const far = await call(t, "/api/orbs/pickup", { method: "POST", cookie: ann.cookie, body: { orbId: orb.id, lat: orb.lat + 0.02, lng: orb.lng } }); // ~2km away
    expect(far.json.ok).toBe(false);
    expect(far.json.reason).toBe("too far");
    // a malformed id can't be re-derived → 404
    expect((await call(t, "/api/orbs/pickup", { method: "POST", cookie: ann.cookie, body: { orbId: "garbage", lat: SF.lat, lng: SF.lng } })).status).toBe(404);
  });

  it("requires auth", async () => {
    const orb = orbsForCell(cell, epochFor(Date.now()))[0]!;
    expect((await call(t, "/api/orbs/pickup", { method: "POST", body: { orbId: orb.id, lat: orb.lat, lng: orb.lng } })).status).toBe(401);
  });
});
