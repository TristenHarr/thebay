import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/d1";
import { ModerationRepo } from "../src/storage/d1/moderation-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { PlacesRepo } from "../src/storage/d1/places-repo";

/**
 * 0017 taught `flags` to accept a 'place'; 0020 taught the audit log the same.
 * Without both halves a pin could be reported and then not acted on, because
 * hiding it writes a `moderation_actions` row in the same call and that insert
 * would fail the CHECK. These tests pin down both halves plus the shared queue.
 */
describe("place moderation", () => {
  let d1: any, raw: any, mod: ModerationRepo, social: SocialRepo, places: PlacesRepo;
  let admin: any, reporter: any, author: any;

  beforeEach(async () => {
    ({ d1, raw } = makeTestDb());
    mod = new ModerationRepo(d1);
    social = new SocialRepo(d1);
    places = new PlacesRepo(d1);
    admin = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "Admin" });
    reporter = await social.upsertByIdentity({ provider: "dev", providerUid: "r@x.com", email: "r@x.com", displayName: "Reporter" });
    author = await social.upsertByIdentity({ provider: "dev", providerUid: "p@x.com", email: "p@x.com", displayName: "Pinner" });
  });

  /** A pin created by `author`, in SF. `parking` is seeded active by 0016. */
  async function pin(name = "Sketchy lot"): Promise<string> {
    const p = await places.createPlace({
      kindId: "parking",
      name,
      lat: 37.7749,
      lng: -122.4194,
      attrs: {},
      createdBy: author.id,
    });
    return p.id;
  }

  describe("migration 0020", () => {
    it("admits 'place' as a moderation_actions target", async () => {
      // The whole point of the migration — this insert is what used to fail.
      await expect(
        d1.prepare(
          "INSERT INTO moderation_actions (id, target_type, target_id, action, actor_id, note, created_at) VALUES (?,?,?,?,?,?,?)",
        ).bind("m1", "place", "p1", "hide", admin.id, null, "2026-07-26T00:00:00.000Z").run(),
      ).resolves.toBeTruthy();
    });

    it("still rejects a target type nobody defined", async () => {
      await expect(
        d1.prepare(
          "INSERT INTO moderation_actions (id, target_type, target_id, action, actor_id, note, created_at) VALUES (?,?,?,?,?,?,?)",
        ).bind("m2", "spaceship", "p1", "hide", admin.id, null, "2026-07-26T00:00:00.000Z").run(),
      ).rejects.toThrow();
    });

    it("preserves the pre-existing audit log through the table rebuild", () => {
      // makeTestDb applies 0008 (which creates the log) then 0020 (which rebuilds
      // it). Simulate the real hazard: rows written before the rebuild must
      // survive it. We re-run the 0020 body against a seeded table.
      raw.prepare(
        "INSERT INTO moderation_actions (id, target_type, target_id, action, actor_id, note, created_at) VALUES (?,?,?,?,?,?,?)",
      ).run("old-1", "story", "s1", "hide", admin.id, "pre-existing decision", "2026-01-01T00:00:00.000Z");

      const before = raw.prepare("SELECT COUNT(*) AS n FROM moderation_actions").get().n;
      expect(before).toBe(1);

      raw.exec(`
        CREATE TABLE IF NOT EXISTS _mig20_redo AS SELECT * FROM moderation_actions;
        DROP TABLE moderation_actions;
        CREATE TABLE moderation_actions (
          id TEXT PRIMARY KEY,
          target_type TEXT NOT NULL CHECK (target_type IN ('story','comment','user','place')),
          target_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('hide','unhide','kill','revive','ban','unban','block_domain','unblock_domain')),
          actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          note TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO moderation_actions (id, target_type, target_id, action, actor_id, note, created_at)
        SELECT id, target_type, target_id, action, actor_id, note, created_at FROM _mig20_redo;
        DROP TABLE _mig20_redo;
      `);

      const row = raw.prepare("SELECT * FROM moderation_actions WHERE id = 'old-1'").get();
      expect(row.note).toBe("pre-existing decision");
      expect(row.target_type).toBe("story");
      expect(raw.prepare("SELECT COUNT(*) AS n FROM moderation_actions").get().n).toBe(1);
    });
  });

  describe("hide / unhide", () => {
    it("hides a pin and logs it attributably", async () => {
      const id = await pin();
      await mod.hidePlace(id, admin.id, "duplicate of the garage next door");

      const p = await d1.prepare("SELECT hidden FROM places WHERE id = ?").bind(id).first();
      expect(p.hidden).toBe(1);

      const log = await mod.actionLog(10);
      const entry = log.find((l: any) => l.targetId === id);
      expect(entry).toMatchObject({ targetType: "place", action: "hide", actor: admin.handle });
      expect(entry!.note).toBe("duplicate of the garage next door");
    });

    it("is reversible — nothing hard-deletes", async () => {
      const id = await pin();
      await mod.hidePlace(id, admin.id);
      await mod.unhidePlace(id, admin.id);

      const p = await d1.prepare("SELECT hidden FROM places WHERE id = ?").bind(id).first();
      expect(p.hidden).toBe(0);
      // Both decisions remain on the record.
      const actions = (await mod.actionLog(10)).filter((l: any) => l.targetId === id).map((l: any) => l.action);
      expect(actions).toContain("hide");
      expect(actions).toContain("unhide");
    });

    it("keeps the reporter's evidence after a hide", async () => {
      const id = await pin();
      await places.flag(id, reporter.id, "spam");
      await mod.hidePlace(id, admin.id);
      expect(await mod.flagCount("place", id)).toBe(1);
    });
  });

  describe("the shared queue", () => {
    it("surfaces a flagged pin alongside stories and comments", async () => {
      const id = await pin("Fake free parking");
      await places.flag(id, reporter.id, "spam");

      const q = await mod.queue();
      const item = q.find((x: any) => x.targetId === id);
      expect(item).toBeTruthy();
      expect(item!.targetType).toBe("place");
      expect(item!.title).toBe("Fake free parking");
      expect(item!.flagCount).toBe(1);
      expect(item!.reasons).toEqual(["spam"]);
      expect(item!.handle).toBe(author.handle); // attributed to whoever pinned it
    });

    it("omits pins nobody flagged — the queue is a report list, not a browser", async () => {
      const id = await pin();
      expect((await mod.queue()).some((x: any) => x.targetId === id)).toBe(false);
    });

    it("reports a hidden pin as dead so the moderator can reverse the call", async () => {
      const id = await pin();
      await places.flag(id, reporter.id, "abuse");
      await mod.hidePlace(id, admin.id);

      const item = (await mod.queue()).find((x: any) => x.targetId === id);
      expect(item!.dead).toBe(1);
    });

    it("gives a pin no storyId — the renderer must not build /item/null", async () => {
      const id = await pin();
      await places.flag(id, reporter.id, "other");
      const item = (await mod.queue()).find((x: any) => x.targetId === id);
      expect(item!.storyId ?? null).toBeNull();
      expect(item!.storySlug).toBeNull();
    });

    it("orders by flag count across all three target types", async () => {
      const quiet = await pin("One report");
      const loud = await pin("Three reports");
      await places.flag(quiet, reporter.id, "other");
      for (const u of [admin, reporter, author]) await places.flag(loud, u.id, "spam");

      const q = await mod.queue();
      const iLoud = q.findIndex((x: any) => x.targetId === loud);
      const iQuiet = q.findIndex((x: any) => x.targetId === quiet);
      expect(iLoud).toBeLessThan(iQuiet);
    });
  });
});
