/**
 * Entry to the scrape network is an IN-PERSON handshake, and this file is the proof.
 *
 * The ambassador's phone plays a short animated film — a new code every 400ms — and
 * the joiner has to capture four CONSECUTIVE frames while they're still recent. Every
 * test here is an attack we expect to fail, and the interesting ones are the ones a
 * static QR code could never survive: a screenshot (one frame), a recorded video
 * (valid codes, stale steps), a frame list forwarded to another city (proximity), and
 * the same frame read four times by a greedy camera (one sighting, not four).
 *
 * The other one that matters is the concurrent double-redeem: single-use has to be a
 * property of the UPDATE, not a SELECT two requests can both pass.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { mintSecret, hashSecret, timingSafeEqualHex, checkRedeem, INVITE_RADIUS_M } from "../src/core/net/invite";
import {
  frameCode,
  frameCodes,
  framePayload,
  parseFramePayload,
  verifyFrames,
  stepAt,
  stepStartMs,
  HANDSHAKE_STEP_MS,
  HANDSHAKE_SESSION_MS,
  HANDSHAKE_FRAMES_REQUIRED,
  HANDSHAKE_MAX_LAG_STEPS,
} from "../src/core/net/handshake";
import { inBay } from "../src/core/geo";
import { haversineKm } from "../src/core/geofence";

const KEY = "test-handshake-key-not-a-real-secret";

// Union Square, SF. Offsets are in degrees latitude: 1° ≈ 111.32 km.
const SF = { lat: 37.7879, lng: -122.4075 };
const M = 1 / 111_320;
const near = (metres: number) => ({ lat: SF.lat + metres * M, lng: SF.lng });
const NYC = { lat: 40.7128, lng: -74.006 };

async function seedMember(t: TestApp, userId: string, tier: "probation" | "trusted" | "core") {
  await t.env.DB.prepare(
    "INSERT INTO network_members (user_id, tier, joined_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET tier = excluded.tier",
  )
    .bind(userId, tier, new Date().toISOString())
    .run();
}

const app = () => makeTestApp({ HANDSHAKE_KEY: KEY });

describe("core/net/handshake — the film", () => {
  it("derives a stable, unguessable code per step", async () => {
    expect(await frameCode(KEY, "sess", 100)).toBe(await frameCode(KEY, "sess", 100));
    expect(await frameCode(KEY, "sess", 100)).not.toBe(await frameCode(KEY, "sess", 101));
    expect(await frameCode(KEY, "sess", 100)).not.toBe(await frameCode(KEY, "other", 100));
    // A different deployment key produces a different film for the same session.
    expect(await frameCode(KEY, "sess", 100)).not.toBe(await frameCode("other-key", "sess", 100));
    // Crockford base32: nothing ambiguous for a camera that half-reads a frame.
    expect(await frameCode(KEY, "sess", 100)).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
  });

  it("keeps two devices in phase off the wall clock alone", () => {
    // Steps are absolute (epoch/stepMs), so the display and the verifier agree without
    // negotiating a start time — there is nothing to drift.
    const t = 1_785_000_000_000;
    expect(stepAt(t, 400)).toBe(Math.floor(t / 400));
    expect(stepStartMs(stepAt(t, 400), 400)).toBeLessThanOrEqual(t);
    expect(stepStartMs(stepAt(t, 400) + 1, 400)).toBeGreaterThan(t);
    // A garbage step size falls back rather than dividing by zero.
    expect(Number.isFinite(stepAt(t, 0))).toBe(true);
  });

  it("round-trips a frame through the QR payload", () => {
    const p = framePayload({ origin: "https://thebay.events", sessionId: "01ABC", step: 7, code: "0123456789" });
    const u = new URL(p);
    expect(u.search).toBe(""); // the code stays out of query strings and access logs
    expect(u.protocol).toBe("https:"); // a stock camera app can open one frame
    expect(parseFramePayload(p)).toEqual({ sessionId: "01ABC", frame: { step: 7, code: "0123456789" } });
    expect(parseFramePayload("https://thebay.events/j")).toBeNull();
    expect(parseFramePayload("not a url")).toBeNull();
  });

  const at = 1_785_000_000_000;
  const nowStep = stepAt(at, HANDSHAKE_STEP_MS);
  const session = { key: KEY, sessionId: "sess", startStep: nowStep - 50, endStep: nowStep + 50, nowMs: at };
  const run = async (from: number, count: number) => await frameCodes(KEY, "sess", from, count);

  it("accepts a contiguous, recent run", async () => {
    const frames = await run(nowStep - 3, 4);
    expect(await verifyFrames({ ...session, frames })).toBe("ok");
  });

  it("rejects a SCREENSHOT — one frame is not a film", async () => {
    expect(await verifyFrames({ ...session, frames: await run(nowStep, 1) })).toBe("too_few");
    expect(await verifyFrames({ ...session, frames: await run(nowStep - 1, 2) })).toBe("too_few");
  });

  it("rejects the same frame read four times by a greedy camera", async () => {
    const [one] = await run(nowStep, 1);
    expect(await verifyFrames({ ...session, frames: [one!, one!, one!, one!] })).toBe("too_few");
  });

  it("rejects a run with a hole in it", async () => {
    const frames = [...(await run(nowStep - 5, 2)), ...(await run(nowStep - 2, 2))];
    expect(await verifyFrames({ ...session, frames })).toBe("not_contiguous");
  });

  it("rejects a REPLAYED VIDEO — the codes are valid, the moment has passed", async () => {
    const frames = await run(nowStep - HANDSHAKE_MAX_LAG_STEPS - 5, 4);
    expect(await verifyFrames({ ...session, frames })).toBe("stale");
  });

  it("rejects frames from the future, so a fast clock can't pre-record", async () => {
    const frames = await run(nowStep + 30, 4);
    expect(await verifyFrames({ ...session, frames })).toBe("future");
  });

  it("forgives a little clock skew, because real devices have it", async () => {
    expect(await verifyFrames({ ...session, frames: await run(nowStep + 1, 4) })).toBe("ok");
    expect(await verifyFrames({ ...session, frames: await run(nowStep - 8, 4) })).toBe("ok");
  });

  it("rejects invented codes and codes from another session", async () => {
    const steps = [nowStep - 3, nowStep - 2, nowStep - 1, nowStep];
    expect(await verifyFrames({ ...session, frames: steps.map((step) => ({ step, code: "AAAAAAAAAA" })) })).toBe("bad_code");
    const other = await frameCodes(KEY, "different-session", nowStep - 3, 4);
    expect(await verifyFrames({ ...session, frames: other })).toBe("bad_code");
  });

  it("rejects frames outside the session's own bounds", async () => {
    const frames = await run(nowStep - 3, 4);
    expect(await verifyFrames({ ...session, startStep: nowStep - 1, frames })).toBe("out_of_session");
  });

  it("ignores malformed frames rather than throwing on them", async () => {
    const frames = [...(await run(nowStep - 3, 4)), { step: NaN, code: "x" } as any, null as any];
    expect(await verifyFrames({ ...session, frames })).toBe("ok");
  });
});

describe("core/net/invite — the surrounding policy", () => {
  it("mints high-entropy worker tokens that never repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = mintSecret();
      expect(s).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
  });

  it("hashes deterministically and compares in constant time", async () => {
    const s = mintSecret();
    const a = await hashSecret(s);
    expect(a).toBe(await hashSecret(s));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, await hashSecret(mintSecret()))).toBe(false);
    // Reachable from user input, so neither may throw.
    expect(timingSafeEqualHex(a, "abc")).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(false);
  });

  it("checks identity and liveness BEFORE geography", () => {
    const t = Date.parse("2026-07-26T12:00:00Z");
    const live = { ambassadorId: "amb", lat: SF.lat, lng: SF.lng, expiresAt: new Date(t + 30_000).toISOString() };
    const from = (id: string, p = near(5)) => ({ id, ...p });
    const check = (inv: any, j: any) =>
      checkRedeem(inv, j, t, inBay, (a: number, b: number, c: number, d: number) => haversineKm(a, b, c, d) * 1000);

    expect(check(live, from("bea"))).toBe("ok");
    // Self-vouching is refused even standing in exactly the right place. Unreachable
    // over HTTP (an ambassador is already a member), so this is where it's proven.
    expect(check(live, from("amb"))).toBe("self");
    // A revoked or spent session loses before we look at coordinates, so a stale
    // capture from across the country reports the honest reason.
    expect(check({ ...live, revokedAt: "2026-07-26T11:59:00Z" }, from("bea", NYC))).toBe("revoked");
    expect(check({ ...live, redeemedAt: "2026-07-26T11:59:00Z" }, from("bea", NYC))).toBe("taken");
    expect(check({ ...live, expiresAt: new Date(t - 1).toISOString() }, from("bea"))).toBe("expired");
    expect(check({ ...live, expiresAt: "not a date" }, from("bea"))).toBe("expired");
    expect(check(live, from("bea", NYC))).toBe("out_of_region");
    expect(check(live, from("bea", near(INVITE_RADIUS_M + 25)))).toBe("too_far");
  });

  it("keeps the handshake short enough that a leaked frame list rots fast", () => {
    expect(HANDSHAKE_SESSION_MS).toBeLessThanOrEqual(60_000);
    expect(HANDSHAKE_FRAMES_REQUIRED * HANDSHAKE_STEP_MS).toBeGreaterThanOrEqual(1000); // a real moment of looking
    expect(HANDSHAKE_FRAMES_REQUIRED * HANDSHAKE_STEP_MS).toBeLessThanOrEqual(4000); // but not a wait
    expect(INVITE_RADIUS_M).toBeLessThanOrEqual(150);
  });
});

describe("POST /api/net/invite", () => {
  let t: TestApp;
  beforeEach(() => {
    t = app();
  });

  it("401s when nobody is signed in", async () => {
    expect((await call(t, "/api/net/invite", { method: "POST", body: SF })).status).toBe(401);
  });

  it("503s rather than degrading when the deployment has no handshake key", async () => {
    const bare = makeTestApp(); // no HANDSHAKE_KEY
    const { cookie, user } = await login(bare, "amb@x.com", "Amb");
    await seedMember(bare, user.id, "core");
    expect((await call(bare, "/api/net/invite", { method: "POST", cookie, body: SF })).status).toBe(503);
  });

  it("403s a signed-in non-member — you cannot invite into a network you're not in", async () => {
    const { cookie } = await login(t, "nobody@x.com", "Nobody");
    expect((await call(t, "/api/net/invite", { method: "POST", cookie, body: SF })).status).toBe(403);
  });

  it("403s a probation member — vouching is a privilege you earn", async () => {
    const { cookie, user } = await login(t, "new@x.com", "New");
    await seedMember(t, user.id, "probation");
    expect((await call(t, "/api/net/invite", { method: "POST", cookie, body: SF })).status).toBe(403);
  });

  it("403s a quarantined member", async () => {
    const { cookie, user } = await login(t, "sus@x.com", "Sus");
    await seedMember(t, user.id, "core");
    await t.env.DB.prepare("UPDATE network_members SET quarantined_at = ? WHERE user_id = ?")
      .bind(new Date().toISOString(), user.id)
      .run();
    expect((await call(t, "/api/net/invite", { method: "POST", cookie, body: SF })).status).toBe(403);
  });

  it("403s an ambassador who isn't physically in the Bay", async () => {
    const { cookie, user } = await login(t, "amb@x.com", "Amb");
    await seedMember(t, user.id, "core");
    expect((await call(t, "/api/net/invite", { method: "POST", cookie, body: NYC })).status).toBe(403);
  });

  it("hands a trusted ambassador the whole film, in phase with the clock", async () => {
    const { cookie, user } = await login(t, "amb@x.com", "Amb");
    await seedMember(t, user.id, "trusted");
    const r = await call(t, "/api/net/invite", { method: "POST", cookie, body: SF });
    expect(r.status).toBe(200);
    expect(r.json.sessionId).toBeTruthy();
    expect(r.json.stepMs).toBe(HANDSHAKE_STEP_MS);
    expect(r.json.framesRequired).toBe(HANDSHAKE_FRAMES_REQUIRED);
    // Enough frames to cover the session, each with the wall-clock moment it's due.
    expect(r.json.frames.length).toBe(Math.ceil(HANDSHAKE_SESSION_MS / HANDSHAKE_STEP_MS));
    expect(r.json.frames[0].step).toBe(r.json.startStep);
    expect(r.json.frames[1].at - r.json.frames[0].at).toBe(HANDSHAKE_STEP_MS);
    expect(r.json.frames[0].payload).toContain(r.json.sessionId);
    expect(Date.parse(r.json.expiresAt)).toBeGreaterThan(Date.now());

    // The codes are real HMACs of (session, step) — reproducible, not random noise.
    expect(r.json.frames[5].code).toBe(await frameCode(KEY, r.json.sessionId, r.json.frames[5].step));

    // And nothing secret was written down.
    const row = await t.env.DB.prepare("SELECT * FROM network_invites WHERE id = ?").bind(r.json.sessionId).first();
    expect(Object.keys(row)).not.toContain("secret_hash");
    expect(JSON.stringify(row)).not.toContain(r.json.frames[0].code);
  });

  it("starting a new session kills the one that was on screen", async () => {
    const { cookie, user } = await login(t, "amb@x.com", "Amb");
    await seedMember(t, user.id, "core");
    const first = (await call(t, "/api/net/invite", { method: "POST", cookie, body: SF })).json;
    const second = (await call(t, "/api/net/invite", { method: "POST", cookie, body: SF })).json;
    expect(second.sessionId).not.toBe(first.sessionId);

    const { cookie: joiner } = await login(t, "join@x.com", "Joiner");
    const stale = await call(t, "/api/net/join", {
      method: "POST",
      cookie: joiner,
      body: { sessionId: first.sessionId, frames: first.frames.slice(0, 4), ...near(5) },
    });
    expect(stale.status).toBe(403);
    expect(stale.json.reason).toBe("revoked");
  });
});

describe("POST /api/net/join", () => {
  let t: TestApp;
  let amb: any;
  let ambCookie: string;
  let session: any;

  /** The frames a camera would have caught right now, from the live session. */
  const captured = (count = HANDSHAKE_FRAMES_REQUIRED) => {
    const now = stepAt(Date.now(), HANDSHAKE_STEP_MS);
    const all: any[] = session.frames;
    const i = Math.max(0, all.findIndex((f) => f.step === now));
    return all.slice(Math.max(0, i - count + 1), Math.max(count, i + 1)).map((f) => ({ step: f.step, code: f.code }));
  };

  beforeEach(async () => {
    t = app();
    const a = await login(t, "amb@x.com", "Ambassador");
    amb = a.user;
    ambCookie = a.cookie;
    await seedMember(t, amb.id, "core");
    session = (await call(t, "/api/net/invite", { method: "POST", cookie: ambCookie, body: SF })).json;
  });

  const join = (cookie: string, over: Record<string, unknown> = {}) =>
    call(t, "/api/net/join", {
      method: "POST",
      cookie,
      body: { sessionId: session.sessionId, frames: captured(), ...near(10), ...over },
    });

  it("401s when nobody is signed in — you join as yourself, not anonymously", async () => {
    const r = await call(t, "/api/net/join", {
      method: "POST",
      body: { sessionId: session.sessionId, frames: captured(), ...SF },
    });
    expect(r.status).toBe(401);
  });

  it("admits someone who watched the film standing next to the ambassador", async () => {
    const { cookie, user } = await login(t, "b@x.com", "Bea");
    const r = await join(cookie);
    expect(r.status).toBe(200);
    expect(r.json.tier).toBe("probation");
    expect(r.json.vouchedBy.handle).toBe(amb.handle);

    const m = await t.env.DB.prepare("SELECT * FROM network_members WHERE user_id = ?").bind(user.id).first();
    expect(m.tier).toBe("probation");
    expect(m.vouched_by).toBe(amb.id);
    expect(m.invite_id).toBe(session.sessionId);

    // A real, accepted connection — not a pending request. They just met.
    const low = user.id < amb.id ? user.id : amb.id;
    const high = user.id < amb.id ? amb.id : user.id;
    const f = await t.env.DB.prepare("SELECT status FROM friendships WHERE user_low=? AND user_high=?").bind(low, high).first();
    expect(f.status).toBe("accepted");

    // Both sides are paid for the connection, idempotently.
    const pts = await t.env.DB.prepare("SELECT user_id FROM points_ledger WHERE kind = 'connection'").all();
    expect(pts.results.map((p: any) => p.user_id).sort()).toEqual([amb.id, user.id].sort());
  });

  it("rejects a single screenshotted frame", async () => {
    const { cookie } = await login(t, "b@x.com", "Bea");
    const r = await join(cookie, { frames: captured(1) });
    expect(r.status).toBe(400); // fewer than 2 doesn't even parse — the shape says "a run"
  });

  it("rejects too few frames to prove someone was looking", async () => {
    const { cookie } = await login(t, "b@x.com", "Bea");
    const r = await join(cookie, { frames: captured(2) });
    expect(r.status).toBe(403);
    expect(r.json.reason).toBe("too_few");
  });

  it("rejects invented codes, and the session survives the guess", async () => {
    const { cookie } = await login(t, "b@x.com", "Bea");
    const r = await join(cookie, { frames: captured().map((f: any) => ({ ...f, code: "AAAAAAAAAA" })) });
    expect(r.status).toBe(403);
    expect(r.json.reason).toBe("bad_code");
    const row = await t.env.DB.prepare("SELECT redeemed_at FROM network_invites WHERE id = ?").bind(session.sessionId).first();
    expect(row.redeemed_at).toBeNull();
  });

  it("rejects a recording of the film played back later", async () => {
    const { cookie } = await login(t, "b@x.com", "Bea");
    // Real codes from the real session — just from the beginning of a session that has
    // since moved on. This is exactly what a forwarded screen recording looks like.
    const old = session.frames.slice(0, 4).map((f: any) => ({ step: f.step - 200, code: f.code }));
    const r = await join(cookie, { frames: old });
    expect(r.status).toBe(403);
    expect(["stale", "out_of_session", "bad_code"]).toContain(r.json.reason);
  });

  it("rejects an unknown session id", async () => {
    const { cookie } = await login(t, "b@x.com", "Bea");
    const r = await join(cookie, { sessionId: "01NOPE" });
    expect(r.status).toBe(403);
    expect(r.json.reason).toBe("invalid");
  });

  it("rejects an expired session", async () => {
    const { cookie } = await login(t, "b@x.com", "Bea");
    await t.env.DB.prepare("UPDATE network_invites SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), session.sessionId)
      .run();
    const r = await join(cookie);
    expect(r.status).toBe(403);
    expect(r.json.reason).toBe("expired");
  });

  it("rejects a joiner too far away to be shaking hands, and forgives GPS drift", async () => {
    const { cookie } = await login(t, "b@x.com", "Bea");
    const far = await join(cookie, near(INVITE_RADIUS_M * 4));
    expect(far.status).toBe(403);
    expect(far.json.reason).toBe("too_far");
    expect((await join(cookie, near(INVITE_RADIUS_M - 10))).status).toBe(200);
  });

  it("rejects a joiner outside the Bay even with a perfect capture", async () => {
    const { cookie } = await login(t, "b@x.com", "Bea");
    const r = await join(cookie, NYC);
    expect(r.status).toBe(403);
    expect(r.json.reason).toBe("out_of_region");
  });

  it("refuses an ambassador filming their own screen", async () => {
    const r = await join(ambCookie);
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("already_member");
  });

  it("is single-use — a second person filming the same session is refused", async () => {
    const { cookie: b } = await login(t, "b@x.com", "Bea");
    const { cookie: c } = await login(t, "c@x.com", "Cy");
    expect((await join(b)).status).toBe(200);
    const second = await join(c);
    expect(second.status).toBe(409);
    const n = await t.env.DB.prepare("SELECT COUNT(*) AS n FROM network_members WHERE invite_id = ?").bind(session.sessionId).first();
    expect(n.n).toBe(1);
  });

  it("survives a concurrent double-redeem: exactly one winner, ever", async () => {
    const { cookie: b } = await login(t, "b@x.com", "Bea");
    const { cookie: c } = await login(t, "c@x.com", "Cy");
    const results = await Promise.all([join(b), join(c)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const n = await t.env.DB.prepare("SELECT COUNT(*) AS n FROM network_members WHERE invite_id = ?").bind(session.sessionId).first();
    expect(n.n).toBe(1);
  });

  it("refuses a second membership for someone already in the network", async () => {
    const { cookie } = await login(t, "b@x.com", "Bea");
    expect((await join(cookie)).status).toBe(200);
    session = (await call(t, "/api/net/invite", { method: "POST", cookie: ambCookie, body: SF })).json;
    const r = await join(cookie);
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("already_member");
  });
});

describe("worker clients", () => {
  let t: TestApp;
  let cookie: string;
  let user: any;

  beforeEach(async () => {
    t = app();
    ({ cookie, user } = await login(t, "w@x.com", "Worker"));
    await seedMember(t, user.id, "trusted");
  });

  it("reports membership on /api/net/me", async () => {
    const r = await call(t, "/api/net/me", { cookie });
    expect(r.status).toBe(200);
    expect(r.json.member.tier).toBe("trusted");
    expect(r.json.canVouch).toBe(true);
    expect(r.json.clients).toEqual([]);
  });

  it("tells a non-member they aren't one, without erroring", async () => {
    const other = await login(t, "out@x.com", "Out");
    const r = await call(t, "/api/net/me", { cookie: other.cookie });
    expect(r.status).toBe(200);
    expect(r.json.member).toBeNull();
    expect(r.json.canVouch).toBe(false);
  });

  it("hands the client token over exactly once, and stores only its hash", async () => {
    const r = await call(t, "/api/net/clients", {
      method: "POST",
      cookie,
      body: { kind: "cli", label: "my mac", capabilities: ["fetch", "browser"] },
    });
    expect(r.status).toBe(200);
    expect(r.json.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const row = await t.env.DB.prepare("SELECT token_hash, capabilities_json FROM worker_clients WHERE id = ?").bind(r.json.clientId).first();
    expect(row.token_hash).toBe(await hashSecret(r.json.token));
    expect(JSON.parse(row.capabilities_json)).toEqual(["fetch", "browser"]);

    // Listing a client never re-reveals the token.
    const me = await call(t, "/api/net/me", { cookie });
    expect(JSON.stringify(me.json)).not.toContain(r.json.token);
  });

  it("refuses to register a client for a non-member", async () => {
    const other = await login(t, "out@x.com", "Out");
    const r = await call(t, "/api/net/clients", { method: "POST", cookie: other.cookie, body: { kind: "cli" } });
    expect(r.status).toBe(403);
  });

  it("rejects a capability the network doesn't define, and a bogus kind", async () => {
    expect((await call(t, "/api/net/clients", { method: "POST", cookie, body: { kind: "cli", capabilities: ["root"] } })).status).toBe(400);
    expect((await call(t, "/api/net/clients", { method: "POST", cookie, body: { kind: "toaster" } })).status).toBe(400);
  });

  it("never lets a client claim `residential` — that is derived, not asserted", async () => {
    const r = await call(t, "/api/net/clients", {
      method: "POST",
      cookie,
      body: { kind: "cli", capabilities: ["fetch", "residential"] },
    });
    expect(r.status).toBe(400);
  });

  it("revokes a client, and only its owner may", async () => {
    const mine = (await call(t, "/api/net/clients", { method: "POST", cookie, body: { kind: "cli" } })).json;
    const other = await login(t, "out@x.com", "Out");
    await seedMember(t, other.user.id, "trusted");
    expect((await call(t, `/api/net/clients/${mine.clientId}`, { method: "DELETE", cookie: other.cookie })).status).toBe(404);

    expect((await call(t, `/api/net/clients/${mine.clientId}`, { method: "DELETE", cookie })).status).toBe(200);
    const row = await t.env.DB.prepare("SELECT revoked_at FROM worker_clients WHERE id = ?").bind(mine.clientId).first();
    expect(row.revoked_at).not.toBeNull();
  });
});
