import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { XpRepo } from "../src/storage/d1/xp-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";

let d1: any, raw: Database.Database, xp: XpRepo, social: SocialRepo;
beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  xp = new XpRepo(d1);
  social = new SocialRepo(d1);
});
const mkUser = async (email: string) => (await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: email })).id;

describe("XpRepo", () => {
  it("grants XP idempotently by dedup_key and totals it", async () => {
    const ann = await mkUser("a@x.com");
    expect(await xp.grant(ann, "orb", 50, `orb:${ann}:1`)).toBe(true);
    expect(await xp.grant(ann, "orb", 50, `orb:${ann}:1`)).toBe(false); // same key → no double-grant
    expect(await xp.grant(ann, "movement", 12, `movement:${ann}:2026-07-26`)).toBe(true);
    expect(await xp.total(ann)).toBe(62);
    expect((raw.prepare("SELECT COUNT(*) n FROM xp_ledger WHERE user_id=?").get(ann) as any).n).toBe(2);
  });

  it("reports level info from the pure curve", async () => {
    const ann = await mkUser("a@x.com");
    await xp.grant(ann, "orb", 150, `orb:${ann}:1`); // level 2 (100..400)
    const info = await xp.levelInfo(ann);
    expect(info.xp).toBe(150);
    expect(info.level).toBe(2);
    expect(info.xpForNext).toBe(300);
  });

  it("breaks XP down by kind", async () => {
    const ann = await mkUser("a@x.com");
    await xp.grant(ann, "movement", 10, `m:${ann}:1`);
    await xp.grant(ann, "movement", 20, `m:${ann}:2`);
    await xp.grant(ann, "catch", 40, `c:${ann}:bob`);
    const bd = Object.fromEntries((await xp.breakdown(ann)).map((r) => [r.kind, r.xp]));
    expect(bd).toEqual({ movement: 30, catch: 40 });
  });

  it("ranks a movement leaderboard by a single kind", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    await xp.grant(ann, "movement", 100, `m:${ann}:1`);
    await xp.grant(bob, "movement", 300, `m:${bob}:1`);
    await xp.grant(ann, "orb", 999, `o:${ann}:1`); // not movement → ignored by the movement board
    const board = await xp.leaderboard("movement", 10);
    expect(board.map((r) => r.userId)).toEqual([bob, ann]); // bob first (more movement)
    expect(board[0]!.xp).toBe(300);
  });
});
