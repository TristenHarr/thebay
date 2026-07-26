import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { RankRepo } from "../src/storage/d1/rank-repo";
import { emptyFeatures } from "../src/core/rank/features";

let t: TestApp;
beforeEach(() => {
  // RANK_EPSILON 0: exploration is tested directly in rank-rerank.test.ts. Left on
  // here it would shuffle a two-item list one render in ten and make every ordering
  // assertion below flaky.
  t = makeTestApp({ INGEST_TOKEN: "secret", RANK_EPSILON: "0" });
});

const admin = { headers: { authorization: "Bearer secret" } };

interface EventOpts {
  startUtc?: string;
  interestScore?: number | null;
  organizer?: string | null;
  categories?: string[];
  isFree?: boolean | null;
}

function mkEvent(id: string, o: EventOpts = {}) {
  t.raw
    .prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash,
                           first_seen_at, last_seen_at, interest_score, organizer, categories, is_free)
       VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'SF', ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?, ?, ?, ?)`,
    )
    .run(
      id,
      `fp-${id}`,
      `Event ${id}`,
      o.startUtc ?? "2027-01-01T18:00:00Z",
      `https://x/${id}`,
      `ch-${id}`,
      o.interestScore ?? null,
      o.organizer ?? null,
      JSON.stringify(o.categories ?? []),
      o.isFree == null ? null : o.isFree ? 1 : 0,
    );
}

/** Drive the REAL Worker app against the SAME database the harness uses, so a test can
 *  compare the public catalog endpoint against the personalized one. */
async function hitWorker(path: string, cookie?: string) {
  const worker = (await import("../src/worker/index")).default;
  const res = await worker.fetch(
    new Request("https://thebay.events" + path, cookie ? { headers: { cookie } } : undefined),
    t.env as any,
    { waitUntil() {}, passThroughOnException() {} } as any,
  );
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

const impressions = () => t.raw.prepare("SELECT * FROM rank_impressions").all() as any[];

describe("GET /api/events/foryou", () => {
  it("serves the feed and logs REAL feature vectors, not placeholders", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    for (let i = 0; i < 3; i++) mkEvent(`e${i}`, { interestScore: 40 + i * 20, organizer: `Host ${i}` });

    const r = await call(t, "/api/events/foryou?limit=3", { cookie: ann.cookie });
    expect(r.status).toBe(200);
    expect(r.json.events).toHaveLength(3);

    const rows = impressions();
    expect(rows).toHaveLength(3);
    const f = JSON.parse(rows.find((x) => x.item_id === "e2")!.features_json);
    // The whole point: a vector that actually describes the candidate.
    expect(f.bias).toBe(1);
    expect(f.quality).toBeCloseTo(0.8, 6); // interest_score 80 → 0.8
    expect(f.recency).toBeGreaterThan(0); // the event is in the future
    expect(Object.values(f).some((v) => v !== 0 && v !== 1)).toBe(true);
  });

  it("reports which regime produced the ordering", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    mkEvent("e1");
    const r = await call(t, "/api/events/foryou", { cookie: ann.cookie });
    expect(r.json.ranking.model).toBeNull();
    expect(r.json.ranking.rescored).toBe(false); // no promoted model → the passthrough
    expect(r.json.ranking.pool).toBe(1);
  });

  it("serves a signed-out viewer but records nothing", async () => {
    mkEvent("e1");
    const r = await call(t, "/api/events/foryou");
    expect(r.status).toBe(200);
    expect(r.json.events).toHaveLength(1); // the feed still works, unpersonalized
    // Nothing logged: an anonymous impression can never become a positive, and its
    // exposure count would be shared with every other anonymous visitor.
    expect(impressions()).toHaveLength(0);
    expect(r.json.ranking.explored).toBe(false); // and it never explores
  });

  it("honours the same filter grammar as /api/events", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    mkEvent("free1", { isFree: true });
    mkEvent("paid1", { isFree: false });
    const r = await call(t, "/api/events/foryou?free=1", { cookie: ann.cookie });
    expect(r.json.events.map((e: any) => e.id)).toEqual(["free1"]);
  });

  it("stamps the live model's version on the impressions it logs", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    mkEvent("e1");
    await new RankRepo(t.d1).saveModel({
      surface: "events", weights: { quality: 1 }, rrf: {}, nRows: 900,
      holdoutAuc: 0.8, incumbentAuc: null, promote: true,
    });
    await call(t, "/api/events/foryou", { cookie: ann.cookie });
    expect(impressions()[0]!.model_version).toBe("v1");
  });

  it("a promoted model actually reorders the feed", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    // Chronologically e_early comes first; by quality it comes last.
    mkEvent("early", { interestScore: 5, startUtc: "2027-01-01T18:00:00Z" });
    mkEvent("later", { interestScore: 95, startUtc: "2027-06-01T18:00:00Z" });

    const before = await call(t, "/api/events/foryou", { cookie: ann.cookie });
    expect(before.json.events.map((e: any) => e.id)).toEqual(["early", "later"]);

    await new RankRepo(t.d1).saveModel({
      surface: "events", weights: { quality: 8 }, rrf: {}, nRows: 900,
      holdoutAuc: 0.9, incumbentAuc: null, promote: true,
    });
    const after = await call(t, "/api/events/foryou", { cookie: ann.cookie });
    expect(after.json.ranking.rescored).toBe(true);
    expect(after.json.events.map((e: any) => e.id)).toEqual(["later", "early"]);
  });

  it("personalizes on what the viewer actually engaged with", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    mkEvent("past-ai", { categories: ["ai"], startUtc: "2026-01-01T18:00:00Z" });
    mkEvent("ai-one", { categories: ["ai"], interestScore: 50 });
    mkEvent("other", { categories: ["cooking"], interestScore: 50 });
    // Ann has been to an AI event, so `ai` earns affinity.
    t.raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?,?,?,'qr')")
      .run(ann.user.id, "past-ai", "2026-01-01T19:00:00Z");

    await new RankRepo(t.d1).saveModel({
      surface: "events", weights: { tagAffinity: 8 }, rrf: {}, nRows: 900,
      holdoutAuc: 0.9, incumbentAuc: null, promote: true,
    });
    const r = await call(t, "/api/events/foryou", { cookie: ann.cookie });
    const order = r.json.events.map((e: any) => e.id);
    expect(order.indexOf("ai-one")).toBeLessThan(order.indexOf("other"));

    // And the logged vector records the affinity that did it.
    const f = JSON.parse(impressions().find((x) => x.item_id === "ai-one")!.features_json);
    expect(f.tagAffinity).toBeGreaterThan(0);
    const g = JSON.parse(impressions().find((x) => x.item_id === "other")!.features_json);
    expect(g.tagAffinity).toBe(0);
  });

  it("counts a friend's RSVP as social proof in the logged features", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");
    mkEvent("e1");
    const social = new (await import("../src/storage/d1/social-repo")).SocialRepo(t.d1);
    await social.requestFriend(ann.user.id, bob.user.id);
    await social.respondFriend(bob.user.id, ann.user.id, true);
    t.raw.prepare("INSERT INTO rsvps (user_id, event_id, status, created_at) VALUES (?,?,'going',?)")
      .run(bob.user.id, "e1", "2026-07-26T10:00:00Z");

    await call(t, "/api/events/foryou", { cookie: ann.cookie });
    const f = JSON.parse(impressions().find((x) => x.item_id === "e1")!.features_json);
    expect(f.friendEngaged).toBeGreaterThan(0);
    expect(f.socialProof).toBeGreaterThan(0);
  });

  it("does not log more than the top slots — a negative nobody could see is noise", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    for (let i = 0; i < 40; i++) mkEvent(`e${i}`);
    await call(t, "/api/events/foryou?limit=40", { cookie: ann.cookie });
    expect(impressions()).toHaveLength(20); // LOG_TOP
  });

  it("re-requesting the feed does not multiply training rows", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    mkEvent("e1");
    await call(t, "/api/events/foryou", { cookie: ann.cookie });
    await call(t, "/api/events/foryou", { cookie: ann.cookie });
    await call(t, "/api/events/foryou", { cookie: ann.cookie });
    const rows = impressions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.times_shown).toBe(3); // re-exposure is recorded, not duplicated
  });

  it("leaves the public /api/events ordering completely untouched", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    mkEvent("early", { interestScore: 5, startUtc: "2027-01-01T18:00:00Z" });
    mkEvent("later", { interestScore: 95, startUtc: "2027-06-01T18:00:00Z" });
    await new RankRepo(t.d1).saveModel({
      surface: "events", weights: { quality: 8 }, rrf: {}, nRows: 900,
      holdoutAuc: 0.9, incumbentAuc: null, promote: true,
    });
    // The personalized feed reorders...
    const foryou = await call(t, "/api/events/foryou", { cookie: ann.cookie });
    expect(foryou.json.events.map((e: any) => e.id)).toEqual(["later", "early"]);
    // ...the public catalog does not, and logs nothing.
    const before = impressions().length;
    const pub = await hitWorker("/api/events", ann.cookie);
    expect(pub.status).toBe(200);
    expect(pub.json.events.map((e: any) => e.id)).toEqual(["early", "later"]);
    expect(impressions()).toHaveLength(before);
  });
});

/**
 * `/api/search` is what the Discover screen actually calls, so it is where the loop has
 * to run for it to see real traffic. The rule it implements: a BROWSE personalizes and
 * learns; an explicit search or sort is answered verbatim.
 */
describe("POST /api/search — browse personalizes and learns", () => {
  const search = (body: Record<string, unknown>, cookie?: string) =>
    call(t, "/api/search", { method: "POST", body, ...(cookie ? { cookie } : {}) });

  it("a browse logs real feature vectors", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    mkEvent("a", { interestScore: 30 });
    mkEvent("b", { interestScore: 90 });

    const r = await search({ limit: 10 }, ann.cookie);
    expect(r.status).toBe(200);
    expect(r.json.ranking).not.toBeNull();
    expect(r.json.ranking.rescored).toBe(false); // no model yet

    const rows = impressions();
    expect(rows).toHaveLength(2);
    const f = JSON.parse(rows.find((x) => x.item_id === "b")!.features_json);
    expect(f.quality).toBeCloseTo(0.9, 6);
    expect(f.recency).toBeGreaterThan(0);
  });

  it("a TEXT search neither personalizes nor logs", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    mkEvent("a", { interestScore: 30 });
    // Someone who typed words wants those words answered, not their long-run taste —
    // and an intent-driven result set is a different distribution from a browse feed.
    const r = await search({ q: "hardware", limit: 10 }, ann.cookie);
    expect(r.status).toBe(200);
    expect(r.json.ranking).toBeNull();
    expect(impressions()).toHaveLength(0);
  });

  it("an explicit sort is answered verbatim, not re-ranked", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    mkEvent("a", { interestScore: 30 });
    for (const sort of ["soonest", "interesting"]) {
      const r = await search({ sort, limit: 10 }, ann.cookie);
      expect(r.json.ranking, sort).toBeNull();
    }
    expect(impressions()).toHaveLength(0);
  });

  it("page two is not re-ranked — the window page one used is already spent", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    for (let i = 0; i < 30; i++) mkEvent(`e${i}`);
    const r = await search({ limit: 10, offset: 10 }, ann.cookie);
    expect(r.json.ranking).toBeNull();
    expect(impressions()).toHaveLength(0);
  });

  it("respects the requested page size even though it ranks a wider window", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    for (let i = 0; i < 40; i++) mkEvent(`e${i}`);
    const r = await search({ limit: 10 }, ann.cookie);
    expect(r.json.events).toHaveLength(10);
    // The rescoring window is wider than the page — that is the point of it.
    expect(r.json.ranking.window).toBeGreaterThan(10);
  });

  it("a promoted model reorders the browse feed", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    mkEvent("dull", { interestScore: 5, startUtc: "2027-01-01T18:00:00Z" });
    mkEvent("great", { interestScore: 95, startUtc: "2027-06-01T18:00:00Z" });

    await new RankRepo(t.d1).saveModel({
      surface: "events", weights: { quality: 8 }, rrf: { bm25: 1, vector: 1, recency: 0.5, quality: 0.35 },
      nRows: 900, holdoutAuc: 0.9, incumbentAuc: null, promote: true,
    });
    const r = await search({ limit: 10 }, ann.cookie);
    expect(r.json.ranking.rescored).toBe(true);
    expect(r.json.ranking.model).toBe(1);
    expect(r.json.events.map((e: any) => e.id)).toEqual(["great", "dull"]);
    expect(impressions()[0]!.model_version).toBe("v1");
  });

  it("survives a corrupt stored fusion-weight blob", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    mkEvent("e1");
    await new RankRepo(t.d1).saveModel({
      surface: "events", weights: { quality: 1 }, rrf: {}, nRows: 900,
      holdoutAuc: 0.9, incumbentAuc: null, promote: true,
    });
    t.raw.prepare("UPDATE rank_models SET rrf_json = 'not json'").run();
    const r = await search({ limit: 10 }, ann.cookie);
    expect(r.status).toBe(200); // falls back to the hand-tuned DEFAULT_WEIGHTS
    expect(r.json.events).toHaveLength(1);
  });

  it("serves a signed-out browse but records nothing and never explores", async () => {
    mkEvent("e1", { interestScore: 60 });
    const r = await search({ limit: 10 });
    expect(r.status).toBe(200);
    expect(r.json.ranking).not.toBeNull(); // still reports the regime
    expect(r.json.ranking.explored).toBe(false);
    expect(impressions()).toHaveLength(0);
  });
});

describe("POST /api/rank/feedback", () => {
  it("requires auth", async () => {
    const r = await call(t, "/api/rank/feedback", {
      method: "POST",
      body: { surface: "events", itemId: "e1", kind: "open" },
    });
    expect(r.status).toBe(401);
  });

  it("applies an open to the impression it belongs to", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    mkEvent("e1");
    await call(t, "/api/events/foryou", { cookie: ann.cookie }); // serving logs the impression
    const r = await call(t, "/api/rank/feedback", {
      method: "POST", cookie: ann.cookie,
      body: { surface: "events", itemId: "e1", kind: "open" },
    });
    expect(r.status).toBe(200);
    expect(r.json.applied).toBe(true);
    expect(impressions()[0]!.label).toBe(1);
    expect(impressions()[0]!.label_kind).toBe("open");
  });

  it("reports honestly when there is no impression to attach to", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const r = await call(t, "/api/rank/feedback", {
      method: "POST", cookie: ann.cookie,
      body: { surface: "events", itemId: "never-shown", kind: "dismiss" },
    });
    expect(r.status).toBe(200);
    expect(r.json.applied).toBe(false); // not a silent 200 that implies it worked
  });

  it("rejects an unknown feedback kind", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const r = await call(t, "/api/rank/feedback", {
      method: "POST", cookie: ann.cookie,
      body: { surface: "events", itemId: "e1", kind: "love-it" },
    });
    expect(r.status).toBe(400);
  });

  it("cannot be used to label someone else's impression", async () => {
    const ann = await login(t, "ann@x.com", "Ann");
    const bob = await login(t, "bob@x.com", "Bob");
    mkEvent("e1");
    await call(t, "/api/events/foryou", { cookie: ann.cookie }); // ann's impression only
    const r = await call(t, "/api/rank/feedback", {
      method: "POST", cookie: bob.cookie,
      body: { surface: "events", itemId: "e1", kind: "open" },
    });
    expect(r.json.applied).toBe(false);
    expect(impressions()[0]!.label).toBeNull(); // ann's row is untouched
  });
});

describe("GET /api/rank/model", () => {
  it("reports the passthrough before anything has been learned", async () => {
    const r = await call(t, "/api/rank/model");
    expect(r.status).toBe(200);
    expect(r.json.events.live).toBeNull(); // null = ordering is the hand-tuned fusion
    expect(r.json.events.labelled).toEqual({ total: 0, positives: 0 });
    expect(Object.keys(r.json).sort()).toEqual(["events", "news", "shadows"]);
  });

  it("shows the live model, its score, and recent rejections", async () => {
    const repo = new RankRepo(t.d1);
    await repo.saveModel({
      surface: "events", weights: { quality: 0.7 }, rrf: { bm25: 1 }, nRows: 900,
      holdoutAuc: 0.81, incumbentAuc: null, promote: true,
    });
    await repo.saveModel({
      surface: "events", weights: { quality: 9 }, rrf: { bm25: 1 }, nRows: 950,
      holdoutAuc: 0.62, incumbentAuc: 0.81, promote: false, notes: "no gain",
    });

    const r = await call(t, "/api/rank/model?surface=events");
    expect(Object.keys(r.json)).toEqual(["events"]);
    expect(r.json.events.live.version).toBe(1);
    expect(r.json.events.live.weights).toEqual({ quality: 0.7 });
    expect(r.json.events.live.holdoutAuc).toBeCloseTo(0.81, 6);
    // The rejected candidate is visible, which is how a stalled loop gets noticed.
    expect(r.json.events.recent.map((m: any) => [m.version, m.promoted])).toEqual([[2, false], [1, true]]);
  });

  it("ignores a bogus surface and reports all of them", async () => {
    const r = await call(t, "/api/rank/model?surface=wat");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(["events", "news", "shadows"]);
  });
});

describe("admin: POST /api/admin/rank/train", () => {
  it("is bearer-gated", async () => {
    expect((await call(t, "/api/admin/rank/train", { method: "POST" })).status).toBe(401);
    expect(
      (await call(t, "/api/admin/rank/train", { method: "POST", headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
  });

  it("runs the same code path as the cron and reports per-surface results", async () => {
    const r = await call(t, "/api/admin/rank/train", { method: "POST", ...admin });
    expect(r.status).toBe(200);
    expect(r.json.results.map((x: any) => x.surface)).toEqual(["events", "news", "shadows"]);
    // With no data it declines, loudly enough to read in a log.
    expect(r.json.results[0]!.trained).toBe(false);
    expect(r.json.results[0]!.reason).toMatch(/waiting for data/);
  });

  it("can be pointed at a single surface", async () => {
    const r = await call(t, "/api/admin/rank/train?surface=news", { method: "POST", ...admin });
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0]!.surface).toBe("news");
  });
});

describe("admin: POST /api/admin/rank/gc", () => {
  it("is bearer-gated and enforces retention", async () => {
    expect((await call(t, "/api/admin/rank/gc", { method: "POST" })).status).toBe(401);

    const ann = await login(t, "ann@x.com", "Ann");
    mkEvent("e1");
    await new RankRepo(t.d1).logImpressions({
      surface: "events", viewerId: ann.user.id, modelVersion: "v0", explored: false,
      items: [{ itemId: "e1", position: 0, features: emptyFeatures() }],
      now: new Date(Date.now() - 90 * 86_400_000),
    });
    const r = await call(t, "/api/admin/rank/gc", { method: "POST", ...admin });
    expect(r.json.deleted).toBe(1);
    expect(impressions()).toHaveLength(0);
  });
});
