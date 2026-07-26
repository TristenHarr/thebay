import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/d1";
import { VibeRepo } from "../src/storage/d1/vibe-repo";
import { baselinePredict, VIBE_AXES, type VibeAxes } from "../src/core/vibe";

/* eslint-disable @typescript-eslint/no-explicit-any */
let d1: any;
let raw: import("better-sqlite3").Database;
let repo: VibeRepo;

const flat = (n: number): VibeAxes => Object.fromEntries(VIBE_AXES.map((a) => [a, n])) as VibeAxes;

function addUser(id: string) {
  raw.prepare(
    `INSERT INTO users (id, email, handle, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01')`,
  ).run(id, `${id}@x.com`, id, id);
}
function addEvent(id: string, over: Partial<{ title: string; host: string | null; organizer: string | null; description: string }> = {}) {
  raw.prepare(
    `INSERT INTO events (id, fingerprint, title, description, start_utc, timezone, city, url, organizer, host_user_id, content_hash, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, '2026-06-01T18:00:00Z', 'America/Los_Angeles', 'san-francisco', 'https://x', ?, ?, ?, '2026-01-01', '2026-01-01')`,
  ).run(id, "fp-" + id, over.title ?? "Event " + id, over.description ?? null, over.organizer ?? null, over.host ?? null, "ch-" + id);
}
function checkIn(userId: string, eventId: string) {
  raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?, ?, '2026-06-01T20:00:00Z', 'qr')").run(userId, eventId);
}

beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  repo = new VibeRepo(d1);
  addEvent("e1");
});

describe("schema invariants (bad states are unrepresentable)", () => {
  it("rejects an axis outside 0..100 on event_vibes", () => {
    const ins = (energy: number) =>
      raw.prepare("INSERT INTO event_vibes (event_id, energy, source, updated_at) VALUES ('e1', ?, 'predicted', '2026-01-01')").run(energy);
    expect(() => ins(101)).toThrow(/CHECK/i);
    expect(() => ins(-1)).toThrow(/CHECK/i);
  });

  it("rejects an axis outside 0..100 on vibe_reports", () => {
    addUser("u1");
    expect(() =>
      raw.prepare("INSERT INTO vibe_reports (event_id, user_id, talk_ratio, created_at) VALUES ('e1','u1', ?, '2026-01-01')").run(140),
    ).toThrow(/CHECK/i);
  });

  it("rejects an unknown source", () => {
    expect(() =>
      raw.prepare("INSERT INTO event_vibes (event_id, source, updated_at) VALUES ('e1', 'vibes-i-made-up', '2026-01-01')").run(),
    ).toThrow(/CHECK/i);
  });

  it("rejects worth_it outside 1..5 and confidence outside 0..1", () => {
    addUser("u1");
    expect(() =>
      raw.prepare("INSERT INTO vibe_reports (event_id, user_id, worth_it, created_at) VALUES ('e1','u1', 9, '2026-01-01')").run(),
    ).toThrow(/CHECK/i);
    expect(() =>
      raw.prepare("INSERT INTO event_vibes (event_id, source, confidence, updated_at) VALUES ('e1','predicted', 2.0, '2026-01-01')").run(),
    ).toThrow(/CHECK/i);
  });

  it("makes a second report from the same person a conflict, not a second vote", () => {
    addUser("u1");
    const ins = () => raw.prepare("INSERT INTO vibe_reports (event_id, user_id, energy, created_at) VALUES ('e1','u1', 50, '2026-01-01')").run();
    ins();
    expect(ins).toThrow(/UNIQUE|PRIMARY/i);
  });

  it("cascades: deleting the event removes its vibe and its reports", () => {
    addUser("u1");
    raw.prepare("INSERT INTO event_vibes (event_id, source, updated_at) VALUES ('e1','predicted','2026-01-01')").run();
    raw.prepare("INSERT INTO vibe_reports (event_id, user_id, energy, created_at) VALUES ('e1','u1', 50, '2026-01-01')").run();
    raw.prepare("DELETE FROM events WHERE id = 'e1'").run();
    expect(raw.prepare("SELECT COUNT(*) AS n FROM event_vibes").get()).toEqual({ n: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM vibe_reports").get()).toEqual({ n: 0 });
  });
});

describe("VibeRepo — prediction round-trip", () => {
  it("stores a prediction and reads back a card marked 'predicted' with 0 reports", async () => {
    const pred = baselinePredict({ title: "Founders Happy Hour" });
    await repo.savePrediction("e1", pred, { headline: "Loud, hoodie-dense, easy to meet people.", blurb: "A blurb." }, null);
    const card = await repo.get("e1");
    expect(card).toBeTruthy();
    expect(card!.source).toBe("predicted");
    expect(card!.nReports).toBe(0);
    expect(card!.axes).toEqual(pred.axes);
    expect(card!.headline).toBe("Loud, hoodie-dense, easy to meet people.");
    expect(card!.bestFor).toEqual(pred.bestFor);
    expect(Object.keys(card!.crowd).length).toBeGreaterThan(0);
    expect(card!.confidence).toBeCloseTo(0.3, 5);
  });

  it("keeps the immutable prior so a re-blend never folds its own output back in", async () => {
    const pred = baselinePredict({ title: "Founders Happy Hour" });
    await repo.savePrediction("e1", pred, { headline: "h", blurb: "b" }, null);
    addUser("u1"); checkIn("u1", "e1");
    await repo.addReport("e1", "u1", { ...flat(0) });
    const once = (await repo.get("e1"))!.axes;
    await repo.recompute("e1");
    await repo.recompute("e1");
    expect((await repo.get("e1"))!.axes).toEqual(once); // idempotent
  });

  it("returns null for an event with no vibe yet", async () => {
    expect(await repo.get("e1")).toBeNull();
  });
});

describe("VibeRepo — reports", () => {
  beforeEach(async () => {
    await repo.savePrediction("e1", baselinePredict({ title: "Founders Happy Hour" }), { headline: "h", blurb: "b" }, null);
  });

  it("marks a report VERIFIED only when the reporter has a check-in for that event", async () => {
    addUser("checked"); addUser("nope");
    checkIn("checked", "e1");
    expect((await repo.addReport("e1", "checked", flat(90))).verified).toBe(true);
    expect((await repo.addReport("e1", "nope", flat(10))).verified).toBe(false);
  });

  it("never lets the client claim verification", async () => {
    addUser("liar");
    await repo.addReport("e1", "liar", { ...flat(90), verified: true } as any);
    const row: any = raw.prepare("SELECT verified FROM vibe_reports WHERE user_id = 'liar'").get();
    expect(row.verified).toBe(0);
  });

  it("re-submitting REPLACES your report instead of adding a second vote", async () => {
    addUser("u1"); checkIn("u1", "e1");
    await repo.addReport("e1", "u1", flat(90));
    await repo.addReport("e1", "u1", flat(10));
    const rows = raw.prepare("SELECT energy FROM vibe_reports WHERE event_id='e1'").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].energy).toBe(10);
    expect((await repo.get("e1"))!.nReports).toBe(1);
  });

  it("an unverified report is stored but never moves the card", async () => {
    const before = await repo.get("e1");
    addUser("tourist");
    await repo.addReport("e1", "tourist", flat(0));
    const after = await repo.get("e1");
    expect(after!.axes).toEqual(before!.axes);
    expect(after!.source).toBe("predicted");
    expect(after!.nReports).toBe(0);
  });

  it("verified reports move the card and raise confidence", async () => {
    const before = await repo.get("e1");
    for (const u of ["a", "b", "c"]) { addUser(u); checkIn(u, "e1"); await repo.addReport("e1", u, flat(100)); }
    const after = await repo.get("e1");
    expect(after!.source).toBe("blended");
    expect(after!.nReports).toBe(3);
    expect(after!.axes.energy).toBeGreaterThan(before!.axes.energy);
    expect(after!.confidence).toBeGreaterThan(before!.confidence);
  });

  it("stores crowd, tags and worth-it alongside the sliders", async () => {
    addUser("u1"); checkIn("u1", "e1");
    await repo.addReport("e1", "u1", { ...flat(60), crowd: { founders: 80, recruiters: 20 }, tags: ["free food"], worthIt: 4 });
    const rows = await repo.reportsFor("e1");
    expect(rows[0]!.crowd).toEqual({ founders: 80, recruiters: 20 });
    expect(rows[0]!.tags).toEqual(["free food"]);
    expect(rows[0]!.worthIt).toBe(4);
  });
});

describe("VibeRepo — host carry-over (caliber is earned, never guessed)", () => {
  /** Fill a room with `n` check-in-verified reports all reading `value`. */
  async function reportRoom(ev: string, value: number, n = 5) {
    await repo.savePrediction(ev, baselinePredict({ title: "Room" }), { headline: "h", blurb: "b" }, null);
    for (let i = 0; i < n; i++) {
      const u = `${ev}-u${i}`;
      addUser(u); checkIn(u, ev);
      await repo.addReport(ev, u, flat(value));
    }
  }

  it("ignores a host with fewer than three reported rooms", async () => {
    for (const ev of ["h1", "h2"]) { addEvent(ev, { organizer: "Acme Ventures" }); await reportRoom(ev, 100); }
    addEvent("target", { organizer: "Acme Ventures" });
    expect(await repo.hostPrior("target")).toBeNull();
  });

  it("earns a prior once three rooms have been reported, keyed on the organizer", async () => {
    for (const ev of ["h1", "h2", "h3"]) { addEvent(ev, { organizer: "Acme Ventures" }); await reportRoom(ev, 100); }
    addEvent("target", { organizer: "acme ventures  " }); // case/space-insensitive key
    const prior = await repo.hostPrior("target");
    expect(prior).toBeTruthy();
    expect(prior!.events).toBe(3);
    expect(prior!.axes.energy).toBeGreaterThan(80);
  });

  it("prefers the platform host_user_id when the event is user-hosted", async () => {
    addUser("host");
    for (const ev of ["p1", "p2", "p3"]) { addEvent(ev, { host: "host", organizer: null }); await reportRoom(ev, 20); }
    addEvent("ptarget", { host: "host", organizer: null });
    const prior = await repo.hostPrior("ptarget");
    expect(prior!.events).toBe(3);
    expect(prior!.axes.energy).toBeLessThan(40);
  });

  it("only counts rooms that were actually REPORTED, not merely predicted", async () => {
    for (const ev of ["q1", "q2", "q3"]) {
      addEvent(ev, { organizer: "Predicted Only LLC" });
      await repo.savePrediction(ev, baselinePredict({ title: "Room" }), { headline: "h", blurb: "b" }, null);
    }
    addEvent("qtarget", { organizer: "Predicted Only LLC" });
    expect(await repo.hostPrior("qtarget")).toBeNull();
  });

  it("feeds the carry-over into a fresh room's card", async () => {
    for (const ev of ["r1", "r2", "r3"]) { addEvent(ev, { organizer: "Signal Labs" }); await reportRoom(ev, 100); }
    addEvent("fresh", { organizer: "Signal Labs", title: "Founders Happy Hour" });
    const pred = baselinePredict({ title: "Founders Happy Hour" });
    await repo.savePrediction("fresh", pred, { headline: "h", blurb: "b" }, null);
    const card = (await repo.get("fresh"))!;
    expect(card.source).toBe("predicted"); // nobody reported THIS room
    expect(card.axes.formality).toBeGreaterThan(pred.axes.formality); // pulled toward the host's 100s
  });
});

describe("VibeRepo — bulk reads and filters (what Track A's search consumes)", () => {
  it("reads many cards in one call, chunked under D1's 100-parameter cap", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) {
      const id = "bulk" + i;
      addEvent(id);
      await repo.savePrediction(id, baselinePredict({ title: "Founders Dinner" }), { headline: "h", blurb: "b" }, null);
      ids.push(id);
    }
    const map = await repo.getMany(ids); // would throw D1_ERROR if unchunked
    expect(map.size).toBe(120);
  });

  it("filters by axis range and by best-for tag", async () => {
    addEvent("calm"); addEvent("loud");
    await repo.savePrediction("calm", baselinePredict({ title: "Founders Dinner" }), { headline: "h", blurb: "b" }, null);
    await repo.savePrediction("loud", baselinePredict({ title: "Launch Party" }), { headline: "h", blurb: "b" }, null);

    const energetic = await repo.search({ min: { energy: 80 }, limit: 50 });
    expect(energetic.map((v) => v.eventId)).toContain("loud");
    expect(energetic.map((v) => v.eventId)).not.toContain("calm");

    const quiet = await repo.search({ max: { energy: 60 }, limit: 50 });
    expect(quiet.map((v) => v.eventId)).toContain("calm");

    const cofounder = await repo.search({ bestFor: ["real conversations"], limit: 50 });
    expect(cofounder.map((v) => v.eventId)).toContain("calm");
    expect(cofounder.map((v) => v.eventId)).not.toContain("loud");
  });

  it("caps the filter fan-out well under D1's parameter limit", async () => {
    const many = Array.from({ length: 300 }, (_, i) => "tag" + i);
    await expect(repo.search({ bestFor: many, limit: 50 })).resolves.toBeInstanceOf(Array);
  });
});

describe("VibeRepo — the collection prompt", () => {
  it("lists rooms you checked into but have not vibed yet, and drops them once reported", async () => {
    addUser("u1");
    addEvent("e2");
    checkIn("u1", "e1");
    checkIn("u1", "e2");
    expect((await repo.pendingPrompts("u1")).map((p) => p.eventId).sort()).toEqual(["e1", "e2"]);
    await repo.addReport("e1", "u1", flat(50));
    expect((await repo.pendingPrompts("u1")).map((p) => p.eventId)).toEqual(["e2"]);
  });

  it("never prompts someone who never showed up", async () => {
    addUser("ghost");
    expect(await repo.pendingPrompts("ghost")).toEqual([]);
  });
});

describe("VibeRepo — event facts", () => {
  it("reads the structured facts a prediction is allowed to see", async () => {
    addEvent("facty", { title: "Hardware Hack Night", organizer: "Acme" });
    const facts = await repo.eventFacts("facty");
    expect(facts).toMatchObject({ title: "Hardware Hack Night", organizer: "Acme", city: "san-francisco" });
    expect(await repo.eventFacts("no-such-event")).toBeNull();
  });
});
