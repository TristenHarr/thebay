import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { MovementRepo } from "../src/storage/d1/movement-repo";
import { XpRepo } from "../src/storage/d1/xp-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { DAILY_MOVEMENT_XP_CAP } from "../src/core/xp/movement";
import { encode } from "../src/core/geohash";

let d1: any, raw: Database.Database, move: MovementRepo, xp: XpRepo, social: SocialRepo;
beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  move = new MovementRepo(d1);
  xp = new XpRepo(d1);
  social = new SocialRepo(d1);
});
const mkUser = async (e: string) => (await social.upsertByIdentity({ provider: "dev", providerUid: e, email: e, displayName: e })).id;
// ~100m north of SF each step (0.0009° lat ≈ 100m)
const SF = { lat: 37.7749, lng: -122.4194 };
const north = (n: number) => ({ lat: SF.lat + 0.0009 * n, lng: SF.lng });
const T = (min: number) => new Date(Date.UTC(2026, 7, 1, 12, min, 0)).toISOString();

describe("MovementRepo.ping", () => {
  it("first ping earns nothing (no previous point), then movement earns XP", async () => {
    const ann = await mkUser("a@x.com");
    const first = await move.ping(ann, SF.lat, SF.lng, "public", T(0));
    expect(first.xp).toBe(0);
    expect(first.dist).toBe(0);
    const second = await move.ping(ann, north(1).lat, north(1).lng, "public", T(1)); // ~100m in 60s
    expect(second.dist).toBeGreaterThan(80);
    expect(second.dist).toBeLessThan(120);
    expect(second.xp).toBeGreaterThan(0);
    expect(second.flagged).toBe(false);
    // XP landed in the ledger too (so it counts toward the level)
    expect(await xp.total(ann)).toBe(second.xp);
  });

  it("enforces the daily movement-XP cap", async () => {
    const ann = await mkUser("a@x.com");
    await move.ping(ann, north(0).lat, north(0).lng, "public", T(0));
    let awarded = 0;
    // walk a big loop, one 100m step/min, well past the daily cap
    for (let i = 1; i <= 400; i++) awarded += (await move.ping(ann, north(i).lat, north(i).lng, "public", T(i))).xp;
    expect(awarded).toBe(DAILY_MOVEMENT_XP_CAP); // capped exactly
    expect(await xp.total(ann)).toBe(DAILY_MOVEMENT_XP_CAP);
  });

  it("flags a teleport (implausible speed) but still logs it", async () => {
    const ann = await mkUser("a@x.com");
    await move.ping(ann, SF.lat, SF.lng, "public", T(0));
    const jump = await move.ping(ann, SF.lat + 0.5, SF.lng, "public", T(1)); // ~55km in 60s
    expect(jump.flagged).toBe(true);
    expect((raw.prepare("SELECT COUNT(*) n FROM movement_log WHERE user_id=? AND flagged=1").get(ann) as any).n).toBe(1);
  });
});

describe("MovementRepo trail + tracker", () => {
  it("returns a user's recent breadcrumb trail", async () => {
    const ann = await mkUser("a@x.com");
    for (let i = 0; i < 4; i++) await move.ping(ann, north(i).lat, north(i).lng, "public", T(i));
    const trail = await move.trail(ann, T(0));
    expect(trail.length).toBe(4);
    expect(trail[0]).toHaveProperty("lat");
    expect(trail[0]).toHaveProperty("lng");
  });

  it("liveDots shows anonymized recent PUBLIC dots only (friends-scope stays private)", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    await move.ping(ann, north(0).lat, north(0).lng, "public", T(0));
    await move.ping(ann, north(1).lat, north(1).lng, "public", T(1)); // ann's latest, public
    await move.ping(bob, north(0).lat, north(0).lng, "friends", T(1)); // friends-scope → hidden from the public map
    const dots = await move.liveDots([encode(north(0).lat, north(0).lng, 6)], T(0));
    expect(dots.length).toBe(1); // only ann; bob's friends-scoped ping isn't public
    expect(dots[0]).toHaveProperty("lat");
    expect(dots[0]).not.toHaveProperty("userId"); // anonymized — no identity leaks
  });

  it("the admin tracker summarizes movement XP per user (with flags)", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    await move.ping(ann, SF.lat, SF.lng, "public", T(0));
    await move.ping(ann, north(1).lat, north(1).lng, "public", T(1));
    await move.ping(bob, SF.lat, SF.lng, "public", T(0));
    await move.ping(bob, SF.lat + 0.5, SF.lng, "public", T(1)); // teleport → flagged
    const rows = await move.tracker(T(0), 10);
    const byUser = Object.fromEntries(rows.map((r) => [r.userId, r]));
    expect(byUser[ann]!.xp).toBeGreaterThan(0);
    expect(byUser[bob]!.flags).toBe(1);
    expect(byUser[ann]!.pings).toBe(2);
  });
});
