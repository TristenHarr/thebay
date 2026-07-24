import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/d1";
import { makeTestApp, call, login } from "./helpers/app";
import { NotesRepo } from "../src/storage/d1/notes-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { inBay, BAY_BOUNDS } from "../src/core/geo";

describe("inBay geofence (shared)", () => {
  it("accepts Bay coords and rejects elsewhere / invalid", () => {
    expect(inBay(37.7749, -122.4194)).toBe(true); // SF
    expect(inBay(37.3382, -121.8863)).toBe(true); // San Jose
    expect(inBay(34.0522, -118.2437)).toBe(false); // LA
    expect(inBay(40.7128, -74.006)).toBe(false); // NYC
    expect(inBay(NaN, -122)).toBe(false);
    expect(inBay(BAY_BOUNDS.minLat, 0)).toBe(false); // exactly on the boundary is out
  });
});

describe("NotesRepo", () => {
  let d1: any, repo: NotesRepo, social: SocialRepo;
  beforeEach(() => { ({ d1 } = makeTestDb()); repo = new NotesRepo(d1); social = new SocialRepo(d1); });

  it("posts a note and lists it with the author, newest first", async () => {
    const u = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "Ann" });
    await repo.post(u.id, 37.77, -122.41, "first", "2026-07-01T10:00:00.000Z");
    await repo.post(u.id, 37.78, -122.42, "second", "2026-07-01T10:05:00.000Z");
    const notes = await repo.recent();
    expect(notes.map((n) => n.body)).toEqual(["second", "first"]); // newest first
    expect(notes[0]!.author).toBe("Ann");
  });
});

describe("/api/notes route (Bay GPS gate)", () => {
  it("reads open, posts only from Bay coords, rejects out-of-Bay + empty + too-long", async () => {
    const t = makeTestApp(); // route auto-mounted via the registry
    // reading is open
    expect((await call(t, "/api/notes")).status).toBe(200);
    // posting requires auth
    expect((await call(t, "/api/notes", { method: "POST", body: { lat: 37.77, lng: -122.41, body: "hi" } })).status).toBe(401);
    const { cookie } = await login(t, "ann@x.com", "Ann");
    // out-of-Bay GPS → 403
    expect((await call(t, "/api/notes", { method: "POST", cookie, body: { lat: 34.05, lng: -118.24, body: "from LA" } })).status).toBe(403);
    // empty / too-long → 400
    expect((await call(t, "/api/notes", { method: "POST", cookie, body: { lat: 37.77, lng: -122.41, body: "  " } })).status).toBe(400);
    expect((await call(t, "/api/notes", { method: "POST", cookie, body: { lat: 37.77, lng: -122.41, body: "x".repeat(281) } })).status).toBe(400);
    // valid Bay post → shows on the board
    const posted = await call(t, "/api/notes", { method: "POST", cookie, body: { lat: 37.7749, lng: -122.4194, body: "anyone at the AI infra dinner?" } });
    expect(posted.status).toBe(200);
    const board = await call(t, "/api/notes");
    expect(board.json.notes[0]).toMatchObject({ body: "anyone at the AI infra dinner?", author: "Ann" });
  });
});
