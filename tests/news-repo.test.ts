/**
 * NewsRepo invariants, against real SQLite with real constraints. These encode the
 * product rules — one story per link, one vote per person, counters that can't
 * drift, replies that can't jump threads — not the shape of the SQL.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { NewsRepo, slugify } from "../src/storage/d1/news-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { makeTestDb } from "./helpers/d1";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const at = (h: number) => new Date(NOW - h * 3600_000).toISOString();

describe("NewsRepo", () => {
  let d1: any, repo: NewsRepo, social: SocialRepo;
  let ann: any, bob: any, cat: any;

  beforeEach(async () => {
    ({ d1 } = makeTestDb());
    repo = new NewsRepo(d1);
    social = new SocialRepo(d1);
    ann = await social.upsertByIdentity({ provider: "dev", providerUid: "ann@x.com", email: "ann@x.com", displayName: "Ann" });
    bob = await social.upsertByIdentity({ provider: "dev", providerUid: "bob@x.com", email: "bob@x.com", displayName: "Bob" });
    cat = await social.upsertByIdentity({ provider: "dev", providerUid: "cat@x.com", email: "cat@x.com", displayName: "Cat" });
  });

  const submit = (u: any, over: any = {}) =>
    repo.submit(u.id, { kind: "link", title: "A MEMS resonator", url: "https://ex.com/mems", ...over } as any, at(1));

  it("stores a submission with a slug and canonical url", async () => {
    const { id, duplicate } = await submit(ann, { title: "Fabricating a 200µm MEMS resonator!" });
    expect(duplicate).toBe(false);
    const s = await repo.getStory(id);
    expect(s!.title).toBe("Fabricating a 200µm MEMS resonator!");
    expect(s!.slug).toBe("fabricating-a-200-m-mems-resonator");
    expect(s!.domain).toBe("ex.com");
    expect(s!.origin).toBe("bay");
    expect(s!.author).toBe("Ann");
  });

  it("collapses a resubmitted link to the existing discussion instead of duplicating", async () => {
    const first = await submit(ann);
    // Same article, different string: tracking params, www, http, trailing slash.
    const second = await repo.submit(
      bob.id,
      { kind: "link", title: "MEMS resonator", url: "http://www.ex.com/mems/?utm_source=twitter" } as any,
      at(1),
    );
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    const { total } = await repo.feed({ src: "all", sort: "new", limit: 10, offset: 0 }, null, NOW);
    expect(total).toBe(1);
  });

  it("counts a vote once, however many times it is cast", async () => {
    const { id } = await submit(ann);
    expect((await repo.vote(id, bob.id)).counted).toBe(true);
    expect((await repo.vote(id, bob.id)).counted).toBe(false); // idempotent
    expect((await repo.vote(id, cat.id)).counted).toBe(true);
    expect((await repo.getStory(id))!.voteCount).toBe(2);
  });

  it("keeps the counter honest when a vote is withdrawn, and never goes negative", async () => {
    const { id } = await submit(ann);
    await repo.vote(id, bob.id);
    await repo.unvote(id, bob.id);
    expect((await repo.getStory(id))!.voteCount).toBe(0);
    await repo.unvote(id, bob.id); // already gone
    expect((await repo.getStory(id))!.voteCount).toBe(0);
  });

  it("reports whether the viewer voted, and tells viewers apart", async () => {
    const { id } = await submit(ann);
    await repo.vote(id, bob.id);
    expect((await repo.getStory(id, bob.id))!.didVote).toBe(true);
    expect((await repo.getStory(id, cat.id))!.didVote).toBe(false);
    expect((await repo.getStory(id))!.didVote).toBeUndefined(); // anonymous
  });

  it("threads comments, deriving depth server-side", async () => {
    const { id } = await submit(ann);
    const top: any = await repo.addComment(id, bob.id, "top level", null, at(1));
    const reply: any = await repo.addComment(id, cat.id, "a reply", top.id, at(0.5));
    const deep: any = await repo.addComment(id, ann.id, "deeper", reply.id, at(0.2));

    const cs = await repo.comments(id);
    expect(cs.map((c) => c.depth)).toEqual([0, 1, 2]);
    expect(cs.map((c) => c.author)).toEqual(["Bob", "Cat", "Ann"]);
    expect((await repo.getStory(id))!.commentCount).toBe(3);
    expect(deep.id).toBeTruthy();
  });

  it("refuses to graft a reply onto a comment from another story", async () => {
    const a = await submit(ann);
    const b = await repo.submit(ann.id, { kind: "link", title: "Other", url: "https://ex.com/other" } as any, at(1));
    const onA: any = await repo.addComment(a.id, bob.id, "hi", null, at(1));
    const bad = await repo.addComment(b.id, bob.id, "sneaky", onA.id, at(1));
    expect(bad).toEqual({ error: "bad_parent" });
  });

  it("ranks hot by gravity, not raw votes", async () => {
    const stale = await repo.submit(ann.id, { kind: "link", title: "Stale", url: "https://ex.com/1" } as any, at(120));
    const fresh = await repo.submit(ann.id, { kind: "link", title: "Fresh", url: "https://ex.com/2" } as any, at(1));
    for (const u of [ann, bob, cat]) await repo.vote(stale.id, u.id);
    await repo.vote(fresh.id, bob.id);
    await repo.vote(fresh.id, cat.id);

    const { stories } = await repo.feed({ src: "all", sort: "hot", limit: 10, offset: 0 }, null, NOW);
    expect(stories[0]!.title).toBe("Fresh"); // fewer votes, but recent
    const byNew = await repo.feed({ src: "all", sort: "top", limit: 10, offset: 0 }, null, NOW);
    expect(byNew.stories[0]!.title).toBe("Stale"); // top is raw votes
  });

  it("leads the front page with OUR content, and filters exactly when asked", async () => {
    // `bay` is the CURATED front page, not a filter: ours leads, and a
    // quality-barred slice of aggregated content fills the rest (see
    // src/news/curate.ts). Explicit ?src= values are still strict filters.
    await repo.submit(ann.id, { kind: "link", title: "Local", url: "https://ex.com/local" } as any, at(1));
    await d1
      .prepare(
        `INSERT INTO stories (id, kind, title, url, url_hash, origin, created_at) VALUES ('hn1','link','From HN','https://ex.com/hn','hh','hn',?)`,
      )
      .bind(at(1))
      .run();
    await d1
      .prepare("INSERT INTO story_sources (story_id,origin,external_id,external_points,fetched_at) VALUES ('hn1','hn','e1',900,?)")
      .bind(at(1))
      .run();

    const bay = await repo.feed({ src: "bay", sort: "hot", limit: 10, offset: 0 }, null, NOW);
    expect(bay.stories[0]!.title).toBe("Local");                    // ours leads
    expect(bay.stories.map((s) => s.title)).toContain("From HN");   // strong aggregated fills in

    const all = await repo.feed({ src: "all", sort: "new", limit: 10, offset: 0 }, null, NOW);
    expect(all.stories.map((s) => s.title).sort()).toEqual(["From HN", "Local"]);
    const hn = await repo.feed({ src: "hn", sort: "new", limit: 10, offset: 0 }, null, NOW);
    expect(hn.stories.map((s) => s.title)).toEqual(["From HN"]);
  });

  it("keeps weak aggregated content off the front page but in ?src=all", async () => {
    await d1
      .prepare("INSERT INTO stories (id,kind,title,url,url_hash,origin,created_at) VALUES ('w','link','Barely upvoted','https://ex.com/w','wh','hn',?)")
      .bind(at(1)).run();
    await d1
      .prepare("INSERT INTO story_sources (story_id,origin,external_id,external_points,fetched_at) VALUES ('w','hn','ew',2,?)")
      .bind(at(1)).run();

    const bay = await repo.feed({ src: "bay", sort: "hot", limit: 10, offset: 0 }, null, NOW);
    expect(bay.stories.map((s) => s.title)).not.toContain("Barely upvoted");
    const all = await repo.feed({ src: "all", sort: "new", limit: 10, offset: 0 }, null, NOW);
    expect(all.stories.map((s) => s.title)).toContain("Barely upvoted");
  });

  it("never shows moderated stories in any view", async () => {
    const { id } = await submit(ann);
    await d1.prepare("UPDATE stories SET dead = 1 WHERE id = ?").bind(id).run();
    const all = await repo.feed({ src: "all", sort: "new", limit: 10, offset: 0 }, null, NOW);
    expect(all.stories).toHaveLength(0);
    expect(await repo.getStory(id)).toBeNull();
  });

  it("counts a friend's vote as a network vote and a stranger's as not", async () => {
    const { id } = await submit(ann);
    await social.requestFriend(ann.id, bob.id);
    await social.respondFriend(bob.id, ann.id, true);
    await repo.vote(id, bob.id); // friend of ann
    await repo.vote(id, cat.id); // stranger

    const net = await repo.networkVoteCounts([id], ann.id);
    expect(net.get(id)).toBe(1);
    expect((await repo.networkVoteCounts([id], cat.id)).get(id) ?? 0).toBe(0);
  });

  it("handles a large candidate set without exceeding D1's bound-parameter cap", async () => {
    // The hot ranker scores its whole candidate window, so the source/vote
    // lookups run over hundreds of ids. An unchunked IN (?,?,…) throws at
    // runtime — which took the live front page down with a 500.
    for (let i = 0; i < 220; i++) {
      await repo.submit(ann.id, { kind: "link", title: `Story ${i}`, url: `https://ex.com/n${i}` } as any, at(i % 100));
    }
    const hot = await repo.feed({ src: "all", sort: "hot", limit: 30, offset: 0 }, ann.id, NOW);
    expect(hot.stories).toHaveLength(30);
    expect(hot.stories.every((s) => Array.isArray(s.sources))).toBe(true);
    expect(hot.stories.every((s) => typeof s.didVote === "boolean")).toBe(true);
  });

  it("paginates without repeating or dropping rows", async () => {
    for (let i = 0; i < 5; i++) {
      await repo.submit(ann.id, { kind: "link", title: `S${i}`, url: `https://ex.com/${i}` } as any, at(5 - i));
    }
    const p1 = await repo.feed({ src: "all", sort: "new", limit: 2, offset: 0 }, null, NOW);
    const p2 = await repo.feed({ src: "all", sort: "new", limit: 2, offset: 2 }, null, NOW);
    const ids = [...p1.stories, ...p2.stories].map((s) => s.id);
    expect(new Set(ids).size).toBe(4);
    expect(p1.total).toBe(5);
  });
});

describe("slugify", () => {
  it("makes a readable, url-safe slug", () => {
    expect(slugify("Fabricating a 200µm MEMS Resonator!")).toBe("fabricating-a-200-m-mems-resonator");
    expect(slugify("  ...  ")).toBe("");
    expect(slugify("a".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

/**
 * Sources that publish with lag.
 *
 * openFDA releases 510(k) records about two weeks after the decision date
 * printed on them, so every clearance is born ~16 days "old". Hot windowed on
 * created_at, so fourteen of them landed in production and not one could ever
 * reach the front page. Nothing errored — the source was unreachable by
 * construction, which is the kind of bug you only find by staring at an empty
 * page and wondering.
 */
describe("lagging sources — ranked on when they reached us", () => {
  let d1: any, repo: NewsRepo;
  beforeEach(() => { ({ d1 } = makeTestDb()); repo = new NewsRepo(d1); });

  /** A clearance decided 16 days ago, published by the source today. */
  const laggy = () =>
    repo.upsertIngested(
      [{
        origin: "fda", externalId: "K260123",
        title: "Bay Medical cleared a device — Palo Alto, CA",
        url: "https://accessdata.fda.gov/k260123", externalUrl: null,
        points: null, comments: null,
        createdAt: at(16 * 24), author: null, topics: ["hardware"],
      }] as any,
      new Date(NOW).toISOString(),
    );

  it("puts a story we just received on the front page, even though it is dated weeks ago", async () => {
    await laggy();
    const { stories } = await repo.feed({ src: "fda", sort: "hot", limit: 20, offset: 0 }, null, NOW);
    expect(stories.map((s) => s.title)).toContain("Bay Medical cleared a device — Palo Alto, CA");
  });

  it("still DISPLAYS the real decision date, not the date we found it", async () => {
    await laggy();
    const { stories } = await repo.feed({ src: "fda", sort: "hot", limit: 20, offset: 0 }, null, NOW);
    // The reader must see when the clearance happened. Only ranking uses first-seen.
    expect(stories[0]!.createdAt).toBe(at(16 * 24));
    expect(Date.parse(stories[0]!.firstSeenAt)).toBe(NOW);
  });

  it("counts what it can show — no '14 stories' above an empty page", async () => {
    await laggy();
    const hot = await repo.feed({ src: "fda", sort: "hot", limit: 20, offset: 0 }, null, NOW);
    expect(hot.total).toBe(hot.stories.length);
    // And a genuinely stale story is excluded from BOTH the list and the count.
    const later = NOW + 30 * 86_400_000;
    const stale = await repo.feed({ src: "fda", sort: "hot", limit: 20, offset: 0 }, null, later);
    expect(stale.stories).toHaveLength(0);
    expect(stale.total).toBe(0);
  });

  it("does not let a story renew its own freshness by being re-fetched", async () => {
    await laggy();
    // Same story, harvested again 10 days later — first_seen must not move.
    await repo.upsertIngested(
      [{
        origin: "fda", externalId: "K260123",
        title: "Bay Medical cleared a device — Palo Alto, CA",
        url: "https://accessdata.fda.gov/k260123", externalUrl: null,
        points: null, comments: null, createdAt: at(16 * 24), author: null, topics: [],
      }] as any,
      new Date(NOW + 10 * 86_400_000).toISOString(),
    );
    const { stories } = await repo.feed({ src: "fda", sort: "new", limit: 20, offset: 0 }, null, NOW);
    expect(Date.parse(stories[0]!.firstSeenAt)).toBe(NOW);
  });

  it("does NOT do the same for feeds — an archived post is not news", async () => {
    // Production carries hn and rss items dated up to fourteen years back, because
    // feeds emit their archives. An RSS pubDate is a real publication time, so
    // ranking these by when we fetched them would put 2012 on the front page.
    await repo.upsertIngested(
      [{
        origin: "rss", externalId: "old-1", title: "A blog post from 2019",
        url: "https://ex.com/2019-post", externalUrl: null, points: null, comments: null,
        createdAt: new Date(NOW - 2200 * 86_400_000).toISOString(), author: null, topics: [],
      }] as any,
      new Date(NOW).toISOString(),
    );
    const { stories, total } = await repo.feed({ src: "rss", sort: "hot", limit: 20, offset: 0 }, null, NOW);
    expect(stories).toHaveLength(0);
    expect(total).toBe(0);
    // Still reachable where old things belong.
    const recent = await repo.feed({ src: "rss", sort: "new", limit: 20, offset: 0 }, null, NOW);
    expect(recent.stories).toHaveLength(1);
  });

  it("won't let even a lagging source resurface antiquity", async () => {
    // A first-ever harvest of a backfilled dataset must not dump months of
    // history onto the front page just because all of it is new to us.
    await repo.upsertIngested(
      [{
        origin: "fda", externalId: "K200001", title: "A clearance from last year — Oakland, CA",
        url: "https://accessdata.fda.gov/k200001", externalUrl: null, points: null, comments: null,
        createdAt: new Date(NOW - 300 * 86_400_000).toISOString(), author: null, topics: [],
      }] as any,
      new Date(NOW).toISOString(),
    );
    const { stories } = await repo.feed({ src: "fda", sort: "hot", limit: 20, offset: 0 }, null, NOW);
    expect(stories).toHaveLength(0);
  });

  it("every origin the site can filter by is reachable from the UI", async () => {
    // The 14 FDA stories were also unreachable for a duller reason: no chip
    // rendered for them. A source we ingest but never link to is dead weight.
    const { filterBar } = await import("../src/news/render/story");
    const { NewsFeedSourceSchema } = await import("../shared/schema");
    const bar = String(filterBar({ src: "bay", sort: "hot" }));
    for (const src of (NewsFeedSourceSchema as any).options ?? []) {
      expect(bar, `no filter chip links to ?src=${src}`).toMatch(
        src === "bay" ? /href="\/"/ : new RegExp(`src=${src}\\b`),
      );
    }
  });
});
