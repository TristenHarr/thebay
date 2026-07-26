/**
 * GymRepo — the door, the ledger, and the economy end to end.
 *
 * The last test in this file is the one that matters most: two people take turns hosting,
 * stage ten gyms with confederates, and award each other maximally every time. It asserts
 * they cannot escape level 4. That is the collusion bound from `budget.ts`, demonstrated
 * against a real database rather than argued in a comment.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { GymRepo } from "../src/storage/d1/gym-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { XpRepo } from "../src/storage/d1/xp-repo";
import { levelForXp } from "../src/core/xp/levels";
import { DWELL_FULL_MIN } from "../src/core/gym/dwell";
import { PER_RECIPIENT_CAP } from "../src/core/gym/budget";

let d1: any, raw: Database.Database, gyms: GymRepo, social: SocialRepo, xp: XpRepo;

const START = "2026-07-01T18:00:00Z";
const START_MS = Date.parse(START);
const DURING = new Date(START_MS + 30 * 60_000).toISOString();

beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  gyms = new GymRepo(d1);
  social = new SocialRepo(d1);
  xp = new XpRepo(d1);
});

const mkUser = async (email: string) =>
  (await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: email })).id;

function mkEvent(id: string, hostId: string, startUtc = START, endUtc: string | null = "2026-07-01T22:00:00Z") {
  raw
    .prepare(
      `INSERT INTO events (id,fingerprint,title,start_utc,end_utc,timezone,city,url,categories,content_hash,host_user_id,first_seen_at,last_seen_at)
       VALUES (?,?,?,?,?,'America/Los_Angeles','sf-bay',?,'[]',?,?,?,?)`,
    )
    .run(id, `fp-${id}`, `Event ${id}`, startUtc, endUtc, `https://x/${id}`, `ch-${id}`, hostId, START, START);
}

/** Give someone a full-dwell verified presence at an event. */
async function present(userId: string, eventId: string, minutes = DWELL_FULL_MIN, from = DURING) {
  await gyms.recordPresence(userId, eventId, null, { lat: 37.78, lng: -122.4 }, from);
  if (minutes > 0) {
    await gyms.recordPresence(userId, eventId, null, { lat: 37.78, lng: -122.4 }, new Date(Date.parse(from) + minutes * 60_000).toISOString());
  }
}

/** An armed gym with N full-dwell attendees. */
async function armedGym(eventId: string, hostId: string, attendees: string[], flatXp = 100) {
  mkEvent(eventId, hostId);
  for (const a of attendees) await present(a, eventId);
  await gyms.upsertDraft(eventId, hostId, { mode: "flat", flatXp, bounties: [] }, START);
  await gyms.syncBudget(eventId, DURING);
  await gyms.arm(eventId, DURING);
  return (await gyms.gym(eventId))!;
}

describe("the door", () => {
  it("revokes the previous code when a new one is minted", async () => {
    const host = await mkUser("h@x.com");
    mkEvent("e1", host);
    const first = await gyms.mintDoorCode("e1", host, { lat: 37.78, lng: -122.4 }, "hash1", undefined, undefined, START_MS);
    const second = await gyms.mintDoorCode("e1", host, { lat: 37.78, lng: -122.4 }, "hash2", undefined, undefined, START_MS + 1000);

    expect((await gyms.doorCode(first.codeId))!.revoked_at).toBeTruthy();
    expect((await gyms.doorCode(second.codeId))!.revoked_at).toBeNull();
    // A revoked code cannot be consumed, whatever its TTL says.
    expect(await gyms.claimDoorUse(first.codeId, START_MS + 2000)).toBe(false);
    expect(await gyms.claimDoorUse(second.codeId, START_MS + 2000)).toBe(true);
  });

  it("counts uses and refuses the one past the ceiling", async () => {
    const host = await mkUser("h@x.com");
    mkEvent("e1", host);
    const { codeId } = await gyms.mintDoorCode("e1", host, { lat: 37.78, lng: -122.4 }, "h", undefined, 2, START_MS);
    expect(await gyms.claimDoorUse(codeId, START_MS + 1)).toBe(true);
    expect(await gyms.claimDoorUse(codeId, START_MS + 2)).toBe(true);
    expect(await gyms.claimDoorUse(codeId, START_MS + 3)).toBe(false);
  });

  it("gives exactly ONE winner when two phones film the same screen at once", async () => {
    // The atomicity guarantee. A SELECT-then-UPDATE would let both through.
    const host = await mkUser("h@x.com");
    mkEvent("e1", host);
    const { codeId } = await gyms.mintDoorCode("e1", host, { lat: 37.78, lng: -122.4 }, "h", undefined, 1, START_MS);
    const results = await Promise.all([gyms.claimDoorUse(codeId, START_MS + 1), gyms.claimDoorUse(codeId, START_MS + 1)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("refuses an expired code", async () => {
    const host = await mkUser("h@x.com");
    mkEvent("e1", host);
    const { codeId } = await gyms.mintDoorCode("e1", host, { lat: 37.78, lng: -122.4 }, "h", 1000, 20, START_MS);
    expect(await gyms.claimDoorUse(codeId, START_MS + 5000)).toBe(false);
  });
});

describe("presence and dwell", () => {
  it("records the first scan and extends on later ones", async () => {
    const ann = await mkUser("a@x.com");
    const host = await mkUser("h@x.com");
    mkEvent("e1", host);
    await gyms.recordPresence(ann, "e1", null, { lat: 37.78, lng: -122.4 }, DURING);
    await gyms.recordPresence(ann, "e1", null, { lat: 37.78, lng: -122.4 }, new Date(Date.parse(DURING) + 60 * 60_000).toISOString());

    const p = (await gyms.presence(ann, "e1"))!;
    expect(p.first_at).toBe(DURING);
    expect(p.scans).toBe(2);
    expect(Date.parse(p.last_at) - Date.parse(p.first_at)).toBe(60 * 60_000);
  });

  it("never lets an out-of-order scan SHORTEN a stay", async () => {
    const ann = await mkUser("a@x.com");
    const host = await mkUser("h@x.com");
    mkEvent("e1", host);
    const late = new Date(Date.parse(DURING) + 90 * 60_000).toISOString();
    await gyms.recordPresence(ann, "e1", null, { lat: 37.78, lng: -122.4 }, DURING);
    await gyms.recordPresence(ann, "e1", null, { lat: 37.78, lng: -122.4 }, late);
    await gyms.recordPresence(ann, "e1", null, { lat: 37.78, lng: -122.4 }, DURING); // a retry arriving late
    expect((await gyms.presence(ann, "e1"))!.last_at).toBe(late);
  });

  it("caps a longer-dwelling attendee higher than a briefly-present one", async () => {
    const host = await mkUser("h@x.com");
    const stayer = await mkUser("s@x.com");
    const passer = await mkUser("p@x.com");
    const filler = await mkUser("f@x.com");
    mkEvent("e1", host);
    await present(stayer, "e1", DWELL_FULL_MIN);
    await present(passer, "e1", 0); // one scan only ⇒ floor credit
    await present(filler, "e1", DWELL_FULL_MIN);
    await gyms.upsertDraft("e1", host, { mode: "discretion", flatXp: 0, bounties: [] }, START);
    await gyms.syncBudget("e1", DURING);
    await gyms.arm("e1", DURING);
    const gym = (await gyms.gym("e1"))!;
    const ev = await gyms.window("e1");

    const stayerCap = await gyms.capFor(gym, stayer, ev);
    const passerCap = await gyms.capFor(gym, passer, ev);
    expect(stayerCap).toBeGreaterThan(passerCap);
    expect(passerCap).toBeGreaterThan(0); // showing up properly is still worth something
  });
});

describe("awarding", () => {
  it("mints exactly one ledger row per award and keeps `spent` in step", async () => {
    const host = await mkUser("h@x.com");
    const [a, b, c] = [await mkUser("a@x.com"), await mkUser("b@x.com"), await mkUser("c@x.com")];
    await armedGym("e1", host, [a, b, c]);

    const r = await gyms.award({ eventId: "e1", hostId: host, userId: a, xp: 100 }, DURING);
    expect(r.result).toBe("ok");
    expect(await xp.total(a)).toBe(100);
    expect((await gyms.gym("e1"))!.spent).toBe(100);
    expect((raw.prepare("SELECT COUNT(*) n FROM xp_ledger WHERE user_id=? AND kind='gym'").get(a) as any).n).toBe(1);
  });

  it("refuses somebody who never scanned in", async () => {
    const host = await mkUser("h@x.com");
    const [a, b, c] = [await mkUser("a@x.com"), await mkUser("b@x.com"), await mkUser("c@x.com")];
    const ghost = await mkUser("g@x.com");
    await armedGym("e1", host, [a, b, c]);
    expect((await gyms.award({ eventId: "e1", hostId: host, userId: ghost, xp: 50 }, DURING)).result).toBe("not_present");
  });

  it("refuses the host awarding themselves", async () => {
    const host = await mkUser("h@x.com");
    const [a, b, c] = [await mkUser("a@x.com"), await mkUser("b@x.com"), await mkUser("c@x.com")];
    await armedGym("e1", host, [a, b, c]);
    await present(host, "e1");
    expect((await gyms.award({ eventId: "e1", hostId: host, userId: host, xp: 50 }, DURING)).result).toBe("self");
  });

  it("refuses a draft gym and a settled one", async () => {
    const host = await mkUser("h@x.com");
    const [a, b, c] = [await mkUser("a@x.com"), await mkUser("b@x.com"), await mkUser("c@x.com")];
    mkEvent("e1", host);
    for (const u of [a, b, c]) await present(u, "e1");
    await gyms.upsertDraft("e1", host, { mode: "flat", flatXp: 50, bounties: [] }, START);
    await gyms.syncBudget("e1", DURING);
    expect((await gyms.award({ eventId: "e1", hostId: host, userId: a, xp: 50 }, DURING)).result).toBe("not_armed");

    await gyms.arm("e1", DURING);
    await gyms.settle("e1", DURING);
    // Distinct from `not_armed` on purpose — a closed gym and an unpublished one need
    // different copy at the door.
    expect((await gyms.award({ eventId: "e1", hostId: host, userId: a, xp: 50 }, DURING)).result).toBe("already_settled");
  });

  it("refuses an award outside the event's window", async () => {
    const host = await mkUser("h@x.com");
    const [a, b, c] = [await mkUser("a@x.com"), await mkUser("b@x.com"), await mkUser("c@x.com")];
    await armedGym("e1", host, [a, b, c]);
    const wayLater = new Date(START_MS + 30 * 86_400_000).toISOString();
    expect((await gyms.award({ eventId: "e1", hostId: host, userId: a, xp: 50 }, wayLater)).result).toBe("outside_window");
  });

  it("refuses more than the recipient cap, and reports the cap so the UI can show it", async () => {
    const host = await mkUser("h@x.com");
    const [a, b, c] = [await mkUser("a@x.com"), await mkUser("b@x.com"), await mkUser("c@x.com")];
    await armedGym("e1", host, [a, b, c]);
    const r = await gyms.award({ eventId: "e1", hostId: host, userId: a, xp: PER_RECIPIENT_CAP + 1 }, DURING);
    expect(r.result).toBe("over_cap");
    expect(r.cap).toBeGreaterThan(0);
  });

  it("refuses to exceed the budget — and 409s rather than throwing", async () => {
    const host = await mkUser("h@x.com");
    const [a, b, c] = [await mkUser("a@x.com"), await mkUser("b@x.com"), await mkUser("c@x.com")];
    const gym = await armedGym("e1", host, [a, b, c]);
    // Spend almost everything on the first two, then ask for more than is left.
    let left = gym.budget;
    for (const u of [a, b]) {
      const take = Math.min(await gyms.capFor(gym, u, await gyms.window("e1")), left);
      if (take > 0) await gyms.award({ eventId: "e1", hostId: host, userId: u, xp: take }, DURING);
      left -= take;
    }
    const after = (await gyms.gym("e1"))!;
    const r = await gyms.award({ eventId: "e1", hostId: host, userId: c, xp: after.budget - after.spent + 1 }, DURING);
    expect(["over_budget", "over_cap", "no_budget"]).toContain(r.result);
    // Nothing partially applied.
    expect((await gyms.gym("e1"))!.spent).toBe(after.spent);
  });

  it("refuses a duplicate base award but allows a separate feat", async () => {
    const host = await mkUser("h@x.com");
    const [a, b, c] = [await mkUser("a@x.com"), await mkUser("b@x.com"), await mkUser("c@x.com")];
    await armedGym("e1", host, [a, b, c]);
    expect((await gyms.award({ eventId: "e1", hostId: host, userId: a, xp: 50 }, DURING)).result).toBe("ok");
    expect((await gyms.award({ eventId: "e1", hostId: host, userId: a, xp: 50 }, DURING)).result).toBe("duplicate");
    expect((await gyms.award({ eventId: "e1", hostId: host, userId: a, xp: 50, bountyKey: "best_demo" }, DURING)).result).toBe("ok");
  });
});

describe("revoking", () => {
  it("writes a compensating NEGATIVE ledger row rather than deleting history", async () => {
    const host = await mkUser("h@x.com");
    const [a, b, c] = [await mkUser("a@x.com"), await mkUser("b@x.com"), await mkUser("c@x.com")];
    await armedGym("e1", host, [a, b, c]);
    const r = await gyms.award({ eventId: "e1", hostId: host, userId: a, xp: 120 }, DURING);
    expect(await xp.total(a)).toBe(120);

    expect(await gyms.revokeAward("e1", r.awardId!, "awarded the wrong person")).toBe(true);
    expect(await xp.total(a)).toBe(0);
    // Two rows, netting to zero. The ledger is append-only; nothing was erased.
    expect((raw.prepare("SELECT COUNT(*) n FROM xp_ledger WHERE user_id=? AND kind='gym'").get(a) as any).n).toBe(2);
    // Budget is freed by the refund trigger.
    expect((await gyms.gym("e1"))!.spent).toBe(0);
  });

  it("reconciles to zero delta after award, revoke and re-award", async () => {
    const host = await mkUser("h@x.com");
    const [a, b, c] = [await mkUser("a@x.com"), await mkUser("b@x.com"), await mkUser("c@x.com")];
    await armedGym("e1", host, [a, b, c]);
    const r1 = await gyms.award({ eventId: "e1", hostId: host, userId: a, xp: 100 }, DURING);
    await gyms.revokeAward("e1", r1.awardId!, "oops");
    await gyms.award({ eventId: "e1", hostId: host, userId: b, xp: 80 }, DURING);

    const rows = await gyms.audit("e1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta, "ledger and awards must agree").toBe(0);
  });
});

describe("the budget", () => {
  it("is zero until enough people have verifiably shown up", async () => {
    const host = await mkUser("h@x.com");
    const a = await mkUser("a@x.com");
    mkEvent("e1", host);
    await present(a, "e1");
    await gyms.upsertDraft("e1", host, { mode: "flat", flatXp: 50, bounties: [] }, START);
    expect((await gyms.syncBudget("e1", DURING)).budget).toBe(0);

    for (const e of ["b@x.com", "c@x.com"]) await present(await mkUser(e), "e1");
    expect((await gyms.syncBudget("e1", DURING)).budget).toBeGreaterThan(0);
  });

  it("grows as more people scan in", async () => {
    const host = await mkUser("h@x.com");
    mkEvent("e1", host);
    for (const e of ["a@x.com", "b@x.com", "c@x.com"]) await present(await mkUser(e), "e1");
    await gyms.upsertDraft("e1", host, { mode: "flat", flatXp: 50, bounties: [] }, START);
    const before = (await gyms.syncBudget("e1", DURING)).budget;
    for (const e of ["d@x.com", "e@x.com"]) await present(await mkUser(e), "e1");
    expect((await gyms.syncBudget("e1", DURING)).budget).toBeGreaterThan(before);
  });

  it("THROWS rather than silently leaving minted XP unbacked", async () => {
    const host = await mkUser("h@x.com");
    const [a, b, c] = [await mkUser("a@x.com"), await mkUser("b@x.com"), await mkUser("c@x.com")];
    await armedGym("e1", host, [a, b, c]);
    await gyms.award({ eventId: "e1", hostId: host, userId: a, xp: 200 }, DURING);
    // A presence row turns out to be fraudulent and is removed, so the budget shrinks
    // below what has already been spent. The CHECK refuses, forcing a revoke first.
    raw.prepare("DELETE FROM event_presence WHERE user_id=? AND event_id='e1'").run(b);
    raw.prepare("DELETE FROM event_presence WHERE user_id=? AND event_id='e1'").run(c);
    await expect(gyms.syncBudget("e1", DURING)).rejects.toThrow();
    expect((await gyms.gym("e1"))!.spent).toBe(200);
  });

  it("gives a quarantined host nothing", async () => {
    const host = await mkUser("h@x.com");
    const [a, b, c] = [await mkUser("a@x.com"), await mkUser("b@x.com"), await mkUser("c@x.com")];
    mkEvent("e1", host);
    for (const u of [a, b, c]) await present(u, "e1");
    raw.prepare("UPDATE users SET banned_at = ? WHERE id = ?").run(START, host);
    await gyms.upsertDraft("e1", host, { mode: "flat", flatXp: 50, bounties: [] }, START);
    expect((await gyms.syncBudget("e1", DURING)).budget).toBe(0);
  });
});

describe("the roster", () => {
  it("gives the host every attendee with dwell, what they got, and what's left", async () => {
    const host = await mkUser("h@x.com");
    const [a, b, c] = [await mkUser("a@x.com"), await mkUser("b@x.com"), await mkUser("c@x.com")];
    await armedGym("e1", host, [a, b, c]);
    await gyms.award({ eventId: "e1", hostId: host, userId: a, xp: 100 }, DURING);

    const roster = await gyms.roster("e1");
    expect(roster).toHaveLength(3);
    const rowA = roster.find((r) => r.userId === a)!;
    expect(rowA.awarded).toBe(100);
    expect(rowA.priorAwards).toBe(1);
    expect(rowA.dwellMultiplier).toBe(1);
    // Already paid once, so the ladder has stepped down for the next award.
    expect(rowA.remainingCap).toBeLessThan(roster.find((r) => r.userId === b)!.remainingCap);
  });
});

describe("COLLUSION: two hosts taking turns cannot escape level 4", () => {
  it("bounds what one host can ever mint to one person, across ten staged gyms", async () => {
    const ann = await mkUser("ann@x.com");
    const bob = await mkUser("bob@x.com");
    // Three confederates so every gym clears the attendance floor. This is already the
    // expensive part of the attack: each one is a real account that must physically scan
    // the door at each event.
    const mules = await Promise.all(["m1@x.com", "m2@x.com", "m3@x.com"].map(mkUser));

    for (let i = 0; i < 10; i++) {
      const host = i % 2 === 0 ? ann : bob;
      const target = i % 2 === 0 ? bob : ann;
      const eventId = `e${i}`;
      const start = new Date(START_MS + i * 86_400_000).toISOString();
      const during = new Date(Date.parse(start) + 30 * 60_000).toISOString();
      mkEvent(eventId, host, start, new Date(Date.parse(start) + 4 * 3600_000).toISOString());
      for (const u of [target, ...mules]) await present(u, eventId, DWELL_FULL_MIN, during);
      await gyms.upsertDraft(eventId, host, { mode: "discretion", flatXp: 0, bounties: [] }, start);
      await gyms.syncBudget(eventId, during);
      await gyms.arm(eventId, during);

      const gym = (await gyms.gym(eventId))!;
      const cap = await gyms.capFor(gym, target, await gyms.window(eventId));
      const take = Math.min(cap, gym.budget - gym.spent);
      if (take > 0) await gyms.award({ eventId, hostId: host, userId: target, xp: take }, during);
      await gyms.settle(eventId, during);
    }

    // Each of them received five awards from the other, halving each time.
    for (const u of [ann, bob]) {
      const total = await xp.total(u);
      expect(total, "collusion payoff").toBeLessThanOrEqual(994);
      expect(levelForXp(total), "ten staged events buys level 4 at most").toBeLessThanOrEqual(4);
    }
  });
});
