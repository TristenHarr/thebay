import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { suggestEventForMedia } from "../src/core/geofence";
import { MediaRepo } from "../src/storage/d1/media-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";

describe("geo/time-fence media suggestion", () => {
  const shack15 = { lat: 37.7986, lng: -122.3969 }; // Ferry Building area
  const events = [
    { id: "near", startUtc: "2026-08-15T18:00:00Z", endUtc: "2026-08-15T20:00:00Z", latitude: 37.7986, longitude: -122.3969 },
    { id: "faraway", startUtc: "2026-08-15T18:00:00Z", endUtc: "2026-08-15T20:00:00Z", latitude: 37.33, longitude: -121.88 }, // San Jose
    { id: "wrongtime", startUtc: "2026-08-10T18:00:00Z", endUtc: "2026-08-10T20:00:00Z", latitude: 37.7986, longitude: -122.3969 },
  ];

  it("matches a photo taken at the venue during the event window", () => {
    const m = suggestEventForMedia(events, { lat: shack15.lat, lng: shack15.lng, takenAt: "2026-08-15T19:00:00Z" });
    expect(m?.id).toBe("near");
  });
  it("returns null when nothing is near-in-space-and-time", () => {
    expect(suggestEventForMedia(events, { lat: 40.7, lng: -74.0, takenAt: "2026-08-15T19:00:00Z" })).toBeNull(); // NYC
    expect(suggestEventForMedia(events, { lat: shack15.lat, lng: shack15.lng, takenAt: "2026-12-01T19:00:00Z" })).toBeNull(); // months later
  });
  it("ignores events without coordinates and needs a photo location", () => {
    expect(suggestEventForMedia([{ id: "x", startUtc: "2026-08-15T18:00:00Z", latitude: null, longitude: null }], { lat: 1, lng: 1, takenAt: "2026-08-15T19:00:00Z" })).toBeNull();
    expect(suggestEventForMedia(events, { lat: null, lng: null, takenAt: "2026-08-15T19:00:00Z" })).toBeNull();
  });
});

describe("MediaRepo", () => {
  let d1: any, raw: Database.Database, repo: MediaRepo, social: SocialRepo;
  beforeEach(() => {
    ({ d1, raw } = makeTestDb());
    repo = new MediaRepo(d1);
    social = new SocialRepo(d1);
    raw.prepare(`INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at)
      VALUES ('e1','fp','E','2026-08-15T18:00:00Z','America/Los_Angeles','sf-bay','https://x','ch','2026-01-01','2026-01-01')`).run();
  });

  it("adds media, lists by user + event, and tags people", async () => {
    const a = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "Ann" });
    const b = await social.upsertByIdentity({ provider: "dev", providerUid: "b@x.com", email: "b@x.com", displayName: "Bob" });
    const id = await repo.addMedia(a.id, { eventId: "e1", kind: "photo", imageId: "img_1", lat: 37.79, lng: -122.39, caption: "great room" });
    await repo.addMedia(a.id, { kind: "video", streamId: "vid_1" });
    expect((await repo.listUserMedia(a.id)).length).toBe(2);
    expect((await repo.listEventMedia("e1")).map((m) => m.imageId)).toEqual(["img_1"]);
    await repo.tagUser(id, b.id);
    expect((await repo.mediaTags(id)).map((t) => t.displayName)).toEqual(["Bob"]);
  });
});
