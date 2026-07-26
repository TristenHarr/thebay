import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";

let t: TestApp;
beforeEach(() => {
  t = makeTestApp();
});

describe("catches — the founder Pokédex over HTTP", () => {
  it("scan your QR → I catch you, earn XP, and you're in my Pokédex", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");
    // Bob shows his catch QR
    const tok = await call(t, "/api/catches/token", { method: "POST", cookie: bob.cookie });
    expect(tok.json.token).toBeTruthy();
    // Ann scans it
    const scan = await call(t, "/api/catches/scan", { method: "POST", cookie: ann.cookie, body: { token: tok.json.token } });
    expect(scan.status).toBe(200);
    expect(scan.json.ok).toBe(true);
    expect(scan.json.caught.displayName).toBe("Bob");
    expect(scan.json.caught.stats.rarity).toBeTruthy();
    expect(scan.json.xp).toBeGreaterThan(0);
    expect(scan.json.level.xp).toBe(scan.json.xp);
    // Bob is now in Ann's Pokédex
    const dex = await call(t, "/api/catches", { cookie: ann.cookie });
    expect(dex.json.pokedex.map((c: any) => c.handle)).toContain(bob.user.handle);
  });

  it("can't catch yourself; a used pair dedups; junk 404s; auth required", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");
    const selfTok = await call(t, "/api/catches/token", { method: "POST", cookie: bob.cookie });
    expect((await call(t, "/api/catches/scan", { method: "POST", cookie: bob.cookie, body: { token: selfTok.json.token } })).json.reason).toBe("self");
    await call(t, "/api/catches/scan", { method: "POST", cookie: ann.cookie, body: { token: (await call(t, "/api/catches/token", { method: "POST", cookie: bob.cookie })).json.token } });
    const again = await call(t, "/api/catches/scan", { method: "POST", cookie: ann.cookie, body: { token: (await call(t, "/api/catches/token", { method: "POST", cookie: bob.cookie })).json.token } });
    expect(again.json.reason).toBe("already");
    expect((await call(t, "/api/catches/scan", { method: "POST", cookie: ann.cookie, body: { token: "garbagegarbage" } })).status).toBe(404);
    expect((await call(t, "/api/catches/token", { method: "POST" })).status).toBe(401);
  });

  it("serves your own founder card", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const r = await call(t, "/api/me/stats", { cookie: ann.cookie });
    expect(r.status).toBe(200);
    expect(r.json.stats).toHaveProperty("power");
    expect(r.json.stats).toHaveProperty("rarity");
  });
});
