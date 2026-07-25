import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { D1Repo } from "../src/storage/d1/d1-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { makeCityResolver } from "../src/core/normalize/normalize";
import { fingerprint } from "../src/core/dedup/fingerprint";
import { loadCities } from "../src/config/load";

const resolver = makeCityResolver(loadCities());
const resolveCityId = (e: { city?: string | null; address?: string | null; venueName?: string | null }) =>
  resolver(e.city, e.address, e.venueName)?.id ?? "unknown";

let d1: any, raw: Database.Database, repo: D1Repo, social: SocialRepo;
beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  repo = new D1Repo(d1);
  social = new SocialRepo(d1);
});

const TZ = "America/Los_Angeles";
function seed(id: string, title: string, startUtc: string, city: string, address: string, firstSeen: string): string {
  const fp = fingerprint({ title, startUtc, timezone: TZ, city });
  raw
    .prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, address, url, content_hash, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, fp, title, startUtc, TZ, city, address, "https://x/" + id, "ch-" + id, firstSeen, firstSeen);
  return fp;
}
const fpFor = (title: string, startUtc: string, city: string) => fingerprint({ title, startUtc, timezone: TZ, city });

describe("renormalizeCities — re-resolve city + fingerprint in place, dedup safely", () => {
  it("moves a now-matchable city (unknown → sf-bay) in place, preserving the event id", async () => {
    seed("e1", "AI Meetup", "2026-08-01T18:00:00Z", "unknown", "1415 Pacific Ave, Santa Cruz, CA 95060", "2026-07-01");
    const res = await repo.renormalizeCities(resolveCityId);

    const row = raw.prepare("SELECT id, city, fingerprint FROM events WHERE id='e1'").get() as any;
    expect(row.city).toBe("sf-bay");
    expect(row.fingerprint).toBe(fpFor("AI Meetup", "2026-08-01T18:00:00Z", "sf-bay"));
    expect(res).toMatchObject({ updated: 1, merged: 0 });
  });

  it("merges a collision after re-resolution, reassigning FK dependents to the oldest (canonical) row", async () => {
    seed("keep", "Founder Dinner", "2026-08-02T02:00:00Z", "sf-bay", "88 S Almaden, San Jose, CA", "2026-06-01"); // older → canonical
    seed("dup", "Founder Dinner", "2026-08-02T02:00:00Z", "unknown", "1331 1st Street, Napa, CA 94559", "2026-06-15"); // → sf-bay, collides
    // a user RSVP'd to the dup — must survive the merge, not cascade-delete
    const u = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "Ann" });
    raw.prepare(`INSERT INTO rsvps (event_id, user_id, status, created_at) VALUES ('dup', ?, 'going', '2026-07-01')`).run(u.id);

    const res = await repo.renormalizeCities(resolveCityId);

    const rows = raw.prepare("SELECT id, city FROM events").all() as any[];
    expect(rows.map((r) => r.id)).toEqual(["keep"]); // only the canonical survives
    expect(rows[0].city).toBe("sf-bay");
    const rsvp = raw.prepare("SELECT event_id FROM rsvps WHERE user_id=?").get(u.id) as any;
    expect(rsvp.event_id).toBe("keep"); // reassigned, not lost
    expect(res.merged).toBe(1);
  });

  it("leaves genuinely out-of-region events unknown and untouched", async () => {
    const oldFp = seed("e4", "Startup Mixer", "2026-08-03T18:00:00Z", "unknown", "102 North Avenue, Wake Forest, NC 27587", "2026-07-01");
    await repo.renormalizeCities(resolveCityId);
    const row = raw.prepare("SELECT city, fingerprint FROM events WHERE id='e4'").get() as any;
    expect(row.city).toBe("unknown");
    expect(row.fingerprint).toBe(oldFp);
  });

  it("is idempotent — a second pass changes nothing", async () => {
    seed("e1", "AI Meetup", "2026-08-01T18:00:00Z", "unknown", "Santa Cruz, CA", "2026-07-01");
    const first = await repo.renormalizeCities(resolveCityId);
    const second = await repo.renormalizeCities(resolveCityId);
    expect(first.updated).toBe(1);
    expect(second).toMatchObject({ updated: 0, merged: 0 });
  });
});
