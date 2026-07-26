/**
 * Types, vouches, cards and badges over HTTP — plus the read path that had been missing since
 * the matching screen shipped.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { FOUNDER_TYPES } from "../src/core/types/chart";

let t: TestApp;
const AT = "2026-07-01T18:00:00Z";

beforeEach(() => {
  t = makeTestApp();
});

function mkEvent(id: string, hostId: string | null, title = "Founders Night") {
  t.raw
    .prepare(
      `INSERT INTO events (id,fingerprint,title,start_utc,timezone,city,url,categories,content_hash,host_user_id,first_seen_at,last_seen_at)
       VALUES (?,?,?,?,'America/Los_Angeles','sf-bay',?,'[]',?,?,?,?)`,
    )
    .run(id, `fp-${id}`, title, AT, `https://x/${id}`, `ch-${id}`, hostId, AT, AT);
}

const social = (id: string) => t.raw.prepare("UPDATE users SET social_enabled = 1 WHERE id = ?").run(id);

describe("the type chart over HTTP", () => {
  it("is public and served from the table", async () => {
    const r = await call(t, "/api/founder-types");
    expect(r.status).toBe(200);
    expect(r.json.types.map((x: any) => x.id)).toEqual(FOUNDER_TYPES.map((x) => x.id));
    for (const x of r.json.types) {
      expect(x.emoji).toBeTruthy();
      expect(x.color).toBeTruthy();
    }
  });
});

describe("declaring a type", () => {
  it("401s anonymously", async () => {
    expect((await call(t, "/api/me/identity", { method: "PUT", body: { typeId: "founder" } })).status).toBe(401);
  });

  it("round-trips a primary and secondary", async () => {
    const me = await login(t);
    const put = await call(t, "/api/me/identity", { method: "PUT", cookie: me.cookie, body: { typeId: "founder", type2Id: "engineer" } });
    expect(put.status).toBe(200);
    const got = await call(t, "/api/me/identity", { cookie: me.cookie });
    expect(got.json).toMatchObject({ typeId: "founder", type2Id: "engineer" });
  });

  it("400s an unknown type rather than storing it", async () => {
    const me = await login(t);
    const r = await call(t, "/api/me/identity", { method: "PUT", cookie: me.cookie, body: { typeId: "timelord" } });
    expect(r.status).toBe(400);
  });

  it("400s the same type twice", async () => {
    const me = await login(t);
    expect((await call(t, "/api/me/identity", { method: "PUT", cookie: me.cookie, body: { typeId: "vc", type2Id: "vc" } })).status).toBe(400);
  });
});

describe("vouching", () => {
  it("records a vouch and is idempotent", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    const bob = await login(t, "b@x.com", "Bob");
    const body = { typeId: "vc" };
    expect((await call(t, `/api/users/${ann.user.id}/vouch`, { method: "POST", cookie: bob.cookie, body })).json.ok).toBe(true);
    expect((await call(t, `/api/users/${ann.user.id}/vouch`, { method: "POST", cookie: bob.cookie, body })).json.already).toBe(true);
  });

  it("403s a self-vouch", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    const r = await call(t, `/api/users/${ann.user.id}/vouch`, { method: "POST", cookie: ann.cookie, body: { typeId: "vc" } });
    expect(r.status).toBe(403);
  });

  it("PAYS NOTHING — no XP, no points", async () => {
    // The firewall, over HTTP. A paid vouch is a market for the least checkable claim here.
    const ann = await login(t, "a@x.com", "Ann");
    const bob = await login(t, "b@x.com", "Bob");
    await call(t, `/api/users/${ann.user.id}/vouch`, { method: "POST", cookie: bob.cookie, body: { typeId: "vc" } });
    const xp = await call(t, "/api/me/xp", { cookie: ann.cookie });
    expect(xp.json.xp).toBe(0);
    const me = await call(t, "/api/me", { cookie: ann.cookie });
    expect(me.json.points ?? 0).toBe(0);
  });
});

describe("the card", () => {
  it("renders my own card with types and level", async () => {
    const me = await login(t);
    await call(t, "/api/me/identity", { method: "PUT", cookie: me.cookie, body: { typeId: "founder" } });
    t.raw.prepare("INSERT INTO xp_ledger (id,user_id,kind,xp,dedup_key,created_at) VALUES ('x1',?,'gym',900,'k1',?)").run(me.user.id, AT);

    const r = await call(t, "/api/me/card", { cookie: me.cookie });
    expect(r.status).toBe(200);
    expect(r.json.card.level.level).toBe(4);
    expect(r.json.card.types[0].id).toBe("founder");
    expect(r.json.card.stats).toHaveProperty("power");
    expect(r.json.card.rarity).toBeTruthy();
  });

  it("shows a public card by handle", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    social(ann.user.id);
    const other = await login(t, "b@x.com", "Bob");
    const r = await call(t, `/api/u/${ann.user.handle}/card`, { cookie: other.cookie });
    expect(r.status).toBe(200);
    expect(r.json.card.handle).toBe(ann.user.handle);
  });

  it("404s a card for somebody who opted OUT of the social graph", async () => {
    // A card is a public profile in a game costume; it must not become the back door to one.
    const ann = await login(t, "a@x.com", "Ann"); // social_enabled defaults to 0
    const other = await login(t, "b@x.com", "Bob");
    expect((await call(t, `/api/u/${ann.user.handle}/card`, { cookie: other.cookie })).status).toBe(404);
    // …but they can always see their own.
    expect((await call(t, `/api/u/${ann.user.handle}/card`, { cookie: ann.cookie })).status).toBe(200);
  });
});

describe("affinity — is this room mine?", () => {
  it("puts an engineer at home at a hackathon and a VC out of place", async () => {
    const eng = await login(t, "e@x.com", "Eng");
    await call(t, "/api/me/identity", { method: "PUT", cookie: eng.cookie, body: { typeId: "engineer" } });
    const vc = await login(t, "v@x.com", "Vee");
    await call(t, "/api/me/identity", { method: "PUT", cookie: vc.cookie, body: { typeId: "vc" } });
    mkEvent("e1", null, "AI Hackathon 2026");

    const forEng = await call(t, "/api/events/e1/affinity", { cookie: eng.cookie });
    expect(forEng.json.archetype).toBe("hackathon");
    expect(forEng.json.band).toBe("home");

    const forVc = await call(t, "/api/events/e1/affinity", { cookie: vc.cookie });
    expect(forVc.json.band).toBe("stretch");
    // …and it names who the room is short of.
    expect(forVc.json.missing.map((m: any) => m.id)).toContain("vc");
  });

  it("shrugs, rather than guessing, for an undeclared user or an unclassifiable listing", async () => {
    const me = await login(t);
    mkEvent("e1", null, "Scarlet Thread Exhibit");
    const r = await call(t, "/api/events/e1/affinity", { cookie: me.cookie });
    expect(r.json.archetype).toBeNull();
    expect(r.json.declared).toBe(false);
    expect(r.json.score).toBe(0.5);
    expect(r.json.missing).toEqual([]);
  });
});

describe("host-minted badges", () => {
  it("mints and awards, and 403s a non-host", async () => {
    const host = await login(t, "h@x.com", "Host");
    mkEvent("e1", host.user.id);
    const ann = await login(t, "a@x.com", "Ann");

    expect((await call(t, "/api/events/e1/gym/badges", { method: "POST", cookie: ann.cookie, body: { label: "Best Demo", emoji: "🏅" } })).status).toBe(403);

    const mint = await call(t, "/api/events/e1/gym/badges", { method: "POST", cookie: host.cookie, body: { label: "Best Demo", emoji: "🏅" } });
    expect(mint.status).toBe(200);
    const award = await call(t, `/api/events/e1/gym/badges/${mint.json.badgeId}/award`, { method: "POST", cookie: host.cookie, body: { userId: ann.user.id } });
    expect(award.json.granted).toBe(true);

    // It shows up on the recipient's card, with provenance.
    const card = await call(t, "/api/me/card", { cookie: ann.cookie });
    expect(card.json.card.badges[0].label).toBe("Best Demo");
    expect(card.json.card.badges[0].awardedBy).toBe(host.user.handle);
  });

  it("409s a badge named after a system trophy, with copy explaining why", async () => {
    const host = await login(t, "h@x.com", "Host");
    mkEvent("e1", host.user.id);
    const r = await call(t, "/api/events/e1/gym/badges", { method: "POST", cookie: host.cookie, body: { label: "Local Legend", emoji: "🏅" } });
    expect(r.status).toBe(409);
    expect(r.json.result).toBe("reserved");
    expect(r.json.error).toMatch(/system trophy/i);
  });

  it("PAYS NO XP — a badge is a ceremony, not a payment", async () => {
    // If a badge paid, the gym budget in migrations/0028 would be bypassable through badges
    // and the whole anti-inflation bound would be decorative.
    const host = await login(t, "h@x.com", "Host");
    mkEvent("e1", host.user.id);
    const ann = await login(t, "a@x.com", "Ann");
    const mint = await call(t, "/api/events/e1/gym/badges", { method: "POST", cookie: host.cookie, body: { label: "Best Demo", emoji: "🏅" } });
    await call(t, `/api/events/e1/gym/badges/${mint.json.badgeId}/award`, { method: "POST", cookie: host.cookie, body: { userId: ann.user.id } });

    expect((await call(t, "/api/me/xp", { cookie: ann.cookie })).json.xp).toBe(0);
  });

  it("lists an event's badges publicly", async () => {
    const host = await login(t, "h@x.com", "Host");
    mkEvent("e1", host.user.id);
    await call(t, "/api/events/e1/gym/badges", { method: "POST", cookie: host.cookie, body: { label: "Best Demo", emoji: "🏅" } });
    const r = await call(t, "/api/events/e1/gym/badges");
    expect(r.status).toBe(200);
    expect(r.json.badges).toHaveLength(1);
  });
});

describe("GET /api/me/match-prefs — the read path that never existed", () => {
  it("round-trips interests, which were written by a live screen and read by nothing", async () => {
    const me = await login(t);
    await call(t, "/api/match/prefs", { method: "PUT", cookie: me.cookie, body: { technical: true, interests: ["ai", "hardware"], looking: true } });

    const r = await call(t, "/api/me/match-prefs", { cookie: me.cookie });
    expect(r.status).toBe(200);
    expect(r.json.prefs.interests).toEqual(["ai", "hardware"]);
    expect(r.json.prefs.technical).toBe(true);
  });

  it("returns null for somebody who never set any, rather than an empty shape", async () => {
    const me = await login(t);
    expect((await call(t, "/api/me/match-prefs", { cookie: me.cookie })).json.prefs).toBeNull();
  });

  it("feeds the card's stat axes — the reason this column existing unread mattered", async () => {
    const me = await login(t);
    await call(t, "/api/match/prefs", { method: "PUT", cookie: me.cookie, body: { technical: true, interests: ["vc", "angel", "seed"] } });
    const card = await call(t, "/api/me/card", { cookie: me.cookie });
    // `capital` and `technical` were structurally always zero before this read path existed.
    expect(card.json.card.stats.capital).toBeGreaterThan(0);
    expect(card.json.card.stats.technical).toBeGreaterThan(0);
  });
});
