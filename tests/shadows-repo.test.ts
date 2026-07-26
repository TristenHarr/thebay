import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { ShadowsRepo } from "../src/storage/d1/shadows-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { encode } from "../src/core/geohash";

let d1: any, raw: Database.Database, repo: ShadowsRepo, social: SocialRepo;
beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  repo = new ShadowsRepo(d1);
  social = new SocialRepo(d1);
});

async function mkUser(email: string, name: string) {
  const u = await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: name });
  return (await social.getUserById(u.id))!;
}
const SF = { lat: 37.7749, lng: -122.4194 };
const SJ = { lat: 37.3382, lng: -121.8863 };
const T0 = "2026-08-01T18:00:00.000Z";
const at = (iso: string) => new Date(iso);

describe("ShadowsRepo.post", () => {
  it("assigns the geohash cell, a 24h expiry, and returns the id", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const r = await repo.post(ann.id, { lat: SF.lat, lng: SF.lng, kind: "thought", body: "gm bay" }, T0);
    expect(r.id).toBeTruthy();
    expect(r.cell).toBe(encode(SF.lat, SF.lng, 6));
    const row = raw.prepare("SELECT * FROM shadows WHERE id=?").get(r.id) as any;
    expect(row.cell).toBe(r.cell);
    expect(row.expires_at).toBe("2026-08-02T18:00:00.000Z"); // +24h
    expect(row.mod_status).toBe("ok");
  });

  it("enforces one active shadow per account — a new post replaces the old", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const first = await repo.post(ann.id, { lat: SF.lat, lng: SF.lng, kind: "thought", body: "first" }, T0);
    const second = await repo.post(ann.id, { lat: SJ.lat, lng: SJ.lng, kind: "thought", body: "second" }, "2026-08-01T18:05:00.000Z");
    expect(second.replaced?.id).toBe(first.id);
    expect(second.replaced?.cell).toBe(first.cell);
    const rows = raw.prepare("SELECT id FROM shadows WHERE author_id=?").all(ann.id) as any[];
    expect(rows.map((r) => r.id)).toEqual([second.id]); // only the new one remains
  });
});

describe("ShadowsRepo.activeInCell", () => {
  it("returns non-expired, ok shadows with author + reaction counts", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const bob = await mkUser("b@x.com", "Bob");
    const s = await repo.post(ann.id, { lat: SF.lat, lng: SF.lng, kind: "thought", body: "hi" }, T0);
    await repo.react(s.id, bob.id, "🔥");
    await repo.react(s.id, ann.id, "🔥");
    const list = await repo.activeInCell(s.cell, at("2026-08-01T18:10:00.000Z"));
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ id: s.id, kind: "thought", body: "hi" });
    expect(list[0]!.author.handle).toBe(ann.handle);
    expect(list[0]!.reactions["🔥"]).toBe(2);
  });

  it("hides expired shadows and moderated-away shadows (blocked or pending)", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const s = await repo.post(ann.id, { lat: SF.lat, lng: SF.lng, kind: "thought", body: "x" }, T0);
    expect((await repo.activeInCell(s.cell, at("2026-08-02T19:00:00.000Z"))).length).toBe(0); // 25h → expired
    await repo.setModeration(s.id, "blocked", "spam");
    expect((await repo.activeInCell(s.cell, at("2026-08-01T18:10:00.000Z"))).length).toBe(0); // blocked
    await repo.setModeration(s.id, "pending");
    expect((await repo.activeInCell(s.cell, at("2026-08-01T18:10:00.000Z"))).length).toBe(0); // pending (report)
    await repo.setModeration(s.id, "ok");
    expect((await repo.activeInCell(s.cell, at("2026-08-01T18:10:00.000Z"))).length).toBe(1); // restored
  });
});

describe("ShadowsRepo.heat (zoomed-out aggregate)", () => {
  it("groups active shadows into coarse cells", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const bob = await mkUser("b@x.com", "Bob");
    await repo.post(ann.id, { lat: SF.lat, lng: SF.lng, kind: "thought" }, T0);
    await repo.post(bob.id, { lat: SJ.lat, lng: SJ.lng, kind: "thought" }, T0);
    const heat = await repo.heat(4, at("2026-08-01T18:10:00.000Z"));
    const map = Object.fromEntries(heat.map((h) => [h.cell, h.count]));
    expect(map[encode(SF.lat, SF.lng, 4)]).toBe(1);
    expect(map[encode(SJ.lat, SJ.lng, 4)]).toBe(1);
  });
});

describe("ShadowsRepo reactions / report / delete / expiry GC", () => {
  it("toggles reactions, reports (→pending), and deletes only your own", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const bob = await mkUser("b@x.com", "Bob");
    const s = await repo.post(ann.id, { lat: SF.lat, lng: SF.lng, kind: "photo", body: "cap", mediaKey: "r2/x.jpg" }, T0);
    await repo.react(s.id, bob.id, "👀");
    expect((await repo.activeInCell(s.cell, at("2026-08-01T18:10:00.000Z")))[0]!.reactions["👀"]).toBe(1);
    await repo.unreact(s.id, bob.id, "👀");
    expect((await repo.activeInCell(s.cell, at("2026-08-01T18:10:00.000Z")))[0]!.reactions["👀"]).toBeUndefined();
    await repo.report(s.id);
    expect((raw.prepare("SELECT mod_status FROM shadows WHERE id=?").get(s.id) as any).mod_status).toBe("pending");
    expect(await repo.deleteOwn(s.id, bob.id)).toBe(false); // not the author
    expect(await repo.deleteOwn(s.id, ann.id)).toBe(true);
    expect((raw.prepare("SELECT COUNT(*) n FROM shadows").get() as any).n).toBe(0);
  });

  it("deleteExpired removes expired rows and returns their media keys / stream ids for GC", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const bob = await mkUser("b@x.com", "Bob");
    await repo.post(ann.id, { lat: SF.lat, lng: SF.lng, kind: "photo", mediaKey: "r2/gone.jpg" }, T0);
    await repo.post(bob.id, { lat: SJ.lat, lng: SJ.lng, kind: "video", streamId: "vid-123" }, T0);
    const res = await repo.deleteExpired(at("2026-08-02T19:00:00.000Z")); // >24h
    expect(res.mediaKeys.sort()).toEqual(["r2/gone.jpg"]);
    expect(res.streamIds).toContain("vid-123");
    expect((raw.prepare("SELECT COUNT(*) n FROM shadows").get() as any).n).toBe(0);
  });
});
