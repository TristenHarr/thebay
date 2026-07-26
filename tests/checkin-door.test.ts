/**
 * The door code, hardened. Every test here is an attack that used to succeed.
 *
 * What shipped: `checkin_tokens` stores `ulid()+ulid()` in PLAINTEXT with a ONE HOUR
 * TTL, no single-use and no revocation — and the web client put the token in a URL
 * QUERY PARAM and auto-submitted it on mount. So the check-in link was forwardable:
 * send it to a friend in another state and they are checked in, for an hour. "↻ Rotate
 * code" minted a second valid token and left the first one live, which is the opposite
 * of rotating.
 *
 * This file does not fix the deeper problem — there is still no geofence, and the
 * token is still stored in the clear. That is what `event_presence` + `door_codes`
 * are for (migrations/0027), and XP will hang off those rather than off this table.
 * What these tests lock is that the WINDOW is small and that rotation revokes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { PlatformRepo } from "../src/storage/d1/platform-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { CHECKIN_TOKEN_TTL_MS, CHECKIN_ROTATE_MS, checkinUrl, tokenFromUrl } from "../src/core/checkin/door";

let d1: any, raw: Database.Database, platform: PlatformRepo, social: SocialRepo;

beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  platform = new PlatformRepo(d1);
  social = new SocialRepo(d1);
});

const mkUser = async (email: string) =>
  (await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: email })).id;

function mkEvent(id: string) {
  raw
    .prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, categories,
                           content_hash, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'sf-bay', ?, '[]', ?, ?, ?)`,
    )
    .run(id, `fp-${id}`, `Event ${id}`, "2026-07-01T18:00:00Z", `https://x/${id}`, `ch-${id}`, "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
}

describe("door code constants", () => {
  it("keeps the window short enough that a forwarded link is dead on arrival", () => {
    expect(CHECKIN_TOKEN_TTL_MS).toBeLessThanOrEqual(180_000);
    // The host screen must refresh before the code it is displaying expires, or the
    // door goes dark mid-event.
    expect(CHECKIN_ROTATE_MS).toBeLessThan(CHECKIN_TOKEN_TTL_MS);
  });
});

describe("the token rides in the URL fragment", () => {
  it("never puts the token in the query string", () => {
    const url = checkinUrl("https://thebay.events", "evt1", "sekrit");
    // The fragment is the whole point: browsers never send it to a server, so the
    // credential stays out of the Worker's request log, out of `Referer`, and out of
    // anything a CDN records.
    expect(new URL(url).search).toBe("");
    expect(new URL(url).hash).toContain("sekrit");
    expect(url).not.toContain("?token=");
  });

  it("round-trips through the parser", () => {
    const url = checkinUrl("https://thebay.events", "evt1", "abc123");
    expect(tokenFromUrl(url)).toBe("abc123");
  });

  it("is total — garbage and a missing token yield null, never a throw", () => {
    expect(tokenFromUrl("not a url")).toBeNull();
    expect(tokenFromUrl("https://thebay.events/app/event/e1/checkin")).toBeNull();
    expect(tokenFromUrl("https://thebay.events/app/event/e1/checkin#other=1")).toBeNull();
    // A legacy query-param link is NOT honoured: accepting it would keep the leak
    // path open for anything still generating that shape.
    expect(tokenFromUrl("https://thebay.events/app/event/e1/checkin?token=abc")).toBeNull();
  });
});

describe("minting a code revokes the one it replaces", () => {
  it("expires the previous live code for that event", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    const t0 = Date.parse("2026-07-01T18:00:00Z");

    const first = await platform.createCheckinToken("e1", undefined, t0);
    // Rotating is what a host does when they think the screen leaked. It has to mean
    // something — before this, the old code stayed valid for the rest of the hour.
    const second = await platform.createCheckinToken("e1", undefined, t0 + 1000);
    expect(second).not.toBe(first);

    expect(await platform.checkIn(ann, "e1", first, t0 + 2000)).toBe("expired");
    expect(await platform.checkIn(ann, "e1", second, t0 + 2000)).toBe("ok");
  });

  it("scopes revocation to the event — another event's door stays open", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    mkEvent("e2");
    const t0 = Date.parse("2026-07-01T18:00:00Z");

    const other = await platform.createCheckinToken("e2", undefined, t0);
    await platform.createCheckinToken("e1", undefined, t0 + 1000); // rotate e1 only
    expect(await platform.checkIn(ann, "e2", other, t0 + 2000)).toBe("ok");
  });

  it("expires on its own after the TTL, with no rotation at all", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    const t0 = Date.parse("2026-07-01T18:00:00Z");
    const tok = await platform.createCheckinToken("e1", undefined, t0);
    expect(await platform.checkIn(ann, "e1", tok, t0 + CHECKIN_TOKEN_TTL_MS + 1)).toBe("expired");
  });
});

describe("the existing check-in contract is unchanged", () => {
  it("still awards points, opens the review obligation and advances the streak", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    const t0 = Date.parse("2026-07-01T18:00:00Z");
    const tok = await platform.createCheckinToken("e1", undefined, t0);

    expect(await platform.checkIn(ann, "e1", tok, t0 + 500)).toBe("ok");
    expect((raw.prepare("SELECT COUNT(*) n FROM checkins WHERE user_id=? AND event_id='e1'").get(ann) as any).n).toBe(1);
    expect((raw.prepare("SELECT COUNT(*) n FROM points_ledger WHERE user_id=? AND kind='checkin'").get(ann) as any).n).toBe(1);
    expect((raw.prepare("SELECT COUNT(*) n FROM review_obligations WHERE user_id=? AND event_id='e1'").get(ann) as any).n).toBe(1);
    expect((await platform.getStreak(ann, "attend")).count).toBe(1);
  });

  it("still refuses a token minted for a different event, and a second check-in", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent("e1");
    mkEvent("e2");
    const t0 = Date.parse("2026-07-01T18:00:00Z");
    const tok = await platform.createCheckinToken("e1", undefined, t0);

    expect(await platform.checkIn(ann, "e2", tok, t0 + 500)).toBe("invalid");
    expect(await platform.checkIn(ann, "e1", tok, t0 + 500)).toBe("ok");
    expect(await platform.checkIn(ann, "e1", tok, t0 + 600)).toBe("already");
  });
});
