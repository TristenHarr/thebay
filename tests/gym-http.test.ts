/**
 * The gym over HTTP.
 *
 * The assertion that matters most here is the STATUS CODE on a refused award. An
 * over-budget insert raises a CHECK constraint error inside a trigger, and if that error
 * is not caught and mapped it surfaces as a 500 — which is the single likeliest real bug in
 * this feature, because the schema is doing exactly the right thing and the API is the part
 * that looks broken.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { DWELL_FULL_MIN } from "../src/core/gym/dwell";
import { parseDoorUrl } from "../src/core/gym/presence";

let t: TestApp;

/**
 * These dates are NOW-RELATIVE, deliberately.
 *
 * The routes judge every door claim and every award against `Date.now()` — the event
 * window is a real gate (`canAward`, `checkPresence`), and it is one of the things this
 * suite is here to prove works. A fixed calendar date in the fixture would therefore make
 * the whole file start failing the moment it drifted into the past, which is exactly what
 * happened while writing it. The event is in progress: it started half an hour ago and runs
 * for another three hours.
 */
const NOW = Date.now();
const START = new Date(NOW - 30 * 60_000).toISOString();
const END = new Date(NOW + 3 * 3600_000).toISOString();
const AT_DOOR = { lat: 37.7825, lng: -122.4058 };

beforeEach(() => {
  t = makeTestApp();
});

function mkEvent(id: string, hostId: string | null, startUtc = START) {
  t.raw
    .prepare(
      `INSERT INTO events (id,fingerprint,title,start_utc,end_utc,timezone,city,url,categories,content_hash,host_user_id,first_seen_at,last_seen_at)
       VALUES (?,?,?,?,?,'America/Los_Angeles','sf-bay',?,'[]',?,?,?,?)`,
    )
    .run(id, `fp-${id}`, `Event ${id}`, startUtc, END, `https://x/${id}`, `ch-${id}`, hostId, START, START);
}

/** Presence straight into the table — the door path is exercised separately. */
function present(userId: string, eventId: string, minutes = DWELL_FULL_MIN) {
  const first = START;
  const last = new Date(Date.parse(first) + minutes * 60_000).toISOString();
  t.raw
    .prepare("INSERT INTO event_presence (user_id,event_id,lat,lng,first_at,last_at,scans) VALUES (?,?,?,?,?,?,2)")
    .run(userId, eventId, AT_DOOR.lat, AT_DOOR.lng, first, last);
}

const policy = (cookie: string, id: string, body: unknown) => call(t, `/api/events/${id}/gym`, { method: "PUT", cookie, body });

describe("guards", () => {
  it("401s anonymously on every write", async () => {
    mkEvent("e1", null);
    for (const [path, method] of [
      ["/api/events/e1/gym", "PUT"],
      ["/api/events/e1/gym/arm", "POST"],
      ["/api/events/e1/gym/settle", "POST"],
      ["/api/events/e1/gym/awards", "POST"],
      ["/api/events/e1/door", "POST"],
      ["/api/events/e1/presence", "POST"],
    ] as const) {
      expect((await call(t, path, { method, body: {} })).status, path).toBe(401);
    }
    for (const path of ["/api/gyms/hosted", "/api/me/gym-awards", "/api/events/e1/gym/roster"]) {
      expect((await call(t, path)).status, path).toBe(401);
    }
  });

  it("403s a non-host trying to open a gym on someone else's event", async () => {
    const host = await login(t, "host@x.com", "Host");
    mkEvent("e1", host.user.id);
    const other = await login(t, "other@x.com", "Other");
    const r = await policy(other.cookie, "e1", { mode: "flat", flatXp: 50 });
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: "host only" });
  });

  it("403s on a SCRAPED event — not 500, and certainly not 200", async () => {
    // Most of the catalog is scraped and hosted by nobody. This is the case a naive
    // `event.host_user_id === user?.id` check would wave through.
    const me = await login(t);
    mkEvent("scraped", null);
    expect((await policy(me.cookie, "scraped", { mode: "flat", flatXp: 50 })).status).toBe(403);
  });
});

describe("declaring and publishing terms", () => {
  it("rejects a policy that cannot pay what it promises", async () => {
    const host = await login(t);
    mkEvent("e1", host.user.id);
    expect((await policy(host.cookie, "e1", { mode: "flat", flatXp: 0 })).status).toBe(400);
    expect((await policy(host.cookie, "e1", { mode: "bounty", bounties: [] })).status).toBe(400);
    // 'none' is a legitimate declaration.
    expect((await policy(host.cookie, "e1", { mode: "none" })).status).toBe(200);
  });

  it("normalises a hand-typed bounty key", async () => {
    const host = await login(t);
    mkEvent("e1", host.user.id);
    const r = await policy(host.cookie, "e1", { mode: "bounty", bounties: [{ key: "Best Demo!", label: "Best demo", xp: 250 }] });
    expect(r.status).toBe(200);
    expect(r.json.gym.bounties[0].key).toBe("best_demo");
    expect(r.json.gym.bounties[0].xp).toBe(250);
  });

  it("REJECTS an over-ceiling price at the boundary rather than silently clamping it", async () => {
    // The division of labour: zod refuses bad INPUT with a 400, because a host who typed
    // 5000 needs to be told it became 1000 rather than discovering it later. `parseBounties`
    // clamps on READ instead, because a malformed stored row (an older schema, a migration,
    // a bug) must not be able to break the gym for everyone looking at it.
    const host = await login(t);
    mkEvent("e1", host.user.id);
    const r = await policy(host.cookie, "e1", { mode: "bounty", bounties: [{ key: "big", label: "Big", xp: 5000 }] });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid policy");
  });

  it("freezes the terms once armed, with a 409 rather than a 500", async () => {
    const host = await login(t);
    mkEvent("e1", host.user.id);
    await policy(host.cookie, "e1", { mode: "flat", flatXp: 50 });
    for (const e of ["a@x.com", "b@x.com", "c@x.com"]) present((await login(t, e, e)).user.id, "e1");
    expect((await call(t, "/api/events/e1/gym/arm", { method: "POST", cookie: host.cookie })).status).toBe(200);

    const r = await policy(host.cookie, "e1", { mode: "flat", flatXp: 999 });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/frozen/i);
  });

  it("hides a draft gym from attendees but shows armed terms", async () => {
    const host = await login(t);
    mkEvent("e1", host.user.id);
    await policy(host.cookie, "e1", { mode: "flat", flatXp: 50 });
    const attendee = await login(t, "a@x.com", "A");

    expect((await call(t, "/api/events/e1/gym", { cookie: attendee.cookie })).json.gym, "a draft is not a promise").toBeNull();

    for (const e of ["a@x.com", "b@x.com", "c@x.com"]) present((await login(t, e, e)).user.id, "e1");
    await call(t, "/api/events/e1/gym/arm", { method: "POST", cookie: host.cookie });

    const seen = await call(t, "/api/events/e1/gym", { cookie: attendee.cookie });
    expect(seen.json.gym.mode).toBe("flat");
    expect(seen.json.gym.flatXp).toBe(50);
    // An attendee must never see the budget or the roster.
    expect(seen.json.gym.budget).toBeUndefined();
    expect(seen.json.roster).toBeUndefined();
  });
});

describe("awarding over HTTP", () => {
  async function armedGym(flatXp = 100) {
    const host = await login(t, "host@x.com", "Host");
    mkEvent("e1", host.user.id);
    const attendees = [];
    for (const e of ["a@x.com", "b@x.com", "c@x.com"]) {
      const u = await login(t, e, e);
      present(u.user.id, "e1");
      attendees.push(u.user.id);
    }
    await policy(host.cookie, "e1", { mode: "flat", flatXp });
    await call(t, "/api/events/e1/gym/arm", { method: "POST", cookie: host.cookie });
    return { host, attendees };
  }

  it("awards, and reports the budget back so the meter can move", async () => {
    const { host, attendees } = await armedGym();
    const r = await call(t, "/api/events/e1/gym/awards", { method: "POST", cookie: host.cookie, body: { userId: attendees[0], xp: 100 } });
    expect(r.status).toBe(200);
    expect(r.json.result).toBe("ok");
    expect(r.json.spent).toBe(100);
  });

  it("409s an over-cap award with the cap attached — NEVER a 500", async () => {
    const { host, attendees } = await armedGym();
    const r = await call(t, "/api/events/e1/gym/awards", { method: "POST", cookie: host.cookie, body: { userId: attendees[0], xp: 1000 } });
    expect(r.status).toBe(409);
    expect(r.json.result).toBe("over_cap");
    expect(r.json.cap).toBeGreaterThan(0);
  });

  it("409s awarding someone who never scanned in", async () => {
    const { host } = await armedGym();
    const ghost = await login(t, "ghost@x.com", "Ghost");
    const r = await call(t, "/api/events/e1/gym/awards", { method: "POST", cookie: host.cookie, body: { userId: ghost.user.id, xp: 50 } });
    expect(r.status).toBe(409);
    expect(r.json.result).toBe("not_present");
  });

  it("403s a host awarding themselves", async () => {
    const { host } = await armedGym();
    present(host.user.id, "e1");
    const r = await call(t, "/api/events/e1/gym/awards", { method: "POST", cookie: host.cookie, body: { userId: host.user.id, xp: 50 } });
    expect(r.status).toBe(403);
    expect(r.json.result).toBe("self");
  });

  it("409s a duplicate award and distinguishes a settled gym from an unarmed one", async () => {
    const { host, attendees } = await armedGym();
    await call(t, "/api/events/e1/gym/awards", { method: "POST", cookie: host.cookie, body: { userId: attendees[0], xp: 50 } });
    const dup = await call(t, "/api/events/e1/gym/awards", { method: "POST", cookie: host.cookie, body: { userId: attendees[0], xp: 50 } });
    expect(dup.status).toBe(409);
    expect(dup.json.result).toBe("duplicate");

    await call(t, "/api/events/e1/gym/settle", { method: "POST", cookie: host.cookie });
    const after = await call(t, "/api/events/e1/gym/awards", { method: "POST", cookie: host.cookie, body: { userId: attendees[1], xp: 50 } });
    expect(after.status).toBe(409);
    expect(after.json.result).toBe("already_settled");
  });

  it("bulk-awards with a per-person verdict, and refuses a batch over 80", async () => {
    const { host, attendees } = await armedGym(60);
    const r = await call(t, "/api/events/e1/gym/awards/bulk", {
      method: "POST",
      cookie: host.cookie,
      body: { awards: attendees.map((userId) => ({ userId })) },
    });
    expect(r.status).toBe(200);
    expect(r.json.granted).toBe(3);
    expect(r.json.results.every((x: any) => x.result === "ok")).toBe(true);

    // The 80-row cap exists because the D1 test shim enforces the 100-bound-param limit.
    const tooMany = await call(t, "/api/events/e1/gym/awards/bulk", {
      method: "POST",
      cookie: host.cookie,
      body: { awards: Array.from({ length: 200 }, () => ({ userId: attendees[0] })) },
    });
    expect(tooMany.status).toBe(400);
  });

  it("revokes with a reason, and requires one", async () => {
    const { host, attendees } = await armedGym();
    const a = await call(t, "/api/events/e1/gym/awards", { method: "POST", cookie: host.cookie, body: { userId: attendees[0], xp: 100 } });
    const id = a.json.awardId;

    expect((await call(t, `/api/events/e1/gym/awards/${id}`, { method: "DELETE", cookie: host.cookie, body: {} })).status).toBe(400);
    const ok = await call(t, `/api/events/e1/gym/awards/${id}`, { method: "DELETE", cookie: host.cookie, body: { reason: "wrong person" } });
    expect(ok.status).toBe(200);
    // XP nets to zero via a compensating row, not a delete.
    const xp = await call(t, "/api/me/xp", { cookie: (await login(t, "a@x.com", "a@x.com")).cookie });
    expect(xp.json.xp).toBe(0);
  });
});

describe("the door, end to end", () => {
  it("mints a code whose secret is in the FRAGMENT, and admits somebody standing there", async () => {
    const host = await login(t, "host@x.com", "Host");
    mkEvent("e1", host.user.id);
    const mint = await call(t, "/api/events/e1/door", { method: "POST", cookie: host.cookie, body: AT_DOOR });
    expect(mint.status).toBe(200);
    // The credential must never reach a request log.
    expect(new URL(mint.json.url).search).toBe("");
    const parsed = parseDoorUrl(mint.json.url)!;
    expect(parsed.codeId).toBe(mint.json.codeId);

    const attendee = await login(t, "a@x.com", "A");
    const claim = await call(t, "/api/events/e1/presence", {
      method: "POST",
      cookie: attendee.cookie,
      body: { codeId: parsed.codeId, secret: parsed.secret, ...AT_DOOR },
    });
    expect(claim.status).toBe(200);
    expect(claim.json.result).toBe("ok");

    // …and it granted the SOCIAL credit too, so the review-gate didn't regress.
    const ach = await call(t, "/api/me/achievements", { cookie: attendee.cookie });
    expect(ach.json.points.some((p: any) => p.kind === "checkin")).toBe(true);
  });

  it("REFUSES A FORWARDED LINK claimed from out of region", async () => {
    const host = await login(t, "host@x.com", "Host");
    mkEvent("e1", host.user.id);
    const mint = await call(t, "/api/events/e1/door", { method: "POST", cookie: host.cookie, body: AT_DOOR });
    const parsed = parseDoorUrl(mint.json.url)!;

    const remote = await login(t, "far@x.com", "Far");
    const r = await call(t, "/api/events/e1/presence", {
      method: "POST",
      cookie: remote.cookie,
      body: { codeId: parsed.codeId, secret: parsed.secret, lat: 40.7128, lng: -74.006 },
    });
    expect(r.status).toBe(403);
    expect(r.json.result).toBe("out_of_region");
  });

  it("refuses a wrong secret and an unknown code identically", async () => {
    const host = await login(t, "host@x.com", "Host");
    mkEvent("e1", host.user.id);
    const mint = await call(t, "/api/events/e1/door", { method: "POST", cookie: host.cookie, body: AT_DOOR });
    const attendee = await login(t, "a@x.com", "A");

    const bad = await call(t, "/api/events/e1/presence", {
      method: "POST",
      cookie: attendee.cookie,
      body: { codeId: mint.json.codeId, secret: "x".repeat(43), ...AT_DOOR },
    });
    const unknown = await call(t, "/api/events/e1/presence", {
      method: "POST",
      cookie: attendee.cookie,
      body: { codeId: "01NOPE", secret: "x".repeat(43), ...AT_DOOR },
    });
    // Identical answers: distinguishing them would confirm which codes exist.
    expect(bad.status).toBe(410);
    expect(unknown.status).toBe(410);
    expect(bad.json.result).toBe(unknown.json.result);
  });

  it("lets a re-scan extend dwell WITHOUT consuming another use", async () => {
    const host = await login(t, "host@x.com", "Host");
    mkEvent("e1", host.user.id);
    const mint = await call(t, "/api/events/e1/door", { method: "POST", cookie: host.cookie, body: AT_DOOR });
    const p = parseDoorUrl(mint.json.url)!;
    const attendee = await login(t, "a@x.com", "A");

    const body = { codeId: p.codeId, secret: p.secret, ...AT_DOOR };
    await call(t, "/api/events/e1/presence", { method: "POST", cookie: attendee.cookie, body });
    const second = await call(t, "/api/events/e1/presence", { method: "POST", cookie: attendee.cookie, body });
    expect(second.status).toBe(200);
    expect(second.json.scans).toBe(2);
    // Otherwise a 20-use code is spent by four people scanning five times each.
    expect((t.raw.prepare("SELECT uses FROM door_codes WHERE id = ?").get(p.codeId) as any).uses).toBe(1);
  });

  it("refuses to open a door from outside the Bay", async () => {
    const host = await login(t, "host@x.com", "Host");
    mkEvent("e1", host.user.id);
    const r = await call(t, "/api/events/e1/door", { method: "POST", cookie: host.cookie, body: { lat: 40.7128, lng: -74.006 } });
    expect(r.status).toBe(403);
  });
});

describe("the host's own view", () => {
  it("lists hosted events and whether each has a gym", async () => {
    const host = await login(t);
    mkEvent("e1", host.user.id);
    mkEvent("e2", host.user.id);
    await policy(host.cookie, "e1", { mode: "flat", flatXp: 50 });

    const r = await call(t, "/api/gyms/hosted", { cookie: host.cookie });
    expect(r.status).toBe(200);
    expect(r.json.hosted).toHaveLength(2);
    expect(r.json.hosted.find((h: any) => h.event.id === "e1").gym.status).toBe("draft");
    expect(r.json.hosted.find((h: any) => h.event.id === "e2").gym).toBeNull();
  });

  it("gives the host budget, roster and awards in one call", async () => {
    const host = await login(t, "host@x.com", "Host");
    mkEvent("e1", host.user.id);
    for (const e of ["a@x.com", "b@x.com", "c@x.com"]) present((await login(t, e, e)).user.id, "e1");
    await policy(host.cookie, "e1", { mode: "flat", flatXp: 50 });
    await call(t, "/api/events/e1/gym/arm", { method: "POST", cookie: host.cookie });

    const r = await call(t, "/api/events/e1/gym", { cookie: host.cookie });
    expect(r.json.isHost).toBe(true);
    expect(r.json.gym.budget).toBeGreaterThan(0);
    expect(r.json.roster).toHaveLength(3);
    expect(r.json.roster[0]).toHaveProperty("dwellMinutes");
    expect(r.json.roster[0]).toHaveProperty("remainingCap");
  });
});
