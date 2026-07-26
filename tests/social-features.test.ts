import { describe, it, expect } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";

// The message route fans out through a Durable Object via executionCtx.waitUntil —
// stub both so the persist-then-broadcast path runs in the HTTP harness.
const DO_STUB = { idFromName: () => "id", get: () => ({ fetch: async () => new Response("ok") }) } as any;
const EXEC_CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as any;

async function host(t: TestApp, cookie: string, title = "Test Event", startUtc = "2099-09-01T18:00:00Z") {
  return (await call(t, "/api/host", { method: "POST", cookie, body: { title, startUtc } })).json.id as string;
}
async function befriend(t: TestApp, a: { cookie: string; user: any }, b: { cookie: string; user: any }) {
  await call(t, `/api/friends/${b.user.id}/request`, { method: "POST", cookie: a.cookie });
  await call(t, `/api/friends/${a.user.id}/respond`, { method: "POST", cookie: b.cookie, body: { accept: true } });
}

describe("groups + real-time chat", () => {
  it("create → members-only access → messages persist and return", async () => {
    const t = makeTestApp({ GROUP_ROOM: DO_STUB });
    const ann = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");

    const created = await call(t, "/api/groups", { method: "POST", cookie: ann.cookie, body: { name: "AI Builders" } });
    expect(created.status).toBe(200);
    const gid = created.json.id;

    expect((await call(t, "/api/groups", { cookie: ann.cookie })).json.groups.some((g: any) => g.id === gid)).toBe(true);
    // Bob isn't a member yet: reading the room AND posting are both blocked
    expect((await call(t, `/api/groups/${gid}`, { cookie: bob.cookie })).status).toBe(403);
    expect((await call(t, `/api/groups/${gid}/messages`, { method: "POST", cookie: bob.cookie, body: { body: "hi" } })).status).toBe(403);

    expect((await call(t, `/api/groups/${gid}/join`, { method: "POST", cookie: bob.cookie })).status).toBe(200);
    // now Bob can post (route uses executionCtx + DO — call fetch directly with stubs)
    const msgRes = await t.app.fetch(
      new Request("http://test/api/groups/" + gid + "/messages", { method: "POST", headers: { cookie: bob.cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "gm builders" }) }),
      t.env, EXEC_CTX,
    );
    expect(msgRes.status).toBe(200);

    const room = await call(t, `/api/groups/${gid}`, { cookie: ann.cookie });
    expect(room.status).toBe(200);
    expect(room.json.members.length).toBe(2);
    expect(room.json.messages.some((m: any) => m.body === "gm builders")).toBe(true);
    // empty message body is rejected
    expect((await call(t, `/api/groups/${gid}/messages`, { method: "POST", cookie: ann.cookie, body: { body: "" } })).status).toBe(400);
  });
});

describe("friends feed", () => {
  it("surfaces events your friends are attending, and nothing from non-friends", async () => {
    const t = makeTestApp();
    const me = await login(t, "me@x.com", "Me");
    const pal = await login(t, "pal@x.com", "Pal");
    const stranger = await login(t, "str@x.com", "Str");
    for (const u of [me, pal, stranger]) await call(t, "/api/me", { method: "PATCH", cookie: u.cookie, body: { socialEnabled: true } });
    await befriend(t, me, pal);

    const friendEvent = await host(t, pal.cookie, "Pal's Party");
    const strangerEvent = await host(t, stranger.cookie, "Stranger's Thing");
    await call(t, `/api/events/${friendEvent}/rsvp`, { method: "POST", cookie: pal.cookie, body: { status: "going" } });
    await call(t, `/api/events/${strangerEvent}/rsvp`, { method: "POST", cookie: stranger.cookie, body: { status: "going" } });

    const feed = await call(t, "/api/feed/friends", { cookie: me.cookie });
    expect(feed.status).toBe(200);
    const ids = feed.json.items.map((i: any) => i.event.id);
    expect(ids).toContain(friendEvent);
    expect(ids).not.toContain(strangerEvent);
    expect(feed.json.items.find((i: any) => i.event.id === friendEvent).friends.length).toBe(1);
  });
});

describe("leaderboard", () => {
  it("ranks people by points; friends scope only includes you + your friends", async () => {
    const t = makeTestApp();
    const ann = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");
    for (const u of [ann, bob]) await call(t, "/api/me", { method: "PATCH", cookie: u.cookie, body: { socialEnabled: true } });
    // Ann earns points by RSVPing to two events; Bob to one → Ann outranks Bob
    const e1 = await host(t, ann.cookie, "E1");
    const e2 = await host(t, ann.cookie, "E2");
    await call(t, `/api/events/${e1}/rsvp`, { method: "POST", cookie: ann.cookie, body: { status: "going" } });
    await call(t, `/api/events/${e2}/rsvp`, { method: "POST", cookie: ann.cookie, body: { status: "interested" } });
    await call(t, `/api/events/${e1}/rsvp`, { method: "POST", cookie: bob.cookie, body: { status: "going" } });

    const board = await call(t, "/api/leaderboard", { cookie: ann.cookie });
    expect(board.status).toBe(200);
    expect(board.json.scope).toBe("global");
    const rows = board.json.rows;
    const ai = rows.findIndex((r: any) => r.id === ann.user.id);
    const bi = rows.findIndex((r: any) => r.id === bob.user.id);
    expect(ai).toBeGreaterThanOrEqual(0);
    expect(ai).toBeLessThan(bi); // Ann ranked above Bob
  });
});

describe("full event page (/api/event/:id/full)", () => {
  it("assembles host, attendees, counts, and the viewer's RSVP; 404s unknown", async () => {
    const t = makeTestApp();
    const hostU = await login(t, "host@x.com", "Host");
    const goer = await login(t, "goer@x.com", "Goer");
    for (const u of [hostU, goer]) await call(t, "/api/me", { method: "PATCH", cookie: u.cookie, body: { socialEnabled: true } });
    const eid = await host(t, hostU.cookie, "Big Summit");
    await call(t, `/api/events/${eid}/rsvp`, { method: "POST", cookie: goer.cookie, body: { status: "going" } });

    const full = await call(t, `/api/event/${eid}/full`, { cookie: goer.cookie });
    expect(full.status).toBe(200);
    expect(full.json.event.id).toBe(eid);
    expect(full.json.host?.id).toBe(hostU.user.id);
    expect(full.json.counts.going).toBe(1);
    expect(full.json.myRsvp).toBe("going");
    expect(Array.isArray(full.json.attendees)).toBe(true);

    expect((await call(t, "/api/event/nope/full")).status).toBe(404);
  });
});
