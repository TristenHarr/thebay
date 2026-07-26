import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/d1";
import { CrawlsRepo, CRAWL_STOP_XP, CRAWL_FINISH_XP } from "../src/storage/d1/crawls-repo";
import { XpRepo } from "../src/storage/d1/xp-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";

let d1: any, crawls: CrawlsRepo, xp: XpRepo, social: SocialRepo;
beforeEach(() => {
  ({ d1 } = makeTestDb());
  crawls = new CrawlsRepo(d1);
  xp = new XpRepo(d1);
  social = new SocialRepo(d1);
});
const mkUser = async (e: string) => (await social.upsertByIdentity({ provider: "dev", providerUid: e, email: e, displayName: e })).id;
const S0 = { name: "SHACK15", lat: 37.7749, lng: -122.4194 };
const S1 = { name: "Frontier Tower", lat: 37.7849, lng: -122.4194 }; // ~1.1km north

describe("CrawlsRepo", () => {
  it("plans a crawl (creator auto-joins) and lists + fetches it", async () => {
    const ann = await mkUser("a@x.com");
    const id = await crawls.create(ann, { name: "Founder Dawn Patrol", description: "The SoMa loop", stops: [S0, S1] });
    const list = await crawls.list();
    expect(list.find((c) => c.id === id)).toMatchObject({ name: "Founder Dawn Patrol", stops: 2, walkers: 1 });
    const detail = await crawls.get(id);
    expect(detail!.stops.map((s: any) => s.name)).toEqual(["SHACK15", "Frontier Tower"]);
    expect(detail!.participants.map((p: any) => p.userId)).toEqual([ann]);
  });

  it("walks the route in order with GPS checks, paying waypoint + finish XP", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    const id = await crawls.create(ann, { name: "Crawl", stops: [S0, S1] });
    await crawls.join(bob, id);

    // can't skip ahead
    expect((await crawls.checkpoint(bob, id, 1, S1.lat, S1.lng)).status).toBe("out-of-order");
    // must be near the stop
    expect((await crawls.checkpoint(bob, id, 0, S1.lat, S1.lng)).status).toBe("too-far");
    // reach stop 0
    const c0 = await crawls.checkpoint(bob, id, 0, S0.lat, S0.lng);
    expect(c0.status).toBe("ok");
    expect(c0.progress).toBe(1);
    expect(c0.finished).toBe(false);
    expect(c0.xp).toBe(CRAWL_STOP_XP);
    // reach stop 1 → finish
    const c1 = await crawls.checkpoint(bob, id, 1, S1.lat, S1.lng);
    expect(c1.finished).toBe(true);
    expect(c1.xp).toBe(CRAWL_STOP_XP + CRAWL_FINISH_XP);
    expect(await xp.total(bob)).toBe(2 * CRAWL_STOP_XP + CRAWL_FINISH_XP);
    // already done
    expect((await crawls.checkpoint(bob, id, 2, S1.lat, S1.lng)).status).toBe("done");
  });

  it("rejects a checkpoint from someone who hasn't joined", async () => {
    const ann = await mkUser("a@x.com");
    const cara = await mkUser("c@x.com");
    const id = await crawls.create(ann, { name: "Crawl", stops: [S0, S1] });
    expect((await crawls.checkpoint(cara, id, 0, S0.lat, S0.lng)).status).toBe("not-joined");
  });
});
