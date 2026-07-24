import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";

let t: TestApp;
beforeEach(() => { t = makeTestApp(); });

// convenience: host an event as a given cookie, return its id
async function host(cookie: string, title = "Test Event", startUtc = "2026-09-01T18:00:00Z") {
  const r = await call(t, "/api/host", { method: "POST", cookie, body: { title, startUtc } });
  expect(r.status).toBe(200);
  return r.json.id as string;
}
// enable social so the user is findable / graph-visible
async function enableSocial(cookie: string) {
  await call(t, "/api/me", { method: "PATCH", cookie, body: { socialEnabled: true } });
}

describe("auth guards", () => {
  it("anonymous /api/me returns no user; a guarded route 401s without a session", async () => {
    expect((await call(t, "/api/me")).json).toEqual({ user: null });
    expect((await call(t, "/api/goals")).status).toBe(401);
  });

  it("dev-login mints a session that authenticates subsequent requests", async () => {
    const { cookie, user } = await login(t, "ann@x.com", "Ann");
    expect(user.handle).toBeTruthy();
    const me = await call(t, "/api/me", { cookie });
    expect(me.json.user.id).toBe(user.id);
  });
});

describe("review-gate (end-to-end over HTTP)", () => {
  it("blocks the next RSVP until the attended event is reviewed", async () => {
    const hostU = await login(t, "host@x.com", "Host");
    const goer = await login(t, "goer@x.com", "Goer");
    const e1 = await host(hostU.cookie, "Night One");
    const e2 = await host(hostU.cookie, "Night Two");

    // host issues a check-in token; attendee checks in to E1 → opens a review obligation
    const tok = await call(t, `/api/events/${e1}/checkin-token`, { method: "POST", cookie: hostU.cookie });
    expect(tok.status).toBe(200);
    const checkin = await call(t, `/api/events/${e1}/checkin`, { method: "POST", cookie: goer.cookie, body: { token: tok.json.token } });
    expect(checkin.json.result).toBe("ok");

    // now RSVP 'going' to E2 is gated
    const blocked = await call(t, `/api/events/${e2}/rsvp`, { method: "POST", cookie: goer.cookie, body: { status: "going" } });
    expect(blocked.status).toBe(403);
    expect(blocked.json.error).toBe("review_required");
    expect(blocked.json.pending).toContain(e1);

    // clearing an RSVP ('none') is exempt from the gate
    expect((await call(t, `/api/events/${e2}/rsvp`, { method: "POST", cookie: goer.cookie, body: { status: "none" } })).status).toBe(200);

    // satisfy the gate by reviewing E1, then RSVP succeeds
    expect((await call(t, `/api/events/${e1}/review`, { method: "POST", cookie: goer.cookie, body: { rating: 5, body: "great" } })).status).toBe(200);
    const ok = await call(t, `/api/events/${e2}/rsvp`, { method: "POST", cookie: goer.cookie, body: { status: "going" } });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("going");
  });
});

describe("QR check-in ownership + roster", () => {
  it("only the host can issue tokens or read the roster", async () => {
    const hostU = await login(t, "host@x.com", "Host");
    const rando = await login(t, "rando@x.com", "Rando");
    const e1 = await host(hostU.cookie);

    // non-host cannot issue a token or read check-ins
    expect((await call(t, `/api/events/${e1}/checkin-token`, { method: "POST", cookie: rando.cookie })).status).toBe(403);
    expect((await call(t, `/api/events/${e1}/checkins`, { cookie: rando.cookie })).status).toBe(403);

    // host issues a token; rando checks in; host sees the roster
    const tok = await call(t, `/api/events/${e1}/checkin-token`, { method: "POST", cookie: hostU.cookie });
    await call(t, `/api/events/${e1}/checkin`, { method: "POST", cookie: rando.cookie, body: { token: tok.json.token } });
    const roster = await call(t, `/api/events/${e1}/checkins`, { cookie: hostU.cookie });
    expect(roster.json.count).toBe(1);
    expect(roster.json.checkins[0].displayName).toBe("Rando");
  });

  it("rejects invalid and expired tokens distinctly", async () => {
    const hostU = await login(t, "host@x.com", "Host");
    const goer = await login(t, "goer@x.com", "Goer");
    const e1 = await host(hostU.cookie);
    const bad = await call(t, `/api/events/${e1}/checkin`, { method: "POST", cookie: goer.cookie, body: { token: "nope" } });
    expect(bad.status).toBe(400);
    expect(bad.json.result).toBe("invalid");
  });
});

describe("achievements & points readout", () => {
  it("reflects check-in + review in points and trophies", async () => {
    const hostU = await login(t, "host@x.com", "Host");
    const goer = await login(t, "goer@x.com", "Goer");
    const e1 = await host(hostU.cookie);
    const tok = await call(t, `/api/events/${e1}/checkin-token`, { method: "POST", cookie: hostU.cookie });
    await call(t, `/api/events/${e1}/checkin`, { method: "POST", cookie: goer.cookie, body: { token: tok.json.token } });
    await call(t, `/api/events/${e1}/review`, { method: "POST", cookie: goer.cookie, body: { rating: 4 } });

    const ach = await call(t, "/api/me/achievements", { cookie: goer.cookie });
    expect(ach.json.achievements.map((a: any) => a.kind)).toContain("first_review");
    const byKind = Object.fromEntries(ach.json.points.map((p: any) => [p.kind, p.points]));
    expect(byKind.checkin).toBe(20);
    expect(byKind.review).toBe(10);
    expect(ach.json.streaks.find((s: any) => s.kind === "attend").count).toBe(1);
  });
});

describe("integrations import (ICS)", () => {
  it("imports events from an .ics and lists them", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:luma-1", "SUMMARY:Imported Party", "DTSTART:20260901T010000Z", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const imp = await call(t, "/api/integrations/luma/import", { method: "POST", cookie, body: { ics } });
    expect(imp.status).toBe(200);
    expect(imp.json.imported).toBe(1);
    const items = await call(t, "/api/integrations/luma/items", { cookie });
    expect(items.json.items.length).toBe(1);
  });
});

describe("AI routes", () => {
  it("returns a deterministic research brief for an event", async () => {
    const hostU = await login(t, "host@x.com", "Host");
    const e1 = await host(hostU.cookie);
    const me = await login(t, "me@x.com", "Me");
    const r = await call(t, `/api/events/${e1}/research`, { cookie: me.cookie });
    expect(r.status).toBe(200);
    expect(typeof r.json.brief.fitScore).toBe("number");
    expect(Array.isArray(r.json.brief.talkingPoints)).toBe(true);
  });

  it("agent settings toggle round-trips", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    expect((await call(t, "/api/me/agent", { cookie })).json.enabled).toBe(false);
    await call(t, "/api/me/agent", { method: "PUT", cookie, body: { enabled: true, mode: "auto" } });
    const after = await call(t, "/api/me/agent", { cookie });
    expect(after.json.enabled).toBe(true);
    expect(after.json.mode).toBe("auto");
  });
});

describe("web push subscribe", () => {
  it("key endpoint reports unconfigured; subscribe validates the body", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    expect((await call(t, "/api/push/key")).json).toEqual({ key: null, enabled: false });
    expect((await call(t, "/api/me/push/subscribe", { method: "POST", cookie, body: { endpoint: "https://p/1" } })).status).toBe(400); // missing keys
    const okSub = await call(t, "/api/me/push/subscribe", { method: "POST", cookie, body: { endpoint: "https://p/1", keys: { p256dh: "k", auth: "s" } } });
    expect(okSub.status).toBe(200);
  });
});

describe("network graph route", () => {
  it("returns the caller's ego network", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    await enableSocial(ann.cookie);
    const g = await call(t, "/api/network/graph", { cookie: ann.cookie });
    expect(g.status).toBe(200);
    expect(g.json.nodes.some((n: any) => n.me)).toBe(true);
  });
});

describe("profile privacy (GET /api/u/:handle)", () => {
  it("hides a non-social user from strangers, shows them to themselves, and never leaks email", async () => {
    // Ann keeps social OFF (default); Bob is a stranger
    const ann = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");
    const annHandle = ann.user.handle;

    // stranger sees 404
    expect((await call(t, `/api/u/${annHandle}`, { cookie: bob.cookie })).status).toBe(404);
    // anonymous sees 404
    expect((await call(t, `/api/u/${annHandle}`)).status).toBe(404);
    // Ann sees her own profile even with social off
    const self = await call(t, `/api/u/${annHandle}`, { cookie: ann.cookie });
    expect(self.status).toBe(200);
    expect(self.json.isMe).toBe(true);
    expect(self.json.profile.email).toBeUndefined(); // email never in the payload

    // once Ann enables social, the stranger can see her (still no email)
    await call(t, "/api/me", { method: "PATCH", cookie: ann.cookie, body: { socialEnabled: true } });
    const seen = await call(t, `/api/u/${annHandle}`, { cookie: bob.cookie });
    expect(seen.status).toBe(200);
    expect(seen.json.profile.email).toBeUndefined();
    expect(seen.json.isMe).toBe(false);
  });
});

// Helpers for graph scenarios over HTTP.
async function befriendHttp(A: { cookie: string; user: any }, B: { cookie: string; user: any }) {
  await call(t, `/api/friends/${B.user.id}/request`, { method: "POST", cookie: A.cookie });
  await call(t, `/api/friends/${A.user.id}/respond`, { method: "POST", cookie: B.cookie, body: { accept: true } });
}

describe("security hardening (audit regressions)", () => {
  it("HIGH: reviewing an event requires attendance (no fake reviews / points farming)", async () => {
    const hostU = await login(t, "host@x.com", "Host");
    const drive = await login(t, "drive@x.com", "DriveBy");
    const e1 = await host(hostU.cookie);
    // never attended → blocked, and no points awarded
    const blocked = await call(t, `/api/events/${e1}/review`, { method: "POST", cookie: drive.cookie, body: { rating: 1 } });
    expect(blocked.status).toBe(403);
    expect((await call(t, "/api/me/achievements", { cookie: drive.cookie })).json.points).toEqual([]);
    // after a real check-in → allowed
    const tok = await call(t, `/api/events/${e1}/checkin-token`, { method: "POST", cookie: hostU.cookie });
    await call(t, `/api/events/${e1}/checkin`, { method: "POST", cookie: drive.cookie, body: { token: tok.json.token } });
    expect((await call(t, `/api/events/${e1}/review`, { method: "POST", cookie: drive.cookie, body: { rating: 5 } })).status).toBe(200);
  });

  it("MED: a bogus/deleted event id yields 404, not a 500", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    expect((await call(t, "/api/events/does-not-exist/rsvp", { method: "POST", cookie, body: { status: "going" } })).status).toBe(404);
  });

  it("MED: only a media owner can tag people in it", async () => {
    const owner = await login(t, "owner@x.com", "Owner");
    const other = await login(t, "other@x.com", "Other");
    const victim = await login(t, "victim@x.com", "Victim");
    const up = await call(t, "/api/media?kind=photo", { method: "POST", cookie: owner.cookie, raw: "PNGBYTES", headers: { "content-type": "image/png" } });
    expect(up.status).toBe(200);
    const mid = up.json.id;
    // a stranger cannot tag the victim in the owner's media
    expect((await call(t, `/api/media/${mid}/tag`, { method: "POST", cookie: other.cookie, body: { userId: victim.user.id } })).status).toBe(403);
    // the owner can
    expect((await call(t, `/api/media/${mid}/tag`, { method: "POST", cookie: owner.cookie, body: { userId: victim.user.id } })).status).toBe(200);
  });

  it("LOW: you can't forward an intro you're not a mutual connector for", async () => {
    const asker = await login(t, "asker@x.com", "Asker");
    const target = await login(t, "target@x.com", "Target");
    const rando = await login(t, "rando@x.com", "Rando");
    for (const u of [asker, target, rando]) await enableSocial(u.cookie);
    const reqRes = await call(t, "/api/intros", { method: "POST", cookie: asker.cookie, body: { targetDesc: "Target", targetUserId: target.user.id } });
    const reqId = reqRes.json.id;
    // rando is friends with nobody here → not eligible → 403
    expect((await call(t, `/api/intros/${reqId}/forward`, { method: "POST", cookie: rando.cookie })).status).toBe(403);
  });

  it("full warm-intro loop: request → mutual forwards → target accepts → connected", async () => {
    const asker = await login(t, "asker@x.com", "Asker");
    const conn = await login(t, "conn@x.com", "Conn");
    const target = await login(t, "target@x.com", "Target");
    for (const u of [asker, conn, target]) await enableSocial(u.cookie);
    await befriendHttp(asker, conn);   // asker ↔ connector
    await befriendHttp(conn, target);  // connector ↔ target

    const reqId = (await call(t, "/api/intros", { method: "POST", cookie: asker.cookie, body: { targetDesc: "Target", targetUserId: target.user.id } })).json.id;
    // connector sees it in their inbox and forwards
    const connInbox = await call(t, "/api/intros", { cookie: conn.cookie });
    expect(connInbox.json.inbox.map((it: any) => it.request.id)).toContain(reqId);
    const fwd = await call(t, `/api/intros/${reqId}/forward`, { method: "POST", cookie: conn.cookie });
    expect(fwd.status).toBe(200);
    // target sees the incoming forward and accepts
    const tIntros = await call(t, "/api/intros", { cookie: target.cookie });
    expect(tIntros.json.incoming.length).toBe(1);
    expect(tIntros.json.incoming[0].forwardId).toBe(fwd.json.forwardId);
    const accepted = await call(t, `/api/intros/forward/${fwd.json.forwardId}/accept`, { method: "POST", cookie: target.cookie });
    expect(accepted.status).toBe(200);
    expect(accepted.json.result).toBe("connected");
    // asker and target are now friends
    const askerFriends = await call(t, "/api/friends", { cookie: asker.cookie });
    expect(askerFriends.json.friends.some((f: any) => f.id === target.user.id)).toBe(true);
  });
});

describe("email + password login (self-contained)", () => {
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") || "").split(";")[0];

  it("registers, starts a session, and logs back in", async () => {
    // register
    const reg = await call(t, "/auth/password/register", { method: "POST", body: { email: "Sam@x.com", password: "s3cretpass", name: "Sam" } });
    expect(reg.status).toBe(200);
    const regCookie = cookieOf(reg.res);
    expect((await call(t, "/api/me", { cookie: regCookie })).json.user.displayName).toBe("Sam");

    // wrong password → 401 (and same message as unknown email = no enumeration)
    expect((await call(t, "/auth/password/login", { method: "POST", body: { email: "sam@x.com", password: "nope" } })).status).toBe(401);
    expect((await call(t, "/auth/password/login", { method: "POST", body: { email: "ghost@x.com", password: "whatever" } })).status).toBe(401);

    // correct login (case-insensitive email) → 200 + working session
    const login = await call(t, "/auth/password/login", { method: "POST", body: { email: "SAM@x.com", password: "s3cretpass" } });
    expect(login.status).toBe(200);
    expect((await call(t, "/api/me", { cookie: cookieOf(login.res) })).json.user).toBeTruthy();
  });

  it("rejects weak passwords and duplicate registration", async () => {
    expect((await call(t, "/auth/password/register", { method: "POST", body: { email: "a@x.com", password: "short" } })).status).toBe(400);
    expect((await call(t, "/auth/password/register", { method: "POST", body: { email: "bad-email", password: "longenough" } })).status).toBe(400);
    expect((await call(t, "/auth/password/register", { method: "POST", body: { email: "dup@x.com", password: "longenough1" } })).status).toBe(200);
    expect((await call(t, "/auth/password/register", { method: "POST", body: { email: "dup@x.com", password: "longenough2" } })).status).toBe(409);
  });
});

describe("AI key via the agent settings route", () => {
  it("stores a bring-your-own OpenRouter key and never echoes it back", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    const put = await call(t, "/api/me/agent", { method: "PUT", cookie, body: { openrouterKey: "sk-live-xyz", openrouterModel: "openai/gpt-4o-mini" } });
    expect(put.status).toBe(200);
    expect(put.json.hasAiKey).toBe(true);
    expect(JSON.stringify(put.json)).not.toContain("sk-live-xyz");
    const get = await call(t, "/api/me/agent", { cookie });
    expect(get.json.hasAiKey).toBe(true);
    expect(JSON.stringify(get.json)).not.toContain("sk-live-xyz");
  });
});

describe("reviews of people (host/speaker/participant)", () => {
  it("validates input, blocks self-review, and review-bombing of strangers", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const host = await login(t, "host@x.com", "Host");
    await enableSocial(host.cookie);
    // invalid type / non-integer rating / out-of-range rejected
    expect((await call(t, `/api/users/${host.user.id}/review`, { method: "POST", cookie: ann.cookie, body: { subjectType: "nope", rating: 5 } })).status).toBe(400);
    expect((await call(t, `/api/users/${host.user.id}/review`, { method: "POST", cookie: ann.cookie, body: { subjectType: "host", rating: 9 } })).status).toBe(400);
    expect((await call(t, `/api/users/${host.user.id}/review`, { method: "POST", cookie: ann.cookie, body: { subjectType: "host", rating: 3.5 } })).status).toBe(400); // non-integer
    // can't review yourself
    expect((await call(t, `/api/users/${host.user.id}/review`, { method: "POST", cookie: host.cookie, body: { subjectType: "host", rating: 5 } })).status).toBe(400);
    // Ann shares no event with Host → review-bomb blocked
    expect((await call(t, `/api/users/${host.user.id}/review`, { method: "POST", cookie: ann.cookie, body: { subjectType: "host", rating: 1 } })).status).toBe(403);
  });

  it("allows a review once you've attended an event with that person", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const host = await login(t, "host@x.com", "Host");
    await enableSocial(host.cookie);
    const e1 = (await call(t, "/api/host", { method: "POST", cookie: host.cookie, body: { title: "Host's Event", startUtc: "2026-09-01T18:00:00Z" } })).json.id;
    // Ann checks in to Host's event → now she may review the host
    const tok = await call(t, `/api/events/${e1}/checkin-token`, { method: "POST", cookie: host.cookie });
    await call(t, `/api/events/${e1}/checkin`, { method: "POST", cookie: ann.cookie, body: { token: tok.json.token } });
    expect((await call(t, `/api/users/${host.user.id}/review`, { method: "POST", cookie: ann.cookie, body: { subjectType: "host", rating: 5, body: "ran a great room" } })).status).toBe(200);
    const prof = await call(t, `/api/u/${host.user.handle}/reviews`, { cookie: ann.cookie });
    expect(prof.json.reviews[0]).toMatchObject({ subjectType: "host", rating: 5, author: "Ann" });
    expect(prof.json.rating.byRole.host).toMatchObject({ count: 1, avg: 5 });
  });
});

describe("password register takeover guard", () => {
  it("refuses to attach a password to a pre-existing (non-password) account", async () => {
    await login(t, "victim@x.com", "Victim"); // creates a dev-provider account for this email
    const reg = await call(t, "/auth/password/register", { method: "POST", body: { email: "Victim@x.com", password: "attacker-pw" } });
    expect(reg.status).toBe(409); // can't hijack by email (case-insensitive)
    expect((await call(t, "/auth/password/login", { method: "POST", body: { email: "victim@x.com", password: "attacker-pw" } })).status).toBe(401);
  });
});

describe("agent settings partial updates preserve mode", () => {
  it("keeps autopilot when a later save (e.g. AI key) omits mode", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    await call(t, "/api/me/agent", { method: "PUT", cookie, body: { enabled: true, mode: "auto" } });
    const after = await call(t, "/api/me/agent", { method: "PUT", cookie, body: { openrouterKey: "sk-x" } });
    expect(after.json.mode).toBe("auto"); // NOT reset to approve
    expect(after.json.enabled).toBe(true);
  });
});

describe("media geo/time fence wiring (route level)", () => {
  function insertGeoEvent(id: string, startUtc: string, lat: number, lng: number) {
    t.raw.prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at, latitude, longitude)
       VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'sf-bay', 'https://x', ?, '2026-01-01', '2026-01-01', ?, ?)`,
    ).run(id, "fp-" + id, "Geo Event " + id, startUtc, "ch-" + id, lat, lng);
  }

  it("suggests the event you RSVP'd when the photo's place+time fall inside the fence", async () => {
    const { cookie } = await login(t, "ann@x.com", "Ann");
    insertGeoEvent("ge1", "2026-06-01T18:00:00Z", 37.7955, -122.3937);
    await call(t, "/api/events/ge1/rsvp", { method: "POST", cookie, body: { status: "going" } });

    // same spot, 1h after start → inside the fence
    const inFence = await call(t, "/api/media?kind=photo&lat=37.7955&lng=-122.3937&takenAt=2026-06-01T19:00:00Z", {
      method: "POST", cookie, raw: "PNGBYTES", headers: { "content-type": "image/png" },
    });
    expect(inFence.status).toBe(200);
    expect(inFence.json.suggestion).toBe("ge1");

    // far away → no suggestion
    const outOfFence = await call(t, "/api/media?kind=photo&lat=34.0522&lng=-118.2437&takenAt=2026-06-01T19:00:00Z", {
      method: "POST", cookie, raw: "PNGBYTES", headers: { "content-type": "image/png" },
    });
    expect(outOfFence.json.suggestion).toBeNull();
  });
});

describe("cookieless calendar feed (/api/cal/:token)", () => {
  it("issues a subscribable URL that serves your agenda without a cookie; bogus token 404s", async () => {
    const hostU = await login(t, "host@x.com", "Host");
    const goer = await login(t, "goer@x.com", "Goer");
    const e1 = await host(hostU.cookie, "Subscribed Event", "2099-09-01T18:00:00Z");
    await call(t, `/api/events/${e1}/rsvp`, { method: "POST", cookie: goer.cookie, body: { status: "going" } });

    const sub = await call(t, "/api/me/calendar/subscribe", { method: "POST", cookie: goer.cookie });
    expect(sub.json.url).toContain("/api/cal/");
    const token = sub.json.url.split("/api/cal/")[1].replace(/\.ics$/, "");

    // fetched with NO cookie — the token alone authorizes the feed
    const feed = await call(t, `/api/cal/${token}.ics`);
    expect(feed.status).toBe(200);
    expect(String(feed.json)).toContain("BEGIN:VCALENDAR");
    expect(String(feed.json)).toContain("Subscribed Event");

    expect((await call(t, "/api/cal/not-a-real-token.ics")).status).toBe(404);
  });
});
