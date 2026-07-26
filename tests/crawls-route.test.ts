import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";

let t: TestApp;
const S0 = { name: "SHACK15", lat: 37.7749, lng: -122.4194 };
const S1 = { name: "Frontier Tower", lat: 37.7849, lng: -122.4194 };
beforeEach(() => {
  t = makeTestApp();
});

describe("founder crawls over HTTP", () => {
  it("create → list → join → walk it in order for XP", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");
    const created = await call(t, "/api/crawls", { method: "POST", cookie: ann.cookie, body: { name: "Dawn Patrol", stops: [S0, S1] } });
    expect(created.status).toBe(200);
    const id = created.json.id;

    expect((await call(t, "/api/crawls")).json.crawls.find((c: any) => c.id === id)).toMatchObject({ name: "Dawn Patrol", stops: 2 });
    expect((await call(t, `/api/crawls/${id}`)).json.stops.length).toBe(2);

    expect((await call(t, `/api/crawls/${id}/join`, { method: "POST", cookie: bob.cookie })).status).toBe(200);
    // out of order
    expect((await call(t, `/api/crawls/${id}/checkpoint`, { method: "POST", cookie: bob.cookie, body: { stopIdx: 1, ...S1 } })).json.status).toBe("out-of-order");
    // reach stop 0
    const c0 = await call(t, `/api/crawls/${id}/checkpoint`, { method: "POST", cookie: bob.cookie, body: { stopIdx: 0, ...S0 } });
    expect(c0.json.ok).toBe(true);
    expect(c0.json.xp).toBeGreaterThan(0);
    // finish
    const c1 = await call(t, `/api/crawls/${id}/checkpoint`, { method: "POST", cookie: bob.cookie, body: { stopIdx: 1, ...S1 } });
    expect(c1.json.finished).toBe(true);
    expect(c1.json.level.xp).toBeGreaterThan(c0.json.xp);
  });

  it("validates the plan (≥2 stops) and requires auth", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    expect((await call(t, "/api/crawls", { method: "POST", cookie: ann.cookie, body: { name: "x", stops: [S0] } })).status).toBe(400);
    expect((await call(t, "/api/crawls", { method: "POST", body: { name: "x", stops: [S0, S1] } })).status).toBe(401);
  });
});
