/**
 * Per-event authorization. Before `src/auth/host.ts` this was a two-line comparison
 * duplicated verbatim in two handlers, and every host-gated route added was another
 * chance to write it subtly differently.
 *
 * The case worth a test of its own is the NULL one. `events.host_user_id` is nullable and
 * the vast majority of the catalog is scraped, so it IS null — and the natural-looking
 * check `event.host_user_id === user?.id` returns TRUE when both sides are undefined.
 * That is a hole that hands a scraped event's gym to any signed-out visitor.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { isHost } from "../src/auth/host";
import { SocialRepo } from "../src/storage/d1/social-repo";

let d1: any, raw: Database.Database, social: SocialRepo;
beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  social = new SocialRepo(d1);
});

const mkUser = async (email: string) =>
  (await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: email })).id;

function mkEvent(db: Database.Database, id: string, hostId: string | null, startUtc = "2026-07-01T18:00:00Z") {
  db.prepare(
    `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, categories,
                         content_hash, host_user_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'sf-bay', ?, '[]', ?, ?, ?, ?)`,
  ).run(id, `fp-${id}`, `Event ${id}`, startUtc, `https://x/${id}`, `ch-${id}`, hostId, "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
}

describe("isHost", () => {
  it("is true only for the actual host", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    mkEvent(raw, "e1", ann);
    expect(await isHost(d1, "e1", ann)).toBe(true);
    expect(await isHost(d1, "e1", bob)).toBe(false);
  });

  it("is FALSE for a scraped event, for every caller — including nullish ones", () => {
    // The whole reason this file exists. `undefined === undefined` is true, so a check
    // written the obvious way would hand a scraped event to an anonymous visitor.
    mkEvent(raw, "scraped", null);
    return Promise.all([
      expect(isHost(d1, "scraped", null)).resolves.toBe(false),
      expect(isHost(d1, "scraped", undefined)).resolves.toBe(false),
      expect(isHost(d1, "scraped", "")).resolves.toBe(false),
    ]);
  });

  it("is false for a missing event and a blank id", async () => {
    const ann = await mkUser("a@x.com");
    expect(await isHost(d1, "nope", ann)).toBe(false);
    expect(await isHost(d1, "", ann)).toBe(false);
  });
});

describe("requireHost — through the real routes it now guards", () => {
  let t: TestApp;
  beforeEach(() => {
    t = makeTestApp();
  });

  it("still 401s anonymously and 403s a non-host with the same body as before", async () => {
    const { user } = await login(t, "host@x.com", "Host");
    mkEvent(t.raw, "e1", user.id);

    expect((await call(t, "/api/events/e1/checkin-token", { method: "POST" })).status).toBe(401);

    const other = await login(t, "other@x.com", "Other");
    const r = await call(t, "/api/events/e1/checkin-token", { method: "POST", cookie: other.cookie });
    expect(r.status).toBe(403);
    // Byte-identical to the string the two migrated call sites returned — the refactor
    // was about having one implementation, not about changing the contract.
    expect(r.json).toEqual({ error: "host only" });
  });

  it("lets the host through on both migrated routes", async () => {
    const { cookie, user } = await login(t, "host@x.com", "Host");
    mkEvent(t.raw, "e1", user.id);

    const tok = await call(t, "/api/events/e1/checkin-token", { method: "POST", cookie });
    expect(tok.status).toBe(200);
    expect(tok.json.token).toBeTruthy();

    const roster = await call(t, "/api/events/e1/checkins", { cookie });
    expect(roster.status).toBe(200);
    expect(roster.json.count).toBe(0);
  });

  it("403s on a SCRAPED event rather than 500ing or letting it through", async () => {
    const { cookie } = await login(t);
    mkEvent(t.raw, "scraped", null);
    const r = await call(t, "/api/events/scraped/checkin-token", { method: "POST", cookie });
    expect(r.status).toBe(403);
  });
});

describe("SocialRepo.hostedEvents", () => {
  it("returns only the events you host, newest first", async () => {
    const ann = await mkUser("a@x.com");
    const bob = await mkUser("b@x.com");
    mkEvent(raw, "mine-old", ann, "2026-07-01T18:00:00Z");
    mkEvent(raw, "mine-new", ann, "2026-08-01T18:00:00Z");
    mkEvent(raw, "theirs", bob, "2026-07-15T18:00:00Z");
    mkEvent(raw, "scraped", null, "2026-07-20T18:00:00Z");

    const rows = await social.hostedEvents(ann);
    expect(rows.map((r) => r.id)).toEqual(["mine-new", "mine-old"]);
  });

  it("excludes hidden events — a moderated event is not a room you run", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent(raw, "e1", ann);
    raw.prepare("UPDATE events SET hidden = 1 WHERE id = 'e1'").run();
    expect(await social.hostedEvents(ann)).toEqual([]);
  });

  it("filters to upcoming when asked", async () => {
    const ann = await mkUser("a@x.com");
    mkEvent(raw, "past", ann, "2020-01-01T18:00:00Z");
    mkEvent(raw, "future", ann, "2099-01-01T18:00:00Z");
    const rows = await social.hostedEvents(ann, { upcoming: true });
    expect(rows.map((r) => r.id)).toEqual(["future"]);
  });
});
