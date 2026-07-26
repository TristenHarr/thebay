/**
 * The gym's invariants, proven at the SQL layer.
 *
 * This file drives RAW SQL and deliberately never touches `GymRepo`. That is the entire
 * point: the claim is not "the repo refuses to overspend", it is "the DATABASE refuses to
 * overspend", so an admin script, a migration, a future repo nobody has written yet, or a
 * bug in the pre-check cannot get around it. If any test here starts needing the repo, the
 * invariant has quietly moved out of the schema and the guarantee is gone.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";

let raw: Database.Database;

const NOW = "2026-07-01T18:00:00Z";

/** Minimal legal world: two users, one event, presence for the attendee, a draft gym. */
function seed(db: Database.Database) {
  db.prepare("INSERT INTO users (id,email,handle,display_name,created_at,updated_at) VALUES ('host','h@x.com','host','Host',?,?)").run(NOW, NOW);
  db.prepare("INSERT INTO users (id,email,handle,display_name,created_at,updated_at) VALUES ('ann','a@x.com','ann','Ann',?,?)").run(NOW, NOW);
  db.prepare("INSERT INTO users (id,email,handle,display_name,created_at,updated_at) VALUES ('bob','b@x.com','bob','Bob',?,?)").run(NOW, NOW);
  db.prepare(
    `INSERT INTO events (id,fingerprint,title,start_utc,timezone,city,url,categories,content_hash,host_user_id,first_seen_at,last_seen_at)
     VALUES ('e1','fp1','Founders Night',?,'America/Los_Angeles','sf-bay','https://x/e1','[]','ch1','host',?,?)`,
  ).run(NOW, NOW, NOW);
  db.prepare("INSERT INTO event_presence (user_id,event_id,lat,lng,first_at,last_at) VALUES ('ann','e1',37.78,-122.40,?,?)").run(NOW, NOW);
  db.prepare(
    "INSERT INTO event_gyms (event_id,host_id,mode,flat_xp,budget,status,created_at) VALUES ('e1','host','flat',50,1000,'draft',?)",
  ).run(NOW);
}

const arm = () => raw.prepare("UPDATE event_gyms SET status='armed', armed_at=? WHERE event_id='e1'").run(NOW);
const settle = () => raw.prepare("UPDATE event_gyms SET status='settled', settled_at=? WHERE event_id='e1'").run(NOW);

function award(id: string, userId: string, xp: number, bountyKey = "", hostId: string | null = "host") {
  raw
    .prepare("INSERT INTO gym_awards (id,event_id,user_id,host_id,bounty_key,xp,awarded_at) VALUES (?,'e1',?,?,?,?,?)")
    .run(id, userId, hostId, bountyKey, xp, NOW);
}
const spent = () => (raw.prepare("SELECT spent FROM event_gyms WHERE event_id='e1'").get() as any).spent;
const awardCount = () => (raw.prepare("SELECT COUNT(*) n FROM gym_awards").get() as any).n;

beforeEach(() => {
  ({ raw } = makeTestDb());
  seed(raw);
});

describe("overspend is a row the database refuses", () => {
  it("blocks an award beyond the budget AND leaves `spent` untouched", () => {
    arm();
    raw.prepare("UPDATE event_gyms SET budget=100 WHERE event_id='e1'").run();

    expect(() => award("a1", "ann", 500)).toThrow();
    // Both halves matter. A partially-applied trigger — award rejected but `spent` moved,
    // or `spent` moved but award rejected — would be far worse than a clean rejection.
    expect(spent()).toBe(0);
    expect(awardCount()).toBe(0);
  });

  it("allows spending exactly to the budget, and nothing past it", () => {
    arm();
    raw.prepare("UPDATE event_gyms SET budget=100 WHERE event_id='e1'").run();
    award("a1", "ann", 100);
    expect(spent()).toBe(100);
    expect(() => award("a2", "ann", 1, "extra")).toThrow();
    expect(spent()).toBe(100);
  });

  it("keeps `spent` correct across insert, reprice and delete", () => {
    arm();
    award("a1", "ann", 200);
    expect(spent()).toBe(200);
    raw.prepare("UPDATE gym_awards SET xp=300 WHERE id='a1'").run();
    expect(spent()).toBe(300);
    raw.prepare("DELETE FROM gym_awards WHERE id='a1'").run();
    expect(spent()).toBe(0);
  });

  it("refuses to shrink the budget below what is already spent", () => {
    arm();
    award("a1", "ann", 400);
    expect(() => raw.prepare("UPDATE event_gyms SET budget=100 WHERE event_id='e1'").run()).toThrow();
    expect((raw.prepare("SELECT budget FROM event_gyms WHERE event_id='e1'").get() as any).budget).toBe(1000);
  });
});

describe("an award requires verified presence", () => {
  it("refuses a recipient with no event_presence row", () => {
    arm();
    // Bob exists and is a real user. He simply never scanned the door.
    expect(() => award("a1", "bob", 50)).toThrow(/FOREIGN KEY/i);
    expect(awardCount()).toBe(0);
  });

  it("accepts them the moment presence exists", () => {
    arm();
    raw.prepare("INSERT INTO event_presence (user_id,event_id,lat,lng,first_at,last_at) VALUES ('bob','e1',37.78,-122.40,?,?)").run(NOW, NOW);
    award("a1", "bob", 50);
    expect(awardCount()).toBe(1);
  });
});

describe("the per-award and per-pair ceilings", () => {
  it("refuses a non-positive or over-ceiling award", () => {
    arm();
    for (const xp of [0, -5, 1001]) {
      expect(() => award(`a${xp}`, "ann", xp), `xp=${xp}`).toThrow();
    }
    award("ok", "ann", 1000); // the ceiling itself is allowed
  });

  it("refuses a host awarding themselves", () => {
    arm();
    raw.prepare("INSERT INTO event_presence (user_id,event_id,lat,lng,first_at,last_at) VALUES ('host','e1',37.78,-122.40,?,?)").run(NOW, NOW);
    expect(() => award("a1", "host", 50, "", "host")).toThrow();
  });

  it("allows one base award plus one per feat, and no duplicates of either", () => {
    arm();
    award("a1", "ann", 50); // base, bounty_key = ''
    award("a2", "ann", 50, "best_demo");
    // The reason bounty_key is NOT NULL DEFAULT '': SQLite treats NULLs as distinct in a
    // UNIQUE, so two nullable base awards would both be accepted.
    expect(() => award("a3", "ann", 50)).toThrow();
    expect(() => award("a4", "ann", 50, "best_demo")).toThrow();
    award("a5", "ann", 50, "loudest_laugh"); // a different feat is fine
  });
});

describe("the gym's lifecycle is enforced, not merely intended", () => {
  it("refuses an award into a draft gym", () => {
    expect(() => award("a1", "ann", 50)).toThrow(/not armed/i);
  });

  it("refuses an award into a settled gym", () => {
    arm();
    settle();
    expect(() => award("a1", "ann", 50)).toThrow(/not armed|settled/i);
  });

  it("refuses an award for an event with no gym at all", () => {
    raw.prepare(
      `INSERT INTO events (id,fingerprint,title,start_utc,timezone,city,url,categories,content_hash,first_seen_at,last_seen_at)
       VALUES ('e2','fp2','No Gym',?,'America/Los_Angeles','sf-bay','https://x/e2','[]','ch2',?,?)`,
    ).run(NOW, NOW, NOW);
    raw.prepare("INSERT INTO event_presence (user_id,event_id,lat,lng,first_at,last_at) VALUES ('ann','e2',37.78,-122.40,?,?)").run(NOW, NOW);
    expect(() =>
      raw
        .prepare("INSERT INTO gym_awards (id,event_id,user_id,host_id,bounty_key,xp,awarded_at) VALUES ('x','e2','ann','host','',50,?)")
        .run(NOW),
    ).toThrow(/not armed/i);
  });

  it("makes a settled gym's awards immutable", () => {
    arm();
    award("a1", "ann", 50);
    settle();
    expect(() => raw.prepare("UPDATE gym_awards SET xp=60 WHERE id='a1'").run()).toThrow(/settled/i);
    expect(() => raw.prepare("DELETE FROM gym_awards WHERE id='a1'").run()).toThrow(/settled/i);
  });

  it("freezes the terms once armed", () => {
    // Editable while draft…
    raw.prepare("UPDATE event_gyms SET flat_xp=75 WHERE event_id='e1'").run();
    arm();
    // …and frozen after. This is what makes the published promise real.
    for (const sql of [
      "UPDATE event_gyms SET mode='discretion' WHERE event_id='e1'",
      "UPDATE event_gyms SET flat_xp=999 WHERE event_id='e1'",
      "UPDATE event_gyms SET bounties_json='[]' WHERE event_id='e1'",
      "UPDATE event_gyms SET recipient_cap=999 WHERE event_id='e1'",
    ]) {
      expect(() => raw.prepare(sql).run(), sql).toThrow(/frozen/i);
    }
    // Budget and spent are NOT terms — they must keep moving as people scan in.
    raw.prepare("UPDATE event_gyms SET budget=2000 WHERE event_id='e1'").run();
  });

  it("keeps status and its timestamps consistent", () => {
    expect(() => raw.prepare("UPDATE event_gyms SET status='armed' WHERE event_id='e1'").run(), "armed needs armed_at").toThrow();
    arm();
    expect(() => raw.prepare("UPDATE event_gyms SET status='settled' WHERE event_id='e1'").run(), "settled needs settled_at").toThrow();
  });

  it("refuses a mode that cannot pay what it advertises", () => {
    expect(() => raw.prepare("UPDATE event_gyms SET mode='flat', flat_xp=0 WHERE event_id='e1'").run()).toThrow();
    expect(() => raw.prepare("UPDATE event_gyms SET mode='bounty', bounties_json='[]' WHERE event_id='e1'").run()).toThrow();
  });
});

describe("door codes", () => {
  const door = (id: string, uses = 0, maxUses = 20, lat = 37.78) =>
    raw
      .prepare("INSERT INTO door_codes (id,event_id,host_id,secret_hash,lat,lng,expires_at,max_uses,uses,created_at) VALUES (?,'e1','host',?,?,-122.40,?,?,?,?)")
      .run(id, `hash-${id}`, lat, NOW, maxUses, uses, NOW);

  it("refuses uses beyond the ceiling", () => {
    door("d1", 0, 3);
    raw.prepare("UPDATE door_codes SET uses=3 WHERE id='d1'").run();
    expect(() => raw.prepare("UPDATE door_codes SET uses=4 WHERE id='d1'").run()).toThrow();
  });

  it("refuses an impossible coordinate — a bad fix must not become a geofence origin", () => {
    expect(() => door("d2", 0, 20, 91)).toThrow();
  });

  it("refuses a duplicate secret hash", () => {
    door("d3");
    expect(() =>
      raw
        .prepare("INSERT INTO door_codes (id,event_id,host_id,secret_hash,lat,lng,expires_at,created_at) VALUES ('d4','e1','host','hash-d3',37.78,-122.40,?,?)")
        .run(NOW, NOW),
    ).toThrow();
  });
});

describe("event_presence", () => {
  it("is once per person per event", () => {
    expect(() =>
      raw.prepare("INSERT INTO event_presence (user_id,event_id,lat,lng,first_at,last_at) VALUES ('ann','e1',37.78,-122.40,?,?)").run(NOW, NOW),
    ).toThrow();
  });

  it("refuses time running backwards for one attendee", () => {
    expect(() =>
      raw.prepare("UPDATE event_presence SET last_at='2026-06-01T00:00:00Z' WHERE user_id='ann' AND event_id='e1'").run(),
    ).toThrow();
  });

  it("carries the awards with it when a dedup merge repoints the event", () => {
    // ON UPDATE CASCADE. Without it, `renormalize` moving a presence row would leave the
    // award pointing at an event id that no longer has a parent row.
    arm();
    award("a1", "ann", 50);
    raw.prepare(
      `INSERT INTO events (id,fingerprint,title,start_utc,timezone,city,url,categories,content_hash,first_seen_at,last_seen_at)
       VALUES ('e9','fp9','Survivor',?,'America/Los_Angeles','sf-bay','https://x/e9','[]','ch9',?,?)`,
    ).run(NOW, NOW, NOW);
    raw.prepare("UPDATE event_presence SET event_id='e9' WHERE user_id='ann' AND event_id='e1'").run();
    expect((raw.prepare("SELECT event_id FROM gym_awards WHERE id='a1'").get() as any).event_id).toBe("e9");
  });
});

describe("event_claims", () => {
  const claim = (id: string, userId: string, status = "pending", reviewedAt: string | null = null) =>
    raw
      .prepare("INSERT INTO event_claims (id,event_id,user_id,evidence,status,reviewed_at,created_at) VALUES (?,'e1',?,'I run it',?,?,?)")
      .run(id, userId, status, reviewedAt, NOW);

  it("allows exactly one APPROVED claim per event", () => {
    claim("c1", "ann", "approved", NOW);
    expect(() => claim("c2", "bob", "approved", NOW)).toThrow();
    // Pending ones can coexist — several people may believe they run an event.
    claim("c3", "bob");
  });

  it("is one claim per person per event", () => {
    claim("c1", "ann");
    expect(() => claim("c2", "ann")).toThrow();
  });

  it("keeps pending and reviewed_at consistent", () => {
    expect(() => claim("c1", "ann", "pending", NOW)).toThrow();
    expect(() => claim("c2", "bob", "approved", null)).toThrow();
  });
});
