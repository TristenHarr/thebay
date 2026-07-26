/**
 * TrophyRepo — the bridge from "what the tables say" to "what you've earned", and the
 * first production writer of `xp_ledger`.
 *
 * The invariants that matter here are all about NOT breaking what already shipped:
 *
 *   · syncing twice must grant nothing the second time, and must not pay XP twice;
 *   · the five legacy kinds granted with a `<kind>:<userId>` dedup key must be
 *     recognised as already-earned, keeping their original `awarded_at`;
 *   · `intro_made` is the odd one out — graph-repo.ts:171 keys it per FORWARD
 *     (`intro_made:<forwardId>`), so a prolific connector already has several rows
 *     for one trophy. The view must collapse them and sync must not add a sixth;
 *   · `shadow_area` must stay invisible as a trophy while still feeding the
 *     cartographer ladder as a metric.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { TrophyRepo } from "../src/storage/d1/trophy-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { XpRepo } from "../src/storage/d1/xp-repo";
import { trophyById } from "../src/core/trophies/catalog";

let d1: any, raw: Database.Database, trophies: TrophyRepo, social: SocialRepo, xp: XpRepo;

beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  trophies = new TrophyRepo(d1);
  social = new SocialRepo(d1);
  xp = new XpRepo(d1);
});

const mkUser = async (email: string) =>
  (await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: email })).id;

/** A minimal but schema-legal event row. */
function mkEvent(id: string, hostId: string | null = null) {
  raw
    .prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, categories,
                           content_hash, host_user_id, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'sf-bay', ?, '[]', ?, ?, ?, ?)`,
    )
    .run(id, `fp-${id}`, `Event ${id}`, "2026-07-01T18:00:00Z", `https://x/${id}`, `ch-${id}`, hostId, "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
}

describe("TrophyRepo — the metric snapshot", () => {
  it("counts from the real tables in one pass", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    mkEvent("e2");
    mkEvent("e3", ann); // hosted

    raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?,?,?,'qr')").run(ann, "e1", "2026-07-01T19:00:00Z");
    raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?,?,?,'qr')").run(ann, "e2", "2026-07-02T19:00:00Z");
    raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)").run(ann, "e1", "2026-06-20T00:00:00Z");
    raw.prepare("INSERT INTO reviews (id, event_id, user_id, rating, created_at) VALUES ('r1',?,?,5,?)").run("e1", ann, "2026-07-02T00:00:00Z");
    raw.prepare("INSERT INTO media (id, user_id, kind, created_at) VALUES ('m1',?, 'photo', ?)").run(ann, "2026-07-01T20:00:00Z");

    const m = await trophies.metrics(ann);
    expect(m.checkins).toBe(2);
    expect(m.rsvps).toBe(1);
    expect(m.reviews).toBe(1);
    expect(m.hosted).toBe(1);
    expect(m.photos).toBe(1);
    // Untouched metrics are 0, never undefined — an undefined would silently fail
    // every `>= threshold` comparison instead of failing loudly.
    expect(m.stories).toBe(0);
    expect(m.friends).toBe(0);
  });

  it("counts accepted friendships from either side of the pair", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    const cid = await mkUser("c@x.com");
    // friendships enforces user_low < user_high, so sort to build legal rows.
    const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]);
    const [l1, h1] = pair(ann, bob);
    const [l2, h2] = pair(ann, cid);
    raw.prepare("INSERT INTO friendships (user_low,user_high,status,requested_by,created_at,updated_at) VALUES (?,?,'accepted',?,?,?)").run(l1, h1, ann, "t", "t");
    raw.prepare("INSERT INTO friendships (user_low,user_high,status,requested_by,created_at,updated_at) VALUES (?,?,'pending',?,?,?)").run(l2, h2, ann, "t", "t");

    const m = await trophies.metrics(ann);
    expect(m.friends, "pending must not count").toBe(1);
  });

  it("reads shadow and connection counts from the points ledger, not the ephemeral tables", async () => {
    // `shadows` rows are deleted on repost and purged at 24h expiry, so the only
    // lifetime record is the once-per-day points row. Same for connections.
    const ann = await mkUser("a@x.com");
    for (const day of ["2026-07-01", "2026-07-02", "2026-07-03"]) {
      raw.prepare("INSERT INTO points_ledger (id,user_id,kind,points,dedup_key,created_at) VALUES (?,?,'shadow',4,?,?)").run(`p${day}`, ann, `shadow:${ann}:${day}`, day);
    }
    raw.prepare("INSERT INTO points_ledger (id,user_id,kind,points,dedup_key,created_at) VALUES ('pc',?,'connection',15,?,?)").run(ann, `connection:${ann}:x`, "t");

    const m = await trophies.metrics(ann);
    expect(m.shadows).toBe(3);
    expect(m.connections).toBe(1);
    expect(m.points).toBe(3 * 4 + 15);
  });

  it("feeds the cartographer ladder from the internal shadow_area counter", async () => {
    const ann = await mkUser("a@x.com");
    for (const area of ["9q8y", "9q9p", "9q8v"]) {
      raw.prepare("INSERT INTO achievements (id,user_id,kind,dedup_key,meta_json,awarded_at) VALUES (?,?,'shadow_area',?,'{}',?)").run(`a${area}`, ann, `shadow_area:${ann}:${area}`, "t");
    }
    expect((await trophies.metrics(ann)).shadowAreas).toBe(3);
  });

  it("reads total XP so the level ladder can be a trophy", async () => {
    const ann = await mkUser("a@x.com");
    await xp.grant(ann, "movement", 250, `m:${ann}:1`);
    expect((await trophies.metrics(ann)).xp).toBe(250);
  });
});

describe("TrophyRepo — granting", () => {
  it("grants the earned set once and pays its XP exactly once", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?,?,?,'qr')").run(ann, "e1", "2026-07-01T19:00:00Z");

    const first = await trophies.sync(ann);
    expect(first.granted).toContain("first_checkin");
    expect(first.xp).toBe(trophyById("first_checkin")!.xp);

    const second = await trophies.sync(ann);
    expect(second.granted, "a second sync must grant nothing").toEqual([]);
    expect(second.xp).toBe(0);

    // One achievement row, one XP row, whatever the caller does.
    expect((raw.prepare("SELECT COUNT(*) n FROM achievements WHERE user_id=? AND kind='first_checkin'").get(ann) as any).n).toBe(1);
    expect((raw.prepare("SELECT COUNT(*) n FROM xp_ledger WHERE user_id=? AND kind='trophy'").get(ann) as any).n).toBe(1);
    expect(await xp.total(ann)).toBe(trophyById("first_checkin")!.xp);
  });

  it("finally grants the three trophies the web catalog promised but nothing awarded", async () => {
    // first_checkin / first_host / super_connector were in Achievements.tsx from the
    // start and granted by NO server code. This test is the regression fence.
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    mkEvent("e2", ann);
    raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?,?,?,'qr')").run(ann, "e1", "t");

    const r = await trophies.sync(ann);
    expect(r.granted).toContain("first_checkin");
    expect(r.granted).toContain("first_host");
  });

  it("respects a legacy grant and keeps its original award date", async () => {
    const ann = await mkUser("a@x.com");
    raw
      .prepare("INSERT INTO achievements (id,user_id,kind,dedup_key,meta_json,awarded_at) VALUES ('old',?,'first_shadow',?,'{}',?)")
      .run(ann, `first_shadow:${ann}`, "2026-01-01T00:00:00Z");
    // Earn it again by the metric route.
    raw.prepare("INSERT INTO points_ledger (id,user_id,kind,points,dedup_key,created_at) VALUES ('p1',?,'shadow',4,?,?)").run(ann, `shadow:${ann}:2026-07-01`, "t");

    const r = await trophies.sync(ann);
    expect(r.granted, "already held").not.toContain("first_shadow");
    expect((raw.prepare("SELECT COUNT(*) n FROM achievements WHERE user_id=? AND kind='first_shadow'").get(ann) as any).n).toBe(1);
    const view = await trophies.view(ann);
    expect(view.progress.find((p) => p.id === "first_shadow")!.awardedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("collapses the duplicate intro_made rows graph-repo keys per forward", async () => {
    const ann = await mkUser("a@x.com");
    for (const fwd of ["f1", "f2", "f3"]) {
      raw.prepare("INSERT INTO achievements (id,user_id,kind,dedup_key,meta_json,awarded_at) VALUES (?,?,'intro_made',?,'{}',?)").run(fwd, ann, `intro_made:${fwd}`, "2026-02-0" + fwd.slice(1) + "T00:00:00Z");
    }
    const view = await trophies.view(ann);
    const rows = view.progress.filter((p) => p.id === "intro_made");
    expect(rows.length, "the trophy case must show one Matchmaker, not three").toBe(1);
    expect(rows[0]!.earned).toBe(true);
    // And sync must not add a fourth row keyed differently.
    const r = await trophies.sync(ann);
    expect(r.granted).not.toContain("intro_made");
    expect((raw.prepare("SELECT COUNT(*) n FROM achievements WHERE user_id=? AND kind='intro_made'").get(ann) as any).n).toBe(3);
  });
});

describe("TrophyRepo — the view", () => {
  it("returns the WHOLE catalog so locked rungs and progress can render", async () => {
    const ann = await mkUser("a@x.com");
    const view = await trophies.view(ann);
    const { TROPHIES } = await import("../src/core/trophies/catalog");
    expect(view.progress.length).toBe(TROPHIES.length);
    expect(view.progress.every((p) => !p.earned)).toBe(true);
    expect(view.nextUp.length).toBeGreaterThan(0);
  });

  it("hides an unearned secret and reveals it once earned", async () => {
    const ann = await mkUser("a@x.com");
    let view = await trophies.view(ann);
    expect(view.progress.find((p) => p.id === "ghost")!.hidden).toBe(true);

    for (let i = 0; i < 200; i++) {
      raw.prepare("INSERT INTO points_ledger (id,user_id,kind,points,dedup_key,created_at) VALUES (?,?,'shadow',4,?,?)").run(`p${i}`, ann, `shadow:${ann}:d${i}`, "t");
    }
    await trophies.sync(ann);
    view = await trophies.view(ann);
    const ghost = view.progress.find((p) => p.id === "ghost")!;
    expect(ghost.earned).toBe(true);
    expect(ghost.hidden).toBe(false);
  });

  it("never surfaces shadow_area as a trophy", async () => {
    const ann = await mkUser("a@x.com");
    raw.prepare("INSERT INTO achievements (id,user_id,kind,dedup_key,meta_json,awarded_at) VALUES ('s1',?,'shadow_area',?,'{}',?)").run(ann, `shadow_area:${ann}:9q8y`, "t");
    const view = await trophies.view(ann);
    expect(view.progress.some((p) => p.id === "shadow_area")).toBe(false);
  });

  it("computes rarity as the share of members holding a trophy", async () => {
    const ann = await mkUser("a@x.com");
    await mkUser("b@x.com");
    await mkUser("c@x.com");
    await mkUser("d@x.com");
    mkEvent("e1");
    raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?,?,?,'qr')").run(ann, "e1", "t");
    await trophies.sync(ann);

    const view = await trophies.view(ann);
    // 1 of 4 members holds it.
    expect(view.progress.find((p) => p.id === "first_checkin")!.rarity).toBeCloseTo(0.25, 5);
    // Nobody holds Ghost.
    expect(view.progress.find((p) => p.id === "ghost")!.rarity).toBe(0);
  });
});
