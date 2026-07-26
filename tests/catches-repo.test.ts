import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/d1";
import { CatchesRepo } from "../src/storage/d1/catches-repo";
import { XpRepo } from "../src/storage/d1/xp-repo";
import { GraphRepo } from "../src/storage/d1/graph-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";

let d1: any, catches: CatchesRepo, xp: XpRepo, graph: GraphRepo, social: SocialRepo;
beforeEach(() => {
  ({ d1 } = makeTestDb());
  catches = new CatchesRepo(d1);
  xp = new XpRepo(d1);
  graph = new GraphRepo(d1);
  social = new SocialRepo(d1);
});
const mkUser = async (e: string) => (await social.upsertByIdentity({ provider: "dev", providerUid: e, email: e, displayName: e })).id;

describe("CatchesRepo — the founder Pokédex", () => {
  it("mints a rotating catch QR and captures a founder into the collection (+XP)", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    const token = await catches.mintToken(bob);
    const res = await catches.capture(ann, token);
    expect(res.status).toBe("ok");
    expect(res.caught.id).toBe(bob);
    expect(res.xp).toBeGreaterThan(0);
    expect(res.caught.stats.rarity).toBeTruthy();
    expect(await xp.total(ann)).toBe(res.xp); // catcher earns the XP
    expect((await catches.pokedex(ann)).map((c) => c.id)).toEqual([bob]);
  });

  it("can't catch yourself; re-catching the same person dedups; junk is invalid", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    expect((await catches.capture(bob, await catches.mintToken(bob))).status).toBe("self");
    await catches.capture(ann, await catches.mintToken(bob));
    expect((await catches.capture(ann, await catches.mintToken(bob))).status).toBe("already");
    expect((await catches.capture(ann, "nope")).status).toBe("invalid");
  });

  it("a fresh mint revokes the previous QR (rotation = revoke)", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    const t1 = await catches.mintToken(bob);
    const t2 = await catches.mintToken(bob);
    expect(t1).not.toBe(t2);
    expect((await catches.capture(ann, t1)).status).toBe("expired"); // old code no longer works
    expect((await catches.capture(ann, t2)).status).toBe("ok");
  });

  it("rejects an expired QR", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    const old = await catches.mintToken(bob, Date.parse("2020-01-01T00:00:00Z"));
    expect((await catches.capture(ann, old, Date.parse("2020-01-01T01:00:00Z"))).status).toBe("expired");
  });

  it("derives founder stats from real platform data", async () => {
    const bob = await mkUser("b@x.com");
    await graph.setMatchPrefs(bob, { technical: true, interests: ["ai", "infra"] });
    const stats = await catches.statsFor(bob);
    expect(stats.technical).toBeGreaterThan(50); // technical builder
    expect(stats.power).toBeGreaterThanOrEqual(0);
    expect(stats.power).toBeLessThanOrEqual(100);
  });
});
