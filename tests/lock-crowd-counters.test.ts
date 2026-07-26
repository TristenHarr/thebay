import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeTestDb } from "./helpers/d1";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { PlacesRepo } from "../src/storage/d1/places-repo";
import { ModerationRepo } from "../src/storage/d1/moderation-repo";

/**
 * LOCK-IN TESTS — crowd counters.
 *
 * The bug: `places.confirms` was maintained as `confirms + 1`, so one person
 * tapping "confirm" repeatedly could drive a pin's trust to 50 and hold the top of
 * the map. Every ranked, crowd-fed number on this site has that failure mode, and
 * it is invisible in normal use — you only see it when someone abuses it.
 *
 * There are exactly two ways to be safe, and every counter must use one:
 *   1. A composite primary key including `user_id`, so a second action from the
 *      same person is unrepresentable at the schema level. (Preferred.)
 *   2. An append-only log, with the counter RECOMPUTED from
 *      COUNT(DISTINCT user_id) rather than incremented.
 *
 * These tests enforce the choice, and prove it behaviourally.
 */

/** Tables that intentionally allow many rows per user, with the reason. */
const APPEND_ONLY: Record<string, { reason: string; repo: string }> = {
  place_reports: {
    reason: "a person may confirm today and dispute next week; tips are perishable and timestamped",
    repo: "src/storage/d1/places-repo.ts",
  },
};

describe("lock: stacking is structurally impossible", () => {
  it("gives every one-per-person table a user_id in its primary key", () => {
    const { raw } = makeTestDb();
    const tables: string[] = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r: any) => r.name);

    const offenders: string[] = [];
    let examined = 0;
    for (const t of tables) {
      const cols = raw.prepare(`PRAGMA table_info("${t}")`).all() as any[];
      if (!cols.some((c) => c.name === "user_id")) continue;
      // Anything that reads as a per-person signal.
      if (!/vote|flag|report|confirm|react|rsvp|checkin|member/.test(t)) continue;
      examined++;
      if (APPEND_ONLY[t]) continue;
      const pk = cols.filter((c) => c.pk > 0).map((c) => c.name);
      if (!pk.includes("user_id")) offenders.push(`${t} (PK: ${pk.join(", ") || "none"})`);
    }

    expect(examined, "table discovery found nothing — the pattern or introspection broke").toBeGreaterThan(8);
    expect(
      offenders,
      `These per-person tables let one account insert unlimited rows, so any counter ` +
        `derived from them can be stacked: ${offenders.join("; ")}. Either add user_id to ` +
        `the primary key, or register the table in APPEND_ONLY and recompute its counter ` +
        `with COUNT(DISTINCT user_id).`,
    ).toEqual([]);
  });

  it("recomputes append-only counters from DISTINCT users, never by incrementing", () => {
    for (const [table, { repo }] of Object.entries(APPEND_ONLY)) {
      const src = readFileSync(resolve(process.cwd(), repo), "utf8");
      expect(
        src,
        `${repo} maintains a counter over the append-only ${table}, so it must use ` +
          `COUNT(DISTINCT user_id)`,
      ).toMatch(/COUNT\(DISTINCT\s+user_id\)/i);
      // The exact shape of the original bug.
      const increments = [...src.matchAll(/\b(confirms|disputes|votes|vote_count|score)\s*=\s*\1\s*\+\s*1/gi)];
      expect(
        increments.map((m) => m[0]),
        `${repo} increments a crowd counter instead of recomputing it — that is the ` +
          `stacking bug. Recompute from COUNT(DISTINCT user_id).`,
      ).toEqual([]);
    }
  });
});

describe("lock: repeated actions by one person do not inflate anything", () => {
  let d1: any, social: SocialRepo, places: PlacesRepo, mod: ModerationRepo;
  let ann: any, bob: any;

  beforeEach(async () => {
    ({ d1 } = makeTestDb());
    social = new SocialRepo(d1);
    places = new PlacesRepo(d1);
    mod = new ModerationRepo(d1);
    ann = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "Ann" });
    bob = await social.upsertByIdentity({ provider: "dev", providerUid: "b@x.com", email: "b@x.com", displayName: "Bob" });
  });

  async function pin(): Promise<string> {
    const p = await places.createPlace({
      kindId: "parking", name: "Test spot", lat: 37.7749, lng: -122.4194, attrs: {}, createdBy: ann.id,
    });
    return p.id;
  }

  it("counts one confirm per person however many times they tap", async () => {
    const id = await pin();
    for (let i = 0; i < 5; i++) await places.report(id, bob.id, { verdict: "confirm" });
    const p = await places.getPlace(id);
    expect(p!.confirms).toBe(1);
  });

  it("still counts distinct people", async () => {
    const id = await pin();
    await places.report(id, bob.id, { verdict: "confirm" });
    await places.report(id, ann.id, { verdict: "confirm" });
    const p = await places.getPlace(id);
    expect(p!.confirms).toBe(2);
  });

  it("lets a person change their mind without inflating either side", async () => {
    const id = await pin();
    await places.report(id, bob.id, { verdict: "confirm" });
    await places.report(id, bob.id, { verdict: "dispute" });
    const p = await places.getPlace(id);
    // One person, one voice on each verdict they've expressed — never 2 confirms.
    expect(p!.confirms).toBeLessThanOrEqual(1);
    expect(p!.disputes).toBe(1);
  });

  it("counts one flag per person per target", async () => {
    const id = await pin();
    for (let i = 0; i < 4; i++) await places.flag(id, bob.id, "spam");
    expect(await mod.flagCount("place", id)).toBe(1);
  });

  it("counts one kind vote per person", async () => {
    const proposed = await places.proposeKind(ann.id, {
      label: "Sketchy alley", emoji: "🌚", category: "safety", fields: [],
    });
    const first = await places.voteKind(proposed.id, bob.id);
    const second = await places.voteKind(proposed.id, bob.id);
    expect(second.votes).toBe(first.votes);
  });

  it("keeps one vibe report per person per event", async () => {
    // vibe_reports is PK(event_id, user_id): a second submission replaces, never adds.
    const evId = "01TESTEVENT0000000000000";
    await d1
      .prepare(
        `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, categories, content_hash,
          sources_json, first_seen_at, last_seen_at, starred, hidden)
         VALUES (?,?,?,?,?,?,?,'[]',?, '[]', ?, ?, 0, 0)`,
      )
      .bind(evId, "fp-lock", "Locked event", "2026-08-01T18:00:00.000Z", "America/Los_Angeles", "sf-bay",
        "https://example.com/e", "ch-lock", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z")
      .run();

    for (let i = 0; i < 3; i++) {
      await d1
        .prepare(
          `INSERT INTO vibe_reports (event_id, user_id, energy, formality, intimacy, talk_ratio, signal,
             approachability, crowd_json, tags_json, worth_it, verified, created_at)
           VALUES (?,?,?,?,?,?,?,?, '{}', '[]', 4, 0, ?)
           ON CONFLICT(event_id, user_id) DO UPDATE SET energy = excluded.energy`,
        )
        .bind(evId, bob.id, 50 + i, 50, 50, 50, 50, 50, "2026-08-02T00:00:00.000Z")
        .run();
    }
    const n = await d1.prepare("SELECT COUNT(*) AS n FROM vibe_reports WHERE event_id = ?").bind(evId).first();
    expect(n.n).toBe(1);
  });
});
