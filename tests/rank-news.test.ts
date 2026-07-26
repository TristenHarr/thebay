import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { makeTestEnv } from "./helpers/app";
import newsWorker from "../src/worker/news";
import { NewsRepo } from "../src/storage/d1/news-repo";
import { RankRepo } from "../src/storage/d1/rank-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { storyToRankItem } from "../src/core/rank/rerank";
import { ANON_VIEWER } from "../src/core/rank/features";
import { rankTick } from "../src/core/rank/train";

/**
 * The news surface of the learning loop.
 *
 * The interesting constraint here is that news already HAS an editorial policy
 * (`src/news/curate.ts`: per-source quotas, cluster dedup, submissions lead). The learned
 * model has to make the front page more relevant without dismantling that — so most of
 * these tests are about what personalization is NOT allowed to do.
 */

let d1: any, raw: Database.Database, news: NewsRepo, rank: RankRepo, social: SocialRepo;
beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  news = new NewsRepo(d1);
  rank = new RankRepo(d1);
  social = new SocialRepo(d1);
});

const mkUser = async (email: string) =>
  (await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: email })).id;

const NOW = Date.parse("2026-07-26T12:00:00Z");
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();

function mkStory(
  id: string,
  o: { origin?: string; topics?: string[]; votes?: number; comments?: number; hoursAgo?: number; authorId?: string | null } = {},
) {
  raw
    .prepare(
      `INSERT INTO stories (id, kind, title, url, origin, topics_json, vote_count, comment_count,
                            created_at, first_seen_at, author_id)
       VALUES (?, 'link', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      `Story ${id}`,
      `https://example.com/${id}`,
      o.origin ?? "hn",
      JSON.stringify(o.topics ?? []),
      o.votes ?? 0,
      o.comments ?? 0,
      ago(o.hoursAgo ?? 1),
      ago(o.hoursAgo ?? 1),
      o.authorId ?? null,
    );
}

const feedOpts = { src: "all" as const, sort: "hot" as const, limit: 20, offset: 0 };
const impressions = () => raw.prepare("SELECT * FROM rank_impressions").all() as any[];

/* ── the adapter ─────────────────────────────────────────────────────────────── */

describe("storyToRankItem", () => {
  it("maps a story onto the shared feature inputs", () => {
    const item = storyToRankItem(
      { id: "s1", origin: "Lobsters", topics: ["Hardware", "AI"], voteCount: 4, commentCount: 3, externalPoints: 100, createdAt: ago(2) },
      { networkVotes: 2 },
    );
    expect(item.id).toBe("s1");
    expect(item.tags).toEqual(["hardware", "ai"]); // lowercased to match the affinity map
    expect(item.authorKey).toBe("lobsters"); // the SOURCE is the author-ish key for news
    expect(item.engagements).toBe(7); // votes + comments pool into social proof
    expect(item.friendEngagements).toBe(2);
    expect(item.externalPoints).toBe(100);
  });

  it("leaves quality null — externalPoints is its own feature, not a proxy for it", () => {
    expect(storyToRankItem({ id: "s1", createdAt: ago(1), externalPoints: 400 }).quality).toBeNull();
  });

  it("judges a lagging origin by when it reached us", () => {
    // An SEC filing dated three weeks ago that arrived an hour ago is news now. Scoring
    // it by created_at makes it arrive already dead.
    const item = storyToRankItem(
      { id: "s1", origin: "sec", createdAt: ago(24 * 21), firstSeenAt: ago(1) },
      { freshnessAt: ago(1) },
    );
    expect(item.at).toBe(ago(1));
  });

  it("survives a story with nothing on it", () => {
    const item = storyToRankItem({ id: "s1", createdAt: "garbage" });
    expect(item.tags).toEqual([]);
    expect(item.engagements).toBe(0);
    expect(item.authorKey).toBeNull();
  });
});

/* ── the feed hook ───────────────────────────────────────────────────────────── */

describe("NewsRepo.feed: personalization is opt-in and reports itself", () => {
  it("without a personalize argument, behaves exactly as before", async () => {
    mkStory("a", { hoursAgo: 1 });
    mkStory("b", { hoursAgo: 5 });
    const r = await news.feed(feedOpts, null, NOW);
    expect(r.ranking).toBeUndefined();
    expect(r.features).toBeUndefined();
    expect(r.stories.map((s) => s.id)).toEqual(["a", "b"]); // fresher first, as hotScore says
  });

  it("with no promoted model it computes features but does not reorder", async () => {
    // Same vote count, so hotScore's ordering is decided purely by age — otherwise a
    // 50-vote older story legitimately outranks a fresh unvoted one and the assertion
    // below would be testing the fixture rather than the passthrough.
    mkStory("fresh", { hoursAgo: 1 });
    mkStory("stale", { hoursAgo: 100 });
    const r = await news.feed(feedOpts, null, NOW, { viewer: ANON_VIEWER, weights: null });
    expect(r.ranking!.rescored).toBe(false);
    expect(r.stories.map((s) => s.id)).toEqual(["fresh", "stale"]);
    // Features are still produced — they are the training data, and without them no
    // model could ever come to exist.
    expect(r.features!.size).toBe(2);
    expect(r.features!.get("fresh")!.recency).toBeGreaterThan(r.features!.get("stale")!.recency);
  });

  it("a promoted model reorders the front page", async () => {
    mkStory("quiet", { hoursAgo: 1, votes: 0 });
    mkStory("loud", { hoursAgo: 30, votes: 40, comments: 20 });
    const r = await news.feed(feedOpts, null, NOW, { viewer: ANON_VIEWER, weights: { socialProof: 9 } });
    expect(r.ranking!.rescored).toBe(true);
    expect(r.stories.map((s) => s.id)).toEqual(["loud", "quiet"]);
  });

  it("uses topic affinity, so two readers get different front pages", async () => {
    mkStory("hw", { topics: ["hardware"], hoursAgo: 2 });
    mkStory("cook", { topics: ["cooking"], hoursAgo: 1 });
    const weights = { tagAffinity: 9 };

    const hwReader = await news.feed(feedOpts, null, NOW, {
      viewer: { tagAffinity: new Map([["hardware", 1]]), authorAffinity: new Map(), checkins: 0 },
      weights,
    });
    const cookReader = await news.feed(feedOpts, null, NOW, {
      viewer: { tagAffinity: new Map([["cooking", 1]]), authorAffinity: new Map(), checkins: 0 },
      weights,
    });
    expect(hwReader.stories[0]!.id).toBe("hw");
    expect(cookReader.stories[0]!.id).toBe("cook");
  });

  it("uses source affinity — 'reads a lot of Lobsters' is a real preference", async () => {
    mkStory("l1", { origin: "lobsters", hoursAgo: 3 });
    mkStory("h1", { origin: "hn", hoursAgo: 1 });
    const r = await news.feed(feedOpts, null, NOW, {
      viewer: { tagAffinity: new Map(), authorAffinity: new Map([["lobsters", 1]]), checkins: 0 },
      weights: { authorAffinity: 9 },
    });
    expect(r.stories[0]!.id).toBe("l1");
  });

  it("demotes stories this reader has already been shown", async () => {
    mkStory("seen", { hoursAgo: 1, votes: 20 });
    mkStory("fresh", { hoursAgo: 2, votes: 20 });
    const r = await news.feed(feedOpts, null, NOW, {
      viewer: ANON_VIEWER,
      weights: { socialProof: 5, recency: 1 },
      timesShownFor: async () => new Map([["seen", 6]]),
    });
    expect(r.stories[0]!.id).toBe("fresh");
  });

  it("leaves the non-hot sorts entirely alone", async () => {
    mkStory("a", { hoursAgo: 1, votes: 1 });
    mkStory("b", { hoursAgo: 5, votes: 99 });
    for (const sort of ["new", "top", "discussed"] as const) {
      const r = await news.feed({ ...feedOpts, sort }, null, NOW, {
        viewer: ANON_VIEWER,
        weights: { socialProof: 9 },
      });
      expect(r.ranking, sort).toBeUndefined(); // explicit instruction, answered verbatim
      expect(r.features, sort).toBeUndefined();
    }
  });
});

describe("NewsRepo.feed: personalization must not dismantle the editorial policy", () => {
  it("per-source quotas still guarantee a mix to a reader with one favourite source", async () => {
    // A dozen RSS stories and three SEC filings. The reader loves RSS. They must still
    // not get a page of pure RSS — that is exactly what curate.ts exists to prevent.
    // (RSS and SEC because `QUALITY_BAR` gates hn/lobsters on `externalPoints`, which
    // comes from `story_sources`; these two have a bar of 0, so the quota is what's
    // under test rather than the quality bar.)
    for (let i = 0; i < 12; i++) mkStory(`rss${i}`, { origin: "rss", hoursAgo: 1 + i * 0.1, votes: 100 });
    for (let i = 0; i < 3; i++) mkStory(`sec${i}`, { origin: "sec", hoursAgo: 4 + i, votes: 0 });

    const r = await news.feed({ src: "bay", sort: "hot", limit: 10, offset: 0 }, null, NOW, {
      viewer: { tagAffinity: new Map(), authorAffinity: new Map([["rss", 1]]), checkins: 0 },
      weights: { authorAffinity: 9 },
    });
    const origins = r.stories.map((s) => s.origin);
    expect(origins).toContain("sec"); // the mix survived a maximally biased reader
    expect(origins.filter((o) => o === "rss").length).toBeLessThan(origins.length);
  });

  it("human submissions still lead, whatever the model thinks", async () => {
    mkStory("sub", { origin: "bay", hoursAgo: 20, votes: 0 });
    for (let i = 0; i < 5; i++) mkStory(`hn${i}`, { origin: "hn", hoursAgo: 1, votes: 500 });
    const r = await news.feed({ src: "bay", sort: "hot", limit: 6, offset: 0 }, null, NOW, {
      viewer: ANON_VIEWER,
      weights: { socialProof: 9, externalPoints: 9 },
    });
    // Submissions are uncapped and never displaced — the site's whole point.
    expect(r.stories[0]!.origin).toBe("bay");
  });
});

/* ── the loop, end to end on news ────────────────────────────────────────────── */

describe("the news loop learns", () => {
  it("labels a vote as a positive and an ignored story as a negative", async () => {
    const ann = await mkUser("a@x.com");
    mkStory("voted", { hoursAgo: 1 });
    mkStory("ignored", { hoursAgo: 1 });
    await rank.logImpressions({
      surface: "news",
      viewerId: ann,
      modelVersion: "v0",
      explored: false,
      items: [
        { itemId: "voted", position: 0, features: { ...emptyish(), socialProof: 0.9 } },
        { itemId: "ignored", position: 1, features: emptyish() },
      ],
      now: new Date(NOW),
    });
    raw.prepare("INSERT INTO story_votes (story_id, user_id, created_at) VALUES ('voted',?,?)")
      .run(ann, new Date(NOW + 60_000).toISOString());

    await rank.labelPending("news", 100, new Date(NOW + 24 * 3600_000));
    const byId = new Map(impressions().map((r) => [r.item_id, r]));
    expect(byId.get("voted")!.label).toBe(1);
    expect(byId.get("voted")!.label_kind).toBe("vote");
    expect(byId.get("ignored")!.label).toBe(0);
    expect(byId.get("ignored")!.label_kind).toBe("none");
  });

  it("a comment outranks a vote on the ladder", async () => {
    const ann = await mkUser("a@x.com");
    mkStory("s1", { hoursAgo: 1 });
    await rank.logImpressions({
      surface: "news", viewerId: ann, modelVersion: "v0", explored: false,
      items: [{ itemId: "s1", position: 0, features: emptyish() }],
      now: new Date(NOW),
    });
    raw.prepare("INSERT INTO story_votes (story_id, user_id, created_at) VALUES ('s1',?,?)")
      .run(ann, new Date(NOW + 60_000).toISOString());
    await rank.labelPending("news", 100, new Date(NOW + 24 * 3600_000));
    expect(impressions()[0]!.label_kind).toBe("vote");

    raw.prepare("INSERT INTO comments (id, story_id, author_id, body, created_at) VALUES ('c1','s1',?,'hi',?)")
      .run(ann, new Date(NOW + 120_000).toISOString());
    await rank.labelPending("news", 100, new Date(NOW + 25 * 3600_000));
    expect(impressions()[0]!.label_kind).toBe("comment");
  });

  it("trains a news model from front-page traffic and promotes it", async () => {
    // 20 stories, half of them on a topic the readers actually vote for.
    const good: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `s${i}`;
      const isGood = i % 2 === 0;
      mkStory(id, { hoursAgo: 1 + i * 0.05, votes: isGood ? 40 : 0, topics: isGood ? ["hardware"] : ["cooking"] });
      if (isGood) good.push(id);
    }

    const users: string[] = [];
    for (let u = 0; u < 35; u++) {
      const uid = await mkUser(`u${u}@x.com`);
      users.push(uid);
      const r = await news.feed(feedOpts, uid, NOW, {
        viewer: await rank.viewerContext(uid),
        weights: null,
        timesShownFor: (ids) => rank.timesShown("news", uid, ids),
      });
      await rank.logImpressions({
        surface: "news",
        viewerId: uid,
        modelVersion: "v0",
        explored: false,
        items: r.stories.slice(0, 20).map((s, i) => ({ itemId: s.id, position: i, features: r.features!.get(s.id)! })),
        now: new Date(NOW),
      });
    }
    expect(impressions().length).toBeGreaterThan(600);

    // Readers vote for the good ones, after the impressions were recorded.
    const vote = raw.prepare("INSERT OR IGNORE INTO story_votes (story_id, user_id, created_at) VALUES (?,?,?)");
    for (const uid of users) for (const id of good) vote.run(id, uid, new Date(NOW + 60_000).toISOString());

    const results = await rankTick(rank, ["news"], { now: new Date(NOW + 24 * 3600_000), sinceDays: 365 });
    const r = results[0]!;
    expect(r.trained).toBe(true);
    expect(r.candidateAuc!).toBeGreaterThan(0.7);
    expect(r.promoted).toBe(true);

    const live = await rank.activeModel("news");
    expect(live).not.toBeNull();
    // The events model must be untouched — surfaces train independently, because an
    // event feed and a news front page have genuinely different engagement economics.
    expect(await rank.activeModel("events")).toBeNull();
  });

  it("cross-surface affinity: attending hardware events primes the news front page", async () => {
    // The monorepo's actual advantage. A brand-new reader who has never voted on
    // anything still gets a relevant front page, because they have been to events.
    const ann = await mkUser("a@x.com");
    raw
      .prepare(
        `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash,
                             first_seen_at, last_seen_at, categories)
         VALUES ('e1','fp1','Hardware night','2026-01-01T18:00:00Z','America/Los_Angeles','SF',
                 'https://x/1','ch1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','["hardware"]')`,
      )
      .run();
    raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?, 'e1', ?, 'qr')")
      .run(ann, "2026-01-01T19:00:00Z");

    const ctx = await rank.viewerContext(ann);
    expect(ctx.tagAffinity.get("hardware")!).toBeGreaterThan(0);

    mkStory("hw", { topics: ["hardware"], hoursAgo: 3 });
    mkStory("other", { topics: ["cooking"], hoursAgo: 1 });
    const r = await news.feed(feedOpts, ann, NOW, { viewer: ctx, weights: { tagAffinity: 9 } });
    expect(r.stories[0]!.id).toBe("hw");
  });

  it("a story the reader voted on also lends affinity to its source", async () => {
    const ann = await mkUser("a@x.com");
    mkStory("l1", { origin: "lobsters", hoursAgo: 5 });
    raw.prepare("INSERT INTO story_votes (story_id, user_id, created_at) VALUES ('l1',?,?)")
      .run(ann, ago(4));
    const ctx = await rank.viewerContext(ann);
    expect(ctx.authorAffinity.get("lobsters")!).toBeGreaterThan(0);
  });
});

/* ── the real news Worker ────────────────────────────────────────────────────── */

describe("the news front page, over HTTP", () => {
  let env: any, wraw: Database.Database, wrank: RankRepo;

  const req = (p: string, cookie?: string) =>
    newsWorker.fetch(
      new Request("https://thebay.news" + p, cookie ? { headers: { cookie } } : undefined),
      env,
      { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException() {} } as any,
    );
  const signIn = async (email: string) => {
    const r = await newsWorker.fetch(
      new Request("https://thebay.news/auth/dev", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, name: email }),
      }),
      env,
      {} as any,
    );
    return (r.headers.get("set-cookie") || "").split(";")[0]!;
  };
  const rows = () => wraw.prepare("SELECT * FROM rank_impressions").all() as any[];

  function story(id: string, o: { origin?: string; topics?: string[]; hoursAgo?: number } = {}) {
    wraw
      .prepare(
        `INSERT INTO stories (id, kind, title, url, origin, topics_json, vote_count, comment_count,
                              created_at, first_seen_at)
         VALUES (?, 'link', ?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      .run(
        id, `Story ${id}`, `https://example.com/${id}`, o.origin ?? "rss",
        JSON.stringify(o.topics ?? []),
        new Date(Date.now() - (o.hoursAgo ?? 1) * 3600_000).toISOString(),
        new Date(Date.now() - (o.hoursAgo ?? 1) * 3600_000).toISOString(),
      );
  }

  beforeEach(() => {
    const made = makeTestEnv({ RANK_EPSILON: "0" });
    env = made.env;
    wraw = made.raw;
    wrank = new RankRepo(made.d1);
  });

  it("a logged-out reader gets the ordinary page and is not logged", async () => {
    story("a");
    const res = await req("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Story a");
    expect(body).not.toContain("rank-note"); // nothing to explain
    expect(rows()).toHaveLength(0); // and nothing recorded
  });

  it("a signed-in reader is logged, with real feature vectors, and told so", async () => {
    story("a", { topics: ["hardware"] });
    story("b", { topics: ["cooking"], hoursAgo: 3 });
    const cookie = await signIn("reader@x.com");

    const res = await req("/", cookie);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("rank-note");
    expect(body).toContain("personal ranking starts"); // no model yet — said plainly

    const logged = rows();
    expect(logged).toHaveLength(2);
    expect(logged.every((r) => r.surface === "news")).toBe(true);
    const f = JSON.parse(logged.find((r) => r.item_id === "a")!.features_json);
    expect(f.bias).toBe(1);
    expect(f.recency).toBeGreaterThan(0); // a real vector, not a placeholder
  });

  it("an explicit sort is not personalized and records nothing", async () => {
    story("a");
    const cookie = await signIn("reader@x.com");
    const res = await req("/newest", cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("rank-note");
    expect(rows()).toHaveLength(0);
  });

  it("a promoted news model reorders the front page and says which version ranked it", async () => {
    story("quiet", { hoursAgo: 1 });
    story("loud", { hoursAgo: 6 });
    wraw.prepare("UPDATE stories SET vote_count = 40 WHERE id = 'loud'").run();
    await wrank.saveModel({
      surface: "news", weights: { socialProof: 9 }, rrf: {}, nRows: 900,
      holdoutAuc: 0.9, incumbentAuc: null, promote: true,
    });

    const cookie = await signIn("reader@x.com");
    const body = await (await req("/", cookie)).text();
    expect(body).toContain("Ranked for you");
    expect(body.indexOf("Story loud")).toBeLessThan(body.indexOf("Story quiet"));
    expect(rows()[0]!.model_version).toBe("v1");
  });

  it("serves the page even with no ExecutionContext to defer logging into", async () => {
    // `c.executionCtx` is a getter that THROWS when absent, so `?.waitUntil` does not
    // save you. This shipped once: every signed-in front-page request 500'd on a line
    // that exists only to record telemetry.
    story("a");
    const cookie = await signIn("reader@x.com");
    const res = await newsWorker.fetch(
      new Request("https://thebay.news/", { headers: { cookie } }),
      env,
      {} as any, // no waitUntil
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Story a");
  });

  it("does not let the events model rank news", async () => {
    story("a");
    // A promoted EVENTS model must have no effect here — surfaces are independent.
    await wrank.saveModel({
      surface: "events", weights: { socialProof: 9 }, rrf: {}, nRows: 900,
      holdoutAuc: 0.9, incumbentAuc: null, promote: true,
    });
    const cookie = await signIn("reader@x.com");
    const body = await (await req("/", cookie)).text();
    expect(body).toContain("personal ranking starts");
    expect(rows()[0]!.model_version).toBe("v0");
  });
});

/** A zero vector with the bias set — local helper so this file doesn't depend on the
 *  events-side test fixtures. */
function emptyish() {
  return {
    bias: 1, recency: 0, quality: 0, tagAffinity: 0, authorAffinity: 0, friendEngaged: 0,
    socialProof: 0, externalPoints: 0, novelty: 1, proximity: 0.5, isFree: 0, viewerHistory: 0,
  };
}
