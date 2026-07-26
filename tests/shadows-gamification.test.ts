import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { PlatformRepo } from "../src/storage/d1/platform-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";

let d1: any, raw: Database.Database, plat: PlatformRepo, social: SocialRepo;
beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  plat = new PlatformRepo(d1);
  social = new SocialRepo(d1);
});
async function mkUser(email: string) {
  const u = await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: email });
  return u.id;
}
const points = (uid: string, kind: string) =>
  (raw.prepare("SELECT COUNT(*) c, COALESCE(SUM(points),0) p FROM points_ledger WHERE user_id=? AND kind=?").get(uid, kind) as any);
const hasBadge = (uid: string, kind: string) =>
  (raw.prepare("SELECT COUNT(*) c FROM achievements WHERE user_id=? AND kind=?").get(uid, kind) as any).c > 0;
const streak = (uid: string) => (raw.prepare("SELECT count FROM streaks WHERE user_id=? AND kind='shadow'").get(uid) as any)?.count ?? 0;

// SF cell (geohash p6) and a handful of distinct p4 areas for the explorer badge.
const SF = "9q8yyk";

describe("recordShadow — daily point, streak, badges (dedup-keyed)", () => {
  it("awards one shadow point per day no matter how many times you cast", async () => {
    const ann = await mkUser("a@x.com");
    await plat.recordShadow(ann, SF, "2026-08-01T18:00:00.000Z");
    await plat.recordShadow(ann, SF, "2026-08-01T21:00:00.000Z"); // same day → no extra point
    expect(points(ann, "shadow")).toMatchObject({ c: 1, p: 4 });
    expect(hasBadge(ann, "first_shadow")).toBe(true);
  });

  it("advances the streak on consecutive days and resets on a gap", async () => {
    const ann = await mkUser("a@x.com");
    await plat.recordShadow(ann, SF, "2026-08-01T18:00:00.000Z");
    expect(streak(ann)).toBe(1);
    await plat.recordShadow(ann, SF, "2026-08-02T18:00:00.000Z");
    expect(streak(ann)).toBe(2);
    await plat.recordShadow(ann, SF, "2026-08-03T09:00:00.000Z");
    expect(streak(ann)).toBe(3);
    await plat.recordShadow(ann, SF, "2026-08-05T09:00:00.000Z"); // skipped the 4th → reset
    expect(streak(ann)).toBe(1);
  });

  it("grants local_legend after casting from 5 distinct areas", async () => {
    const ann = await mkUser("a@x.com");
    const areas = ["9q8yyk", "9q9p11", "9q5ctr", "9qc1bb", "9q8v99"]; // 5 distinct p4 prefixes
    for (let i = 0; i < areas.length; i++) {
      await plat.recordShadow(ann, areas[i]!, `2026-08-0${i + 1}T18:00:00.000Z`);
      expect(hasBadge(ann, "local_legend")).toBe(i >= 4);
    }
  });
});

describe("recordConnection — per-person point + connector badge", () => {
  it("awards once per unique person and grants the badge", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    const carol = await mkUser("c@x.com");
    await plat.recordConnection(ann, bob);
    await plat.recordConnection(ann, bob); // same person → no extra point
    await plat.recordConnection(ann, carol);
    expect(points(ann, "connection")).toMatchObject({ c: 2, p: 30 });
    expect(hasBadge(ann, "connector")).toBe(true);
  });
});

describe("recordReactionReceived — rewards the author, never self", () => {
  it("awards the author once per reactor per shadow and ignores self-reactions", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    await plat.recordReactionReceived(ann, "shadow-1", bob);
    await plat.recordReactionReceived(ann, "shadow-1", bob); // same reactor+shadow → dedup
    await plat.recordReactionReceived(ann, "shadow-1", ann); // self → nothing
    expect(points(ann, "reaction")).toMatchObject({ c: 1, p: 2 });
  });
});
