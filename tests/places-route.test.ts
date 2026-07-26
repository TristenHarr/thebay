import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { encode } from "../src/core/geohash";

/**
 * HTTP surface of the crowd city map. Reads are public and cheap; writes are
 * signed-in, Bay-GPS-gated AND proximity-gated — you cannot pin a resource you
 * are not standing next to (the shape of POST /api/notes, one step stricter).
 */

let t: TestApp;
beforeEach(() => { t = makeTestApp({ INGEST_TOKEN: "tok" }); });

const SF = { lat: 37.7749, lng: -122.4194 };
const LA = { lat: 34.0522, lng: -118.2437 };

async function pin(cookie: string, over: Record<string, unknown> = {}) {
  return call(t, "/api/places", { method: "POST", cookie, body: { kindId: "parking", name: "Otis St", lat: SF.lat, lng: SF.lng, attrs: { type: "street" }, ...over } });
}

describe("GET /api/place-kinds", () => {
  it("serves the ratified taxonomy publicly, with icons and form schemas", async () => {
    const r = await call(t, "/api/place-kinds");
    expect(r.status).toBe(200);
    const parking = r.json.kinds.find((k: any) => k.id === "parking");
    expect(parking.emoji).toBeTruthy();
    expect(parking.halfLifeHours).toBe(6);
    expect(parking.fields.some((f: any) => f.key === "sweepDay" && f.type === "enum")).toBe(true);
    expect(r.json.kinds.every((k: any) => k.status === "active")).toBe(true);
  });
});

describe("the crowd proposes and ratifies the taxonomy", () => {
  it("needs an account to propose", async () => {
    expect((await call(t, "/api/place-kinds", { method: "POST", body: { label: "Bike rack", emoji: "🚲" } })).status).toBe(401);
  });

  it("proposes → collects votes → goes live on the map at the threshold", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    const bob = await login(t, "b@x.com", "Bob");
    const cara = await login(t, "c@x.com", "Cara");

    const created = await call(t, "/api/place-kinds", { method: "POST", cookie: ann.cookie, body: { label: "Bike rack", emoji: "🚲", halfLifeHours: 4320, fields: [{ key: "covered", label: "Covered", type: "bool" }] } });
    expect(created.status).toBe(200);
    expect(created.json.kind).toMatchObject({ id: "bike_rack", status: "proposed", votes: 1 });

    // proposed kinds are visible to vote on, but are not a map layer yet
    expect((await call(t, "/api/place-kinds?status=proposed")).json.kinds.map((k: any) => k.id)).toContain("bike_rack");
    expect((await call(t, "/api/place-kinds")).json.kinds.map((k: any) => k.id)).not.toContain("bike_rack");
    // ...and you cannot pin one until the crowd ratifies it
    expect((await pin(bob.cookie, { kindId: "bike_rack" })).status).toBe(400);

    expect((await call(t, "/api/place-kinds/bike_rack/vote", { method: "POST", cookie: bob.cookie })).json).toMatchObject({ votes: 2, status: "proposed" });
    const third = await call(t, "/api/place-kinds/bike_rack/vote", { method: "POST", cookie: cara.cookie });
    expect(third.json).toMatchObject({ votes: 3, status: "active", ratified: true });

    // ratified ⇒ it's a layer, and its declared form is what governs its attrs
    expect((await call(t, "/api/place-kinds")).json.kinds.map((k: any) => k.id)).toContain("bike_rack");
    const p = await pin(bob.cookie, { kindId: "bike_rack", attrs: { covered: "true", rogue: 1 } });
    expect(p.status).toBe(200);
    expect(p.json.place.attrs).toEqual({ covered: true });
  });

  it("rejects a proposal with no emoji, and a vote for a kind that doesn't exist", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    expect((await call(t, "/api/place-kinds", { method: "POST", cookie: ann.cookie, body: { label: "Nope", emoji: "" } })).status).toBe(400);
    expect((await call(t, "/api/place-kinds/ghost/vote", { method: "POST", cookie: ann.cookie })).status).toBe(404);
  });
});

describe("POST /api/places — you have to actually be there", () => {
  it("needs an account", async () => {
    expect((await call(t, "/api/places", { method: "POST", body: { kindId: "parking", lat: SF.lat, lng: SF.lng } })).status).toBe(401);
  });

  it("refuses a pin from outside the Bay", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    const r = await pin(ann.cookie, { lat: LA.lat, lng: LA.lng });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/bay/i);
  });

  it("refuses a pin dropped across town from where you are standing", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    const r = await pin(ann.cookie, { pinLat: 37.8044, pinLng: -122.2712 }); // Oakland, ~13km away
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/next to|nearby|there/i);
  });

  it("accepts a pin at your feet, stamps a cell, and pays out", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    const r = await pin(ann.cookie);
    expect(r.status).toBe(200);
    expect(r.json.place.geohash).toBe(encode(SF.lat, SF.lng, 7));
    expect(r.json.place.origin).toBe("crowd");
    const me = await call(t, "/api/me", { cookie: ann.cookie });
    expect(me.json.points).toBeGreaterThanOrEqual(10);
  });

  it("rejects an unknown kind and malformed coordinates", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    expect((await pin(ann.cookie, { kindId: "teleporter" })).status).toBe(400);
    expect((await call(t, "/api/places", { method: "POST", cookie: ann.cookie, body: { kindId: "parking", lat: "here", lng: SF.lng } })).status).toBe(400);
  });
});

describe("reading the map", () => {
  it("returns the pins in a viewport's cells, with icon + trust + parking legality", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    await pin(ann.cookie, { attrs: { type: "street", sweepDay: "Tue", sweepWindow: "08:00-10:00" } });
    const cells = encode(SF.lat, SF.lng, 6);
    const r = await call(t, `/api/places?cells=${cells}`);
    expect(r.status).toBe(200);
    expect(r.json.places.length).toBe(1);
    const p = r.json.places[0];
    expect(p.kind.emoji).toBeTruthy();
    expect(typeof p.trust).toBe("number");
    expect(p.parking.reason).toBeTruthy(); // the legality sentence rides along
    expect(typeof p.parking.legal).toBe("boolean");
  });

  it("ignores junk cells and filters by kind", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    await pin(ann.cookie);
    const cells = encode(SF.lat, SF.lng, 6);
    expect((await call(t, "/api/places?cells=")).json.places).toEqual([]);
    expect((await call(t, `/api/places?cells=${cells},NOT!A!CELL`)).json.places.length).toBe(1);
    expect((await call(t, `/api/places?cells=${cells}&kinds=wifi`)).json.places.length).toBe(0);
  });

  it("serves a radius query for 'what's around me'", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    await pin(ann.cookie);
    const near = await call(t, `/api/places/near?lat=${SF.lat}&lng=${SF.lng}&km=1`);
    expect(near.json.places.length).toBe(1);
    expect(near.json.places[0].km).toBeLessThan(0.01);
    expect((await call(t, `/api/places/near?lat=${LA.lat}&lng=${LA.lng}&km=1`)).json.places).toEqual([]);
    expect((await call(t, "/api/places/near")).status).toBe(400);
  });

  it("serves a pin's detail sheet with its report stream", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    const p = await pin(ann.cookie);
    const id = p.json.place.id;
    await call(t, `/api/places/${id}/report`, { method: "POST", cookie: ann.cookie, body: { verdict: "tip", attrs: { difficulty: 4, minutesToFind: 9 }, lat: SF.lat, lng: SF.lng } });
    const r = await call(t, `/api/places/${id}`);
    expect(r.status).toBe(200);
    expect(r.json.place.id).toBe(id);
    expect(r.json.reports.length).toBe(1);
    expect(r.json.reports[0].author.handle).toBeTruthy();
    expect(r.json.difficulty.difficulty).toBeCloseTo(4, 3);
    expect(r.json.difficulty.minutesToFind).toBeCloseTo(9, 3);
    expect((await call(t, "/api/places/nope")).status).toBe(404);
  });
});

describe("POST /api/places/:id/report — keeping the map true", () => {
  it("confirms from the spot, and pays a smaller point for it", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    const bob = await login(t, "b@x.com", "Bob");
    const id = (await pin(ann.cookie)).json.place.id;
    const r = await call(t, `/api/places/${id}/report`, { method: "POST", cookie: bob.cookie, body: { verdict: "confirm", lat: SF.lat, lng: SF.lng } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ confirms: 1, disputes: 0 });
    expect((await call(t, `/api/places/${id}`)).json.place.freshness).toBe("fresh");
    const me = await call(t, "/api/me", { cookie: bob.cookie });
    expect(me.json.points).toBe(3);
  });

  it("refuses a report from the other side of the bridge", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    const id = (await pin(ann.cookie)).json.place.id;
    const far = await call(t, `/api/places/${id}/report`, { method: "POST", cookie: ann.cookie, body: { verdict: "confirm", lat: 37.8044, lng: -122.2712 } });
    expect(far.status).toBe(403);
    const outside = await call(t, `/api/places/${id}/report`, { method: "POST", cookie: ann.cookie, body: { verdict: "confirm", lat: LA.lat, lng: LA.lng } });
    expect(outside.status).toBe(403);
  });

  it("rejects a verdict nobody defined and a report on a missing pin", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    const id = (await pin(ann.cookie)).json.place.id;
    expect((await call(t, `/api/places/${id}/report`, { method: "POST", cookie: ann.cookie, body: { verdict: "shrug", lat: SF.lat, lng: SF.lng } })).status).toBe(400);
    expect((await call(t, "/api/places/ghost/report", { method: "POST", cookie: ann.cookie, body: { verdict: "confirm", lat: SF.lat, lng: SF.lng } })).status).toBe(404);
  });

  it("an 'update' from the spot corrects the attrs, and the legality string with them", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    const id = (await pin(ann.cookie)).json.place.id;
    await call(t, `/api/places/${id}/report`, { method: "POST", cookie: ann.cookie, body: { verdict: "update", attrs: { sweepDay: "Tue", sweepWindow: "08:00-10:00" }, lat: SF.lat, lng: SF.lng } });
    const after = await call(t, `/api/places/${id}`);
    expect(after.json.place.attrs).toMatchObject({ sweepDay: "Tue", sweepWindow: "08:00-10:00" });
    expect(after.json.parking.reason).toMatch(/sweeping|legal/i);
  });
});

describe("POST /api/places/:id/flag", () => {
  it("records one flag per person and never hides the pin by itself", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    const id = (await pin(ann.cookie)).json.place.id;
    expect((await call(t, `/api/places/${id}/flag`, { method: "POST", cookie: ann.cookie, body: { reason: "spam" } })).status).toBe(200);
    expect((await call(t, `/api/places/${id}/flag`, { method: "POST", cookie: ann.cookie, body: { reason: "abuse" } })).status).toBe(200);
    const rows = t.raw.prepare("SELECT * FROM flags WHERE target_type='place'").all() as any[];
    expect(rows.length).toBe(1);
    expect((await call(t, `/api/places/${id}`)).json.place.hidden).toBe(false); // a flag is a signal, not an action
    expect((await call(t, `/api/places/${id}/flag`, { method: "POST", body: {} })).status).toBe(401);
  });
});

describe("GET /api/events/:id/parking — the reason anyone opens this feature", () => {
  function insertEvent(id: string, startUtc: string, lat: number, lng: number) {
    t.raw.prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, venue_name, url, content_hash, first_seen_at, last_seen_at, latitude, longitude)
       VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'sf-bay', 'The Venue', 'https://x', ?, '2026-01-01', '2026-01-01', ?, ?)`,
    ).run(id, "fp-" + id, "Founders Gathering", startUtc, "ch-" + id, lat, lng);
  }

  it("ranks nearby parking by distance × trust × legality AT THE EVENT'S START", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    // Tue 2026-07-07, 05:45 PDT — a spot swept 05:00–07:00 is illegal right then.
    insertEvent("e1", "2026-07-07T12:45:00.000Z", SF.lat, SF.lng);
    const swept = (await pin(ann.cookie, { name: "Swept block", pinLat: SF.lat + 0.0005, pinLng: SF.lng, attrs: { type: "street", sweepDay: "Tue", sweepWindow: "05:00-07:00" } })).json.place.id;
    const ok = (await pin(ann.cookie, { name: "Clear block", pinLat: SF.lat + 0.006, pinLng: SF.lng, attrs: { type: "street" } })).json.place.id;

    const r = await call(t, "/api/events/e1/parking");
    expect(r.status).toBe(200);
    expect(r.json.event).toMatchObject({ id: "e1", venueName: "The Venue" });
    expect(r.json.options.map((o: any) => o.id)).toEqual([ok, swept]); // legal beats closer
    const sweptOpt = r.json.options.find((o: any) => o.id === swept);
    expect(sweptOpt.legal).toBe(false);
    expect(sweptOpt.reason).toMatch(/street sweeping/i);
    expect(r.json.options[0].km).toBeGreaterThan(0);
  });

  it("carries the crowd's live difficulty tips through to each option", async () => {
    const ann = await login(t, "a@x.com", "Ann");
    insertEvent("e1", "2026-07-07T12:45:00.000Z", SF.lat, SF.lng);
    const id = (await pin(ann.cookie)).json.place.id;
    await call(t, `/api/places/${id}/report`, { method: "POST", cookie: ann.cookie, body: { verdict: "tip", attrs: { difficulty: 5, minutesToFind: 20 }, lat: SF.lat, lng: SF.lng } });
    const r = await call(t, "/api/events/e1/parking");
    expect(r.json.options[0].difficulty.difficulty).toBeCloseTo(5, 3);
    expect(r.json.options[0].difficulty.minutesToFind).toBeCloseTo(20, 3);
  });

  it("404s for an unknown event and says so plainly for an event with no coordinates", async () => {
    expect((await call(t, "/api/events/ghost/parking")).status).toBe(404);
    t.raw.prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at)
       VALUES ('e2','fp-e2','No Coords','2026-07-07T12:45:00.000Z','America/Los_Angeles','sf-bay','https://x','ch-e2','2026-01-01','2026-01-01')`,
    ).run();
    const r = await call(t, "/api/events/e2/parking");
    expect(r.status).toBe(200);
    expect(r.json.options).toEqual([]);
    expect(r.json.note).toMatch(/coordinates|geocoded/i);
  });
});

describe("POST /api/admin/places-import — seeding the map from DataSF", () => {
  const items = [
    { externalRef: "datasf:meter:1", kindId: "parking", name: "1st St", lat: SF.lat, lng: SF.lng, attrs: { type: "street" } },
    { externalRef: "datasf:garage:9", kindId: "parking", name: "Fifth & Mission", lat: SF.lat + 0.002, lng: SF.lng, attrs: { type: "garage", priceHint: "$3.50/hr" } },
  ];

  it("is bearer-gated", async () => {
    expect((await call(t, "/api/admin/places-import", { method: "POST", body: { places: items } })).status).toBe(401);
    expect((await call(t, "/api/admin/places-import", { method: "POST", body: { places: items }, headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("imports, then re-imports idempotently (external_ref)", async () => {
    const auth = { authorization: "Bearer tok" };
    const first = await call(t, "/api/admin/places-import", { method: "POST", body: { places: items }, headers: auth });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ inserted: 2, updated: 0, skipped: 0 });
    const again = await call(t, "/api/admin/places-import", { method: "POST", body: { places: items }, headers: auth });
    expect(again.json).toMatchObject({ inserted: 0, updated: 2 });
    expect((t.raw.prepare("SELECT COUNT(*) n FROM places").get() as any).n).toBe(2);
    expect((t.raw.prepare("SELECT origin FROM places LIMIT 1").get() as any).origin).toBe("import");
  });

  it("skips bad rows without failing the run, and rejects a malformed payload", async () => {
    const auth = { authorization: "Bearer tok" };
    const r = await call(t, "/api/admin/places-import", {
      method: "POST",
      headers: auth,
      body: { places: [items[0], { externalRef: "x", kindId: "wormhole", lat: 1, lng: 2 }, { kindId: "parking", lat: SF.lat, lng: SF.lng }] },
    });
    expect(r.json).toMatchObject({ inserted: 1, skipped: 2 });
    expect((await call(t, "/api/admin/places-import", { method: "POST", headers: auth, body: { nope: 1 } })).status).toBe(400);
  });
});
