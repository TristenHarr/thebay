import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { PlacesRepo, PLACE_PRECISION, RATIFY_VOTES } from "../src/storage/d1/places-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { encode } from "../src/core/geohash";

let d1: any, raw: Database.Database, repo: PlacesRepo, social: SocialRepo;
beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  repo = new PlacesRepo(d1);
  social = new SocialRepo(d1);
});

async function mkUser(email: string, name: string) {
  const u = await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: name });
  return (await social.getUserById(u.id))!;
}
const SF = { lat: 37.7749, lng: -122.4194 };
const T0 = "2026-07-26T18:00:00.000Z";

describe("PlacesRepo — the crowd taxonomy", () => {
  it("seeds day-one kinds and only lists the active ones by default", async () => {
    const kinds = await repo.listKinds();
    expect(kinds.map((k) => k.id)).toContain("parking");
    expect(kinds.every((k) => k.status === "active")).toBe(true);
    expect(kinds.find((k) => k.id === "parking")!.emoji).toBeTruthy();
    expect(kinds.find((k) => k.id === "parking")!.fields.map((f) => f.key)).toContain("sweepDay");
  });

  it("a proposal starts 'proposed' with the proposer's own vote already counted", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const k = await repo.proposeKind(ann.id, { label: "Dog water bowl", emoji: "🐕", halfLifeHours: 240, fields: [{ key: "working", label: "Working", type: "bool" }] }, T0);
    expect(k.id).toBe("dog_water_bowl");
    expect(k.status).toBe("proposed");
    expect(k.votes).toBe(1);
    expect(k.halfLifeHours).toBe(240);
    expect((await repo.listKinds()).map((x) => x.id)).not.toContain("dog_water_bowl"); // not on the map yet
    expect((await repo.listKinds({ status: "proposed" })).map((x) => x.id)).toContain("dog_water_bowl");
  });

  it("ratifies a kind at N distinct votes — and a second vote from the same person changes nothing", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const bob = await mkUser("b@x.com", "Bob");
    const cara = await mkUser("c@x.com", "Cara");
    const k = await repo.proposeKind(ann.id, { label: "Bike rack", emoji: "🚲" }, T0);
    expect(RATIFY_VOTES).toBe(3);

    expect(await repo.voteKind(k.id, ann.id)).toMatchObject({ votes: 1, status: "proposed" }); // already voted
    const two = await repo.voteKind(k.id, bob.id);
    expect(two).toMatchObject({ votes: 2, status: "proposed", ratified: false });
    const three = await repo.voteKind(k.id, cara.id);
    expect(three).toMatchObject({ votes: 3, status: "active", ratified: true });
    // ratifying is a one-time transition, not something re-votes re-trigger
    expect(await repo.voteKind(k.id, cara.id)).toMatchObject({ ratified: false, status: "active" });
    expect((await repo.listKinds()).map((x) => x.id)).toContain("bike_rack");
  });

  it("rejects a proposal with no emoji or an unusable label", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    await expect(repo.proposeKind(ann.id, { label: "No icon", emoji: "" })).rejects.toThrow();
    await expect(repo.proposeKind(ann.id, { label: "🚰", emoji: "🚰" })).rejects.toThrow(); // unsluggable
  });
});

describe("PlacesRepo — pins", () => {
  it("stamps a geohash cell, defaults to crowd origin, and coerces attrs to the kind's schema", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const p = await repo.createPlace({
      kindId: "parking",
      name: "Otis St meters",
      lat: SF.lat,
      lng: SF.lng,
      createdBy: ann.id,
      attrs: { type: "STREET", sweepDay: "Tue", nonsense: "dropped", maxHeight: "7 ft" },
    }, T0);
    expect(p.geohash).toBe(encode(SF.lat, SF.lng, PLACE_PRECISION));
    expect(p.origin).toBe("crowd");
    expect(p.attrs).toEqual({ type: "street", sweepDay: "Tue", maxHeight: 7 });
    expect(p.confirms).toBe(0);
  });

  it("refuses a pin for a kind nobody ratified", async () => {
    await expect(repo.createPlace({ kindId: "teleporter", lat: SF.lat, lng: SF.lng }, T0)).rejects.toThrow();
  });

  it("reads back by viewport cells with the kind's icon and a live trust score", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const p = await repo.createPlace({ kindId: "parking", lat: SF.lat, lng: SF.lng, createdBy: ann.id }, T0);
    const cell = encode(SF.lat, SF.lng, 6);
    const found = await repo.inCells([cell], { at: T0 });
    expect(found.map((x) => x.id)).toEqual([p.id]);
    expect(found[0]!.kind.emoji).toBeTruthy();
    expect(found[0]!.kind.halfLifeHours).toBe(6); // parking rots fast
    expect(typeof found[0]!.trust).toBe("number");
    expect(found[0]!.freshness).toBe("disputed"); // nobody has vouched for it yet
    expect(await repo.inCells([encode(37.3382, -121.8863, 6)], { at: T0 })).toEqual([]); // San Jose
  });

  it("filters by kind and hides hidden pins", async () => {
    await repo.createPlace({ kindId: "parking", lat: SF.lat, lng: SF.lng }, T0);
    const wifi = await repo.createPlace({ kindId: "wifi", lat: SF.lat, lng: SF.lng }, T0);
    const cell = encode(SF.lat, SF.lng, 6);
    expect((await repo.inCells([cell], { kindIds: ["wifi"], at: T0 })).map((x) => x.id)).toEqual([wifi.id]);
    await repo.setHidden(wifi.id, true);
    expect((await repo.inCells([cell], { kindIds: ["wifi"], at: T0 })).length).toBe(0);
  });

  it("nearby() returns pins inside the radius and nothing outside it", async () => {
    const here = await repo.createPlace({ kindId: "parking", lat: SF.lat, lng: SF.lng }, T0);
    await repo.createPlace({ kindId: "parking", lat: SF.lat + 0.05, lng: SF.lng }, T0); // ~5.5km
    const near = await repo.nearby(SF.lat, SF.lng, 1, { at: T0 });
    expect(near.map((x) => x.id)).toEqual([here.id]);
    expect(near[0]!.km).toBeLessThan(0.01);
    expect((await repo.nearby(SF.lat, SF.lng, 10, { at: T0 })).length).toBe(2);
  });

  it("stays under D1's 100-bound-parameter ceiling for a wide viewport", async () => {
    // The shim throws over 100 params, so an unchunked IN() fails loudly here
    // instead of 500ing in production.
    const cells = Array.from({ length: 400 }, (_, i) => encode(37.7 + i * 0.001, -122.4, 6));
    await expect(repo.inCells(cells, { at: T0 })).resolves.toBeInstanceOf(Array);
  });
});

describe("PlacesRepo — confirm / dispute / tip", () => {
  it("a confirm bumps the counter and resets the freshness clock", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const p = await repo.createPlace({ kindId: "parking", lat: SF.lat, lng: SF.lng }, T0);
    const r = await repo.report(p.id, ann.id, { verdict: "confirm", lat: SF.lat, lng: SF.lng }, T0);
    expect(r).toMatchObject({ confirms: 1, disputes: 0 });
    const row = raw.prepare("SELECT * FROM places WHERE id=?").get(p.id) as any;
    expect(row.last_confirmed_at).toBe(T0);
    const got = await repo.getPlace(p.id, T0);
    expect(got!.trust).toBeCloseTo(1, 6);
    expect(got!.freshness).toBe("fresh");
  });

  it("counts DISTINCT vouchers — one person cannot tap trust up fifty times", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const bob = await mkUser("b@x.com", "Bob");
    const p = await repo.createPlace({ kindId: "parking", lat: SF.lat, lng: SF.lng }, T0);
    for (let i = 0; i < 5; i++) await repo.report(p.id, ann.id, { verdict: "confirm" }, T0);
    expect((await repo.getPlace(p.id, T0))!.confirms).toBe(1);
    expect(await repo.report(p.id, bob.id, { verdict: "confirm" }, T0)).toMatchObject({ confirms: 2 });
    // ...but a LATER confirm from the same person still refreshes the pin, which
    // is the whole mechanism that keeps the map true.
    const later = "2026-07-27T18:00:00.000Z";
    await repo.report(p.id, ann.id, { verdict: "confirm" }, later);
    const after = await repo.getPlace(p.id, later);
    expect(after!.confirms).toBe(2);
    expect(after!.lastConfirmedAt).toBe(later);
    expect(after!.freshness).toBe("fresh");
    // and disputes are counted the same way
    for (let i = 0; i < 3; i++) await repo.report(p.id, bob.id, { verdict: "dispute" }, later);
    expect((await repo.getPlace(p.id, later))!.disputes).toBe(1);
  });

  it("a dispute outweighs a confirm and sinks the pin", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const bob = await mkUser("b@x.com", "Bob");
    const p = await repo.createPlace({ kindId: "parking", lat: SF.lat, lng: SF.lng }, T0);
    await repo.report(p.id, ann.id, { verdict: "confirm" }, T0);
    await repo.report(p.id, bob.id, { verdict: "dispute", body: "gone" }, T0);
    const got = await repo.getPlace(p.id, T0);
    expect(got!.confirms).toBe(1);
    expect(got!.disputes).toBe(1);
    expect(got!.trust).toBeLessThan(0);
  });

  it("an 'update' merges coerced attrs into the pin — unknown keys never land", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const p = await repo.createPlace({ kindId: "parking", lat: SF.lat, lng: SF.lng, attrs: { type: "street" } }, T0);
    await repo.report(p.id, ann.id, { verdict: "update", attrs: { sweepWindow: "08:00-10:00", isAdmin: true } }, T0);
    const got = await repo.getPlace(p.id, T0);
    expect(got!.attrs).toEqual({ type: "street", sweepWindow: "08:00-10:00" });
  });

  it("keeps tips for the live difficulty signal, newest first", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const p = await repo.createPlace({ kindId: "parking", lat: SF.lat, lng: SF.lng }, T0);
    await repo.report(p.id, ann.id, { verdict: "tip", attrs: { difficulty: 4, minutesToFind: 11 } }, T0);
    await repo.report(p.id, ann.id, { verdict: "tip", attrs: { difficulty: 2 } }, "2026-07-26T19:00:00.000Z");
    const tips = await repo.tipsFor([p.id]);
    expect(tips.get(p.id)!.length).toBe(2);
    expect(tips.get(p.id)![0]!.attrs.difficulty).toBe(2); // newest first
    const recent = await repo.recentReports(p.id);
    expect(recent.length).toBe(2);
    expect(recent[0]!.author.handle).toBe(ann.handle);
  });

  it("refuses a report on a pin that doesn't exist", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    await expect(repo.report("nope", ann.id, { verdict: "confirm" }, T0)).rejects.toThrow();
  });
});

describe("PlacesRepo — import + moderation + points", () => {
  it("is idempotent on external_ref: a re-import updates in place, never duplicates", async () => {
    const items = [
      { externalRef: "datasf:meter:1", kindId: "parking", name: "1st St", lat: SF.lat, lng: SF.lng, attrs: { type: "street" } },
      { externalRef: "datasf:meter:2", kindId: "parking", name: "2nd St", lat: SF.lat + 0.001, lng: SF.lng },
    ];
    expect(await repo.importPlaces(items, T0)).toMatchObject({ inserted: 2, updated: 0, skipped: 0 });
    const again = await repo.importPlaces([{ ...items[0]!, name: "1st Street (renamed)" }, items[1]!], T0);
    expect(again).toMatchObject({ inserted: 0, updated: 2 });
    expect((raw.prepare("SELECT COUNT(*) n FROM places").get() as any).n).toBe(2);
    expect((raw.prepare("SELECT name FROM places WHERE external_ref='datasf:meter:1'").get() as any).name).toBe("1st Street (renamed)");
  });

  it("skips bad rows instead of aborting the whole import", async () => {
    const res = await repo.importPlaces(
      [
        { externalRef: "ok", kindId: "parking", lat: SF.lat, lng: SF.lng },
        { externalRef: "no-coords", kindId: "parking", lat: NaN, lng: SF.lng },
        { externalRef: "bad-kind", kindId: "wormhole", lat: SF.lat, lng: SF.lng },
        { externalRef: "", kindId: "parking", lat: SF.lat, lng: SF.lng },
      ],
      T0,
    );
    expect(res.inserted).toBe(1);
    expect(res.skipped).toBe(3);
    expect((raw.prepare("SELECT COUNT(*) n FROM places").get() as any).n).toBe(1);
  });

  it("imports hundreds of rows without breaching D1's parameter cap", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      externalRef: `datasf:meter:${i}`,
      kindId: "parking",
      lat: SF.lat + i * 0.0001,
      lng: SF.lng,
    }));
    expect(await repo.importPlaces(many, T0)).toMatchObject({ inserted: 250 });
  });

  it("flags a pin exactly once per person (the widened 0017 CHECK)", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const p = await repo.createPlace({ kindId: "parking", lat: SF.lat, lng: SF.lng }, T0);
    await repo.flag(p.id, ann.id, "spam", T0);
    await repo.flag(p.id, ann.id, "abuse", T0); // no-op, not an error
    const rows = raw.prepare("SELECT * FROM flags WHERE target_type='place'").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.target_id).toBe(p.id);
  });

  it("awards points for pinning and confirming, idempotently", async () => {
    const ann = await mkUser("a@x.com", "Ann");
    const bob = await mkUser("b@x.com", "Bob");
    const p = await repo.createPlace({ kindId: "parking", lat: SF.lat, lng: SF.lng, createdBy: ann.id }, T0);
    await repo.recordPlaceCreated(ann.id, p.id);
    await repo.recordPlaceCreated(ann.id, p.id); // replayed request
    await repo.recordPlaceConfirmed(bob.id, p.id);
    await repo.recordPlaceConfirmed(bob.id, p.id);
    const rows = raw.prepare("SELECT kind, SUM(points) pts, COUNT(*) n FROM points_ledger GROUP BY kind").all() as any[];
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, { pts: r.pts, n: r.n }]));
    expect(byKind.place).toEqual({ pts: 10, n: 1 });
    expect(byKind.place_confirm).toEqual({ pts: 3, n: 1 });
  });
});
