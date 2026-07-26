import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { RankRepo } from "../src/storage/d1/rank-repo";
import { rankTick } from "../src/core/rank/train";

/**
 * END-TO-END: does the loop actually learn?
 *
 * Everything else in the rank suite tests a piece. This tests the claim — that traffic
 * through the real HTTP feed produces training rows good enough to fit a model that beats
 * a coin flip and passes the promotion gate, with no hand-written feature vectors
 * anywhere. It is the test that would have caught the version of this feature that logged
 * placeholder vectors and therefore could never have learned anything.
 *
 * The fixture is deliberately honest about causation: every viewer's feed is served BEFORE
 * any RSVP exists, so engagement counts are zero for everyone at scoring time and
 * `quality` is the only feature that can possibly correlate with the label. If the model
 * comes out able to rank, it learned it from the log.
 */

let t: TestApp;
beforeEach(() => {
  // Exploration off: this file asserts on learned ORDER, and a shuffled head would
  // make the aggregate assertions noisy. `rank-rerank.test.ts` covers exploration.
  t = makeTestApp({ RANK_EPSILON: "0" });
});

const GOOD = 90;
const BAD = 10;

function mkEvent(id: string, interestScore: number) {
  t.raw
    .prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash,
                           first_seen_at, last_seen_at, interest_score, organizer, categories)
       VALUES (?, ?, ?, '2027-01-01T18:00:00Z', 'America/Los_Angeles', 'SF', ?, ?,
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?, ?, '[]')`,
    )
    .run(id, `fp-${id}`, `Event ${id}`, `https://x/${id}`, `ch-${id}`, interestScore, `Host ${id}`);
}

const impressions = () => t.raw.prepare("SELECT * FROM rank_impressions").all() as any[];

describe("the loop, end to end", () => {
  it("learns a real signal from real serving traffic and promotes a model", async () => {
    // 20 events, half genuinely interesting.
    const good: string[] = [];
    const bad: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `e${i}`;
      const isGood = i % 2 === 0;
      mkEvent(id, isGood ? GOOD : BAD);
      (isGood ? good : bad).push(id);
    }

    // 35 people load the feed. Each request logs up to LOG_TOP rows with the vectors the
    // server actually scored with.
    const cookies: Array<{ id: string; cookie: string }> = [];
    for (let u = 0; u < 35; u++) {
      const who = await login(t, `u${u}@x.com`, `U${u}`);
      cookies.push({ id: who.user.id, cookie: who.cookie });
      const r = await call(t, "/api/events/foryou?limit=20", { cookie: who.cookie });
      expect(r.status).toBe(200);
      expect(r.json.ranking.rescored).toBe(false); // still the passthrough at this point
    }

    const logged = impressions();
    expect(logged.length).toBeGreaterThan(600); // 35 viewers × 20 slots
    // Sanity: the vectors are real, not placeholders.
    const anyGood = JSON.parse(logged.find((r) => r.item_id === good[0])!.features_json);
    const anyBad = JSON.parse(logged.find((r) => r.item_id === bad[0])!.features_json);
    expect(anyGood.quality).toBeCloseTo(GOOD / 100, 6);
    expect(anyBad.quality).toBeCloseTo(BAD / 100, 6);

    // Now the behaviour: people RSVP to the interesting ones. Written AFTER every
    // impression, so the label is genuinely downstream of the serve.
    const rsvpAt = new Date(Date.now() + 60_000).toISOString();
    const ins = t.raw.prepare("INSERT OR IGNORE INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)");
    for (const { id } of cookies) for (const ev of good) ins.run(id, ev, rsvpAt);

    // Label + train, from the clock's point of view a day later so everything has settled.
    const repo = new RankRepo(t.d1);
    const later = new Date(Date.now() + 24 * 3600_000);
    const results = await rankTick(repo, ["events"], { now: later, sinceDays: 365 });
    const events = results[0]!;

    expect(events.trained).toBe(true);
    expect(events.rows).toBeGreaterThan(600);
    // It found the signal...
    expect(events.candidateAuc!).toBeGreaterThan(0.75);
    // ...and the gate let it through.
    expect(events.promoted).toBe(true);

    const live = await repo.activeModel("events");
    expect(live).not.toBeNull();
    // Higher quality → higher predicted engagement. That is the thing it was supposed
    // to learn, and nobody told it the sign.
    expect(live!.weights.quality!).toBeGreaterThan(0);

    // And the feed now says so, and orders by it.
    const after = await call(t, "/api/events/foryou?limit=20", { cookie: cookies[0]!.cookie });
    expect(after.json.ranking.rescored).toBe(true);
    expect(after.json.ranking.model).toBe(live!.version);
    const order: string[] = after.json.events.map((e: any) => e.id);
    // The good events should now dominate the head. (Exploration can perturb it, and host
    // diversity spreads it, so assert on the aggregate rather than an exact permutation.)
    const headGood = order.slice(0, 10).filter((id) => good.includes(id)).length;
    expect(headGood).toBeGreaterThanOrEqual(7);
  });

  it("learns through /api/search too — the endpoint the Discover screen actually calls", async () => {
    const good: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `s${i}`;
      const isGood = i % 2 === 0;
      mkEvent(id, isGood ? GOOD : BAD);
      if (isGood) good.push(id);
    }

    const users: Array<{ id: string; cookie: string }> = [];
    for (let u = 0; u < 35; u++) {
      const who = await login(t, `u${u}@x.com`, `U${u}`);
      users.push({ id: who.user.id, cookie: who.cookie });
      // A browse: no query, default sort, first page — exactly what the screen sends on load.
      const r = await call(t, "/api/search", { method: "POST", cookie: who.cookie, body: { limit: 20 } });
      expect(r.status).toBe(200);
      expect(r.json.ranking).not.toBeNull();
    }
    expect(impressions().length).toBeGreaterThan(600);

    const rsvpAt = new Date(Date.now() + 60_000).toISOString();
    const ins = t.raw.prepare("INSERT OR IGNORE INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)");
    for (const { id } of users) for (const ev of good) ins.run(id, ev, rsvpAt);

    const repo = new RankRepo(t.d1);
    const results = await rankTick(repo, ["events"], { now: new Date(Date.now() + 24 * 3600_000), sinceDays: 365 });
    expect(results[0]!.promoted).toBe(true);
    expect(results[0]!.candidateAuc!).toBeGreaterThan(0.75);

    // And the screen's own request now comes back personalized.
    const after = await call(t, "/api/search", { method: "POST", cookie: users[0]!.cookie, body: { limit: 20 } });
    expect(after.json.ranking.rescored).toBe(true);
    const head: string[] = after.json.events.slice(0, 10).map((e: any) => e.id);
    expect(head.filter((id) => good.includes(id)).length).toBeGreaterThanOrEqual(7);
  });

  it("labels an un-engaged impression as a real negative once it settles", async () => {
    mkEvent("ignored", BAD);
    const ann = await login(t, "ann@x.com", "Ann");
    await call(t, "/api/events/foryou", { cookie: ann.cookie });

    const repo = new RankRepo(t.d1);
    // Too soon: the viewer has not had a chance to act.
    await repo.labelPending("events", 100, new Date());
    expect(impressions()[0]!.label).toBeNull();

    // A day later it is genuine evidence of disinterest.
    await repo.labelPending("events", 100, new Date(Date.now() + 24 * 3600_000));
    const row = impressions()[0]!;
    expect(row.label).toBe(0);
    expect(row.label_kind).toBe("none");
  });

  it("a click-through is captured as a positive the server could not have seen", async () => {
    mkEvent("clicked", BAD);
    const ann = await login(t, "ann@x.com", "Ann");
    await call(t, "/api/events/foryou", { cookie: ann.cookie });

    // What the web app's Feed does when the title link is opened.
    const r = await call(t, "/api/rank/feedback", {
      method: "POST",
      cookie: ann.cookie,
      body: { surface: "events", itemId: "clicked", kind: "open" },
    });
    expect(r.json.applied).toBe(true);

    const rows = await new RankRepo(t.d1).trainingRows("events", { sinceDays: 365 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe(1);
    expect(rows[0]!.labelKind).toBe("open");
    // And it is weighted as the weak signal it is, not as an attendance.
    expect(rows[0]!.features.quality).toBeCloseTo(BAD / 100, 6);
  });

  it("stays a passthrough for as long as the data is thin — no accidental reordering", async () => {
    for (let i = 0; i < 5; i++) mkEvent(`e${i}`, i * 20);
    const ann = await login(t, "ann@x.com", "Ann");
    const before = await call(t, "/api/events/foryou", { cookie: ann.cookie });

    const repo = new RankRepo(t.d1);
    await rankTick(repo, ["events"], { now: new Date(Date.now() + 24 * 3600_000), sinceDays: 365 });

    const after = await call(t, "/api/events/foryou", { cookie: ann.cookie });
    expect(after.json.ranking.rescored).toBe(false);
    expect(after.json.events.map((e: any) => e.id)).toEqual(before.json.events.map((e: any) => e.id));
    expect(t.raw.prepare("SELECT COUNT(*) n FROM rank_models").get()).toEqual({ n: 0 });
  });
});
