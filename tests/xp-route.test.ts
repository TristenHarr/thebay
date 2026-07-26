import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { XpRepo } from "../src/storage/d1/xp-repo";

let t: TestApp;
beforeEach(() => {
  t = makeTestApp();
});

describe("GET /api/me/xp", () => {
  it("requires auth", async () => {
    expect((await call(t, "/api/me/xp")).status).toBe(401);
  });

  it("reports level, progress, and the XP breakdown", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const xp = new XpRepo(t.d1);
    await xp.grant(ann.user.id, "orb", 120, `orb:${ann.user.id}:1`);
    await xp.grant(ann.user.id, "movement", 40, `mv:${ann.user.id}:1`);
    const r = await call(t, "/api/me/xp", { cookie: ann.cookie });
    expect(r.status).toBe(200);
    expect(r.json.xp).toBe(160);
    expect(r.json.level).toBe(2); // 100..400
    expect(Object.fromEntries(r.json.breakdown.map((b: any) => [b.kind, b.xp]))).toEqual({ orb: 120, movement: 40 });
  });
});

describe("GET /api/xp/leaderboard", () => {
  it("ranks by total XP, or by a single kind", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");
    const xp = new XpRepo(t.d1);
    await xp.grant(ann.user.id, "movement", 100, `mv:${ann.user.id}:1`);
    await xp.grant(bob.user.id, "orb", 300, `orb:${bob.user.id}:1`);
    const total = await call(t, "/api/xp/leaderboard");
    expect(total.json.rows[0].handle).toBe(bob.user.handle); // 300 > 100
    const movement = await call(t, "/api/xp/leaderboard?metric=movement");
    expect(movement.json.rows.map((r: any) => r.handle)).toEqual([ann.user.handle]); // only ann has movement
  });
});
