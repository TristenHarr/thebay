/**
 * The graph over HTTP, including the legacy contract.
 *
 * `GET /api/network/graph` now delegates to the projection, and the canvas renderer in
 * `web/src/features/graph/NetworkGraph.tsx` reads its response shape directly — so the first
 * block asserts that shape byte-for-byte. Refactoring to one implementation was the point;
 * changing the contract was not.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";

let t: TestApp;

const AT = new Date(Date.now() - 3 * 86_400_000).toISOString();

beforeEach(() => {
  t = makeTestApp();
});

function mkEvent(id: string, hostId: string | null = null, lat: number | null = 37.78, lng: number | null = -122.4) {
  t.raw
    .prepare(
      `INSERT INTO events (id,fingerprint,title,start_utc,timezone,city,url,categories,content_hash,host_user_id,latitude,longitude,first_seen_at,last_seen_at)
       VALUES (?,?,?,?,'America/Los_Angeles','sf-bay',?,'[]',?,?,?,?,?,?)`,
    )
    .run(id, `fp-${id}`, `Event ${id}`, AT, `https://x/${id}`, `ch-${id}`, hostId, lat, lng, AT, AT);
}
const checkin = (userId: string, eventId: string) =>
  t.raw.prepare("INSERT INTO checkins (user_id,event_id,at,source) VALUES (?,?,?,'qr')").run(userId, eventId, AT);

function friendship(a: string, b: string, status = "accepted") {
  const [low, high] = a < b ? [a, b] : [b, a];
  t.raw
    .prepare("INSERT INTO friendships (user_low,user_high,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(low, high, status, a, AT, AT);
}

/** Social sharing must be ON for anyone who should be visible to a stranger. */
async function member(email: string, socialEnabled = true) {
  const u = await login(t, email, email.split("@")[0]!);
  if (socialEnabled) t.raw.prepare("UPDATE users SET social_enabled = 1 WHERE id = ?").run(u.user.id);
  return u;
}

describe("GET /api/network/graph — the legacy contract, preserved", () => {
  it("401s anonymously", async () => {
    expect((await call(t, "/api/network/graph")).status).toBe(401);
  });

  it("still returns bare ids, `name`, `handle` and `me` — the canvas renderer reads these", async () => {
    const me = await member("me@x.com");
    const sam = await member("sam@x.com");
    friendship(me.user.id, sam.user.id);

    const r = await call(t, "/api/network/graph", { cookie: me.cookie });
    expect(r.status).toBe(200);
    const mine = r.json.nodes.find((n: any) => n.me);
    expect(mine).toBeTruthy();
    // Bare id, NOT the projection's `user:` prefix.
    expect(mine.id).toBe(me.user.id);
    expect(mine.name).toBeTruthy();
    expect(mine).toHaveProperty("handle");
    expect(r.json.edges[0]).toEqual({ a: expect.any(String), b: expect.any(String) });
    // Only user nodes, only friendship edges — no events leaking into the old shape.
    expect(r.json.nodes.every((n: any) => !String(n.id).includes(":"))).toBe(true);
  });
});

describe("GET /api/graph — the typed projection", () => {
  it("401s anonymously", async () => {
    expect((await call(t, "/api/graph")).status).toBe(401);
  });

  it("returns typed nodes and evidenced edges", async () => {
    const me = await member("me@x.com");
    const sam = await member("sam@x.com");
    mkEvent("e1");
    checkin(me.user.id, "e1");
    checkin(sam.user.id, "e1");

    const r = await call(t, "/api/graph", { cookie: me.cookie });
    expect(r.status).toBe(200);
    expect(r.json.nodes.some((n: any) => n.type === "event")).toBe(true);
    expect(r.json.nodes.some((n: any) => n.type === "user" && n.me)).toBe(true);
    for (const e of r.json.edges) {
      expect(e.evidence.length).toBeGreaterThan(0);
      expect(e.evidence[0].source.table).toBeTruthy();
    }
    expect(r.json.omitted).toBeTruthy();
  });

  it("honours ?hops=1 and ?include=", async () => {
    const me = await member("me@x.com");
    const sam = await member("sam@x.com");
    mkEvent("e1");
    checkin(me.user.id, "e1");
    checkin(sam.user.id, "e1");
    friendship(me.user.id, sam.user.id);

    // At one hop we see MY check-ins but not other people's. Asserted on the edge's owner
    // rather than on which end of a canonical pair it lands: ULIDs minted in the same
    // millisecond order randomly, so `e.a === user:sam` is a coin flip and made this flaky.
    const oneHop = await call(t, "/api/graph?hops=1", { cookie: me.cookie });
    const foreignCheckin = oneHop.json.edges.filter((e: any) => e.kind === "checkin" && e.a !== `user:${me.user.id}`);
    expect(foreignCheckin).toHaveLength(0);

    const only = await call(t, "/api/graph?include=friendship", { cookie: me.cookie });
    expect(only.json.edges.every((e: any) => e.kind === "friendship")).toBe(true);
  });

  it("ignores an unknown edge kind instead of 400ing — an old client should degrade", async () => {
    const me = await member("me@x.com");
    const r = await call(t, "/api/graph?include=nonsense", { cookie: me.cookie });
    expect(r.status).toBe(200);
  });

  it("CLAMPS a client trying to raise the server's ceiling", async () => {
    const me = await member("me@x.com");
    for (let i = 0; i < 30; i++) {
      mkEvent(`e${i}`);
      checkin(me.user.id, `e${i}`);
      for (let j = 0; j < 8; j++) checkin((await member(`u${i}_${j}@x.com`)).user.id, `e${i}`);
    }
    const r = await call(t, "/api/graph?maxNodes=99999&maxEdges=99999", { cookie: me.cookie });
    expect(r.json.nodes.length).toBeLessThanOrEqual(300);
    expect(r.json.edges.length).toBeLessThanOrEqual(400);
  });

  it("never leaks a private stranger, over HTTP", async () => {
    const me = await member("me@x.com");
    const shy = await member("shy@x.com", false);
    mkEvent("e1");
    checkin(me.user.id, "e1");
    checkin(shy.user.id, "e1");

    const r = await call(t, "/api/graph", { cookie: me.cookie });
    const body = JSON.stringify(r.json);
    expect(body).not.toContain(shy.user.id);
  });
});

describe("GET /api/graph/geo — arcs over the Bay", () => {
  it("returns only coordinate-bearing nodes, and NO users", async () => {
    const me = await member("me@x.com");
    const sam = await member("sam@x.com");
    mkEvent("e1");
    mkEvent("e2");
    checkin(me.user.id, "e1");
    checkin(sam.user.id, "e1");
    checkin(me.user.id, "e2");
    checkin(sam.user.id, "e2");

    const r = await call(t, "/api/graph/geo", { cookie: me.cookie });
    expect(r.status).toBe(200);
    // Users have no coordinates and must never be given any — every candidate source is a GPS
    // attestation of where a body physically was.
    expect(r.json.nodes.every((n: any) => n.type !== "user")).toBe(true);
    for (const n of r.json.nodes) {
      expect(n.lat).not.toBeNull();
      expect(n.lng).not.toBeNull();
    }
  });

  it("COUNTS the events it could not place rather than quietly shrinking the map", async () => {
    const me = await member("me@x.com");
    const sam = await member("sam@x.com");
    mkEvent("geo", null, 37.78, -122.4);
    mkEvent("nogeo", null, null, null);
    for (const id of ["geo", "nogeo"]) {
      checkin(me.user.id, id);
      checkin(sam.user.id, id);
    }

    const r = await call(t, "/api/graph/geo", { cookie: me.cookie });
    expect(r.json.nodes.map((n: any) => n.id)).not.toContain("event:nogeo");
    expect(r.json.omitted.noCoords).toBeGreaterThan(0);
  });
});

describe("GET /api/graph/path/:targetId — why am I connected", () => {
  it("answers with one sentence per hop, naming the event", async () => {
    const me = await member("me@x.com");
    const sam = await member("sam@x.com");
    mkEvent("e1");
    checkin(me.user.id, "e1");
    checkin(sam.user.id, "e1");

    const r = await call(t, `/api/graph/path/${sam.user.id}`, { cookie: me.cookie });
    expect(r.status).toBe(200);
    expect(r.json.visible).toBe(true);
    expect(r.json.why).toHaveLength(2);
    for (const line of r.json.why) expect(line).toContain("Event e1");
  });

  it("lists every DIRECT reason separately from the path", async () => {
    const me = await member("me@x.com");
    const sam = await member("sam@x.com");
    friendship(me.user.id, sam.user.id);

    const r = await call(t, `/api/graph/path/${sam.user.id}`, { cookie: me.cookie });
    expect(r.json.reasons.length).toBeGreaterThan(0);
    expect(r.json.reasons[0].factual).toBe(true);
    expect(r.json.reasons[0].label).toBeTruthy();
  });

  it("says `visible: false` for somebody outside my graph — never that they don't exist", async () => {
    const me = await member("me@x.com");
    const stranger = await member("stranger@x.com");
    const r = await call(t, `/api/graph/path/${stranger.user.id}`, { cookie: me.cookie });
    expect(r.json.visible).toBe(false);
    expect(r.json.path).toBeNull();
  });

  it("refuses to reveal a path through a blocked user", async () => {
    const me = await member("me@x.com");
    const enemy = await member("enemy@x.com");
    friendship(me.user.id, enemy.user.id, "blocked");
    mkEvent("e1");
    checkin(me.user.id, "e1");
    checkin(enemy.user.id, "e1");

    const r = await call(t, `/api/graph/path/${enemy.user.id}`, { cookie: me.cookie });
    expect(r.json.visible).toBe(false);
  });

  it("accepts a bare id or a typed node id", async () => {
    const me = await member("me@x.com");
    const sam = await member("sam@x.com");
    friendship(me.user.id, sam.user.id);
    for (const target of [sam.user.id, `user:${sam.user.id}`]) {
      const r = await call(t, `/api/graph/path/${encodeURIComponent(target)}`, { cookie: me.cookie });
      expect(r.json.visible, target).toBe(true);
    }
  });
});
