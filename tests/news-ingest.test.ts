/**
 * Aggregation: parsing each source, and the merge rules that keep one link to
 * one discussion no matter how many places it shows up.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { parseHn } from "../src/news/ingest/hn";
import { parseLobsters } from "../src/news/ingest/lobsters";
import { parseFeed, decodeXml, fetchFeeds, MAX_ITEMS_PER_FEED, FEED_CONCURRENCY } from "../src/news/ingest/rss";
import { deriveTopics, fallbackSummary, summarizeStory } from "../src/news/summarize";
import { parsePreview, harvestPreview } from "../src/news/ingest/preview";
import { parseGithub, searchUrl } from "../src/news/ingest/github";
import { parseSec, isBayLocation, searchUrl as secSearchUrl } from "../src/news/ingest/sec";
import { NewsRepo } from "../src/storage/d1/news-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { makeTestDb } from "./helpers/d1";

describe("parseHn", () => {
  const payload = {
    hits: [
      { objectID: "111", title: "A real story", url: "https://ex.com/a", points: 42, num_comments: 7, created_at: "2026-07-25T10:00:00Z", author: "pg" },
      { objectID: "222", title: "Ask HN: how do you test Workers?", url: null, points: 9, num_comments: 3, created_at: "2026-07-25T09:00:00Z", author: "dang" },
      { objectID: "", title: "no id", url: "https://ex.com/x" },
      { objectID: "333", title: "", url: "https://ex.com/y" },
    ],
  };

  it("maps hits and keeps the HN thread as a separate credited link", () => {
    const out = parseHn(payload);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      origin: "hn", externalId: "111", title: "A real story",
      url: "https://ex.com/a", externalUrl: "https://news.ycombinator.com/item?id=111",
      points: 42, comments: 7, author: "pg",
    });
  });

  it("keeps text posts by pointing them at the HN thread", () => {
    const ask = parseHn(payload).find((s) => s.externalId === "222")!;
    expect(ask.url).toBeNull();
    expect(ask.externalUrl).toBe("https://news.ycombinator.com/item?id=222");
  });

  it("drops unusable rows instead of throwing", () => {
    expect(parseHn(payload).map((s) => s.externalId)).toEqual(["111", "222"]);
    expect(parseHn(null)).toEqual([]);
    expect(parseHn({ hits: "nope" })).toEqual([]);
  });
});

describe("parseLobsters", () => {
  it("maps rows and translates their tags to our topic axes", () => {
    const out = parseLobsters([
      { short_id: "abc", title: "Rust in the kernel", url: "https://ex.com/r", score: 30, comment_count: 12,
        created_at: "2026-07-25T08:00:00Z", comments_url: "https://lobste.rs/s/abc", tags: ["rust", "compilers", "nonsense"],
        submitter_user: { username: "alice" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.topics).toEqual(["software"]); // deduped, unmapped tag dropped
    expect(out[0]!.externalUrl).toBe("https://lobste.rs/s/abc");
    expect(out[0]!.author).toBe("alice");
  });

  it("tolerates a non-array payload", () => {
    expect(parseLobsters({})).toEqual([]);
  });
});

describe("parseFeed", () => {
  const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
    <title>Feed</title>
    <item>
      <title><![CDATA[Etching at home & other crimes]]></title>
      <link>https://ex.com/etch</link>
      <guid>etch-1</guid>
      <pubDate>Fri, 24 Jul 2026 12:00:00 GMT</pubDate>
    </item>
    <item><title>No link here</title><guid>x</guid></item>
  </channel></rss>`;

  const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <title>A paper about manifolds</title>
      <link rel="alternate" href="https://arxiv.org/abs/1234"/>
      <id>urn:arxiv:1234</id>
      <published>2026-07-20T00:00:00Z</published>
    </entry>
  </feed>`;

  it("reads RSS items, unwrapping CDATA and decoding entities", () => {
    const out = parseFeed(RSS, "f1");
    expect(out).toHaveLength(1); // the link-less item is dropped
    expect(out[0]!.title).toBe("Etching at home & other crimes");
    expect(out[0]!.url).toBe("https://ex.com/etch");
    expect(out[0]!.externalId).toBe("f1:etch-1");
    expect(out[0]!.createdAt).toBe("2026-07-24T12:00:00.000Z");
  });

  it("reads Atom entries, where the link is an attribute", () => {
    const out = parseFeed(ATOM, "arx");
    expect(out[0]!.url).toBe("https://arxiv.org/abs/1234");
    expect(out[0]!.externalId).toBe("arx:urn:arxiv:1234");
  });

  it("namespaces ids by feed so two feeds can't collide on a guid", () => {
    expect(parseFeed(RSS, "a")[0]!.externalId).not.toBe(parseFeed(RSS, "b")[0]!.externalId);
  });

  it("survives malformed input rather than throwing", () => {
    expect(parseFeed("<rss><channel><item><title>unclosed")).toEqual([]);
    expect(parseFeed("")).toEqual([]);
    expect(parseFeed("not xml at all")).toEqual([]);
  });

  it("decodes numeric and named entities", () => {
    expect(decodeXml("a &amp; b &#65; &#x42; &lt;c&gt;")).toBe("a & b A B <c>");
  });
});

describe("fetchFeeds", () => {
  const ok = (body: string) => new Response(body, { status: 200 });
  const FEED = `<rss><channel><item><title>A story title</title><link>https://ex.com/1</link><guid>g1</guid></item></channel></rss>`;

  it("isolates a failing feed instead of losing the whole harvest", async () => {
    const fake = (async (url: any) =>
      String(url).includes("bad") ? new Response("", { status: 500 }) : ok(FEED)) as unknown as typeof fetch;
    const { stories, failed } = await fetchFeeds(
      [{ id: "good", url: "https://ex.com/good.xml" }, { id: "bad", url: "https://ex.com/bad.xml" }],
      fake,
    );
    expect(stories).toHaveLength(1);
    expect(failed).toEqual(["bad"]);
  });

  it("throws only when every feed fails", async () => {
    const fake = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchFeeds([{ id: "a", url: "https://x/1" }, { id: "b", url: "https://x/2" }], fake)).rejects.toThrow(/all 2/);
  });

  it("skips disabled feeds", async () => {
    const fake = (async () => ok(FEED)) as unknown as typeof fetch;
    const { stories } = await fetchFeeds([{ id: "off", url: "https://x/1", enabled: false }], fake);
    expect(stories).toEqual([]);
  });

  it("stamps configured topics onto a feed's items", async () => {
    const fake = (async () => ok(FEED)) as unknown as typeof fetch;
    const { stories } = await fetchFeeds([{ id: "hw", url: "https://x/1", topics: ["hardware"] }], fake);
    expect(stories[0]!.topics).toEqual(["hardware"]);
  });
});

describe("upsertIngested", () => {
  let d1: any, repo: NewsRepo, social: SocialRepo;
  beforeEach(() => { ({ d1 } = makeTestDb()); repo = new NewsRepo(d1); social = new SocialRepo(d1); });

  const item = (over: any = {}) => ({
    origin: "hn" as const, externalId: "1", title: "A story", url: "https://ex.com/a",
    externalUrl: "https://news.ycombinator.com/item?id=1", points: 10, comments: 2,
    createdAt: "2026-07-25T10:00:00.000Z", author: "pg", topics: [], ...over,
  });

  it("creates a story the first time and only refreshes it after", async () => {
    expect(await repo.upsertIngested([item()])).toMatchObject({ created: 1, refreshed: 0 });
    expect(await repo.upsertIngested([item({ points: 99 })])).toMatchObject({ created: 0, refreshed: 1 });
    const { total } = await repo.feed({ src: "all", sort: "new", limit: 10, offset: 0 });
    expect(total).toBe(1);
    const story = (await repo.feed({ src: "hn", sort: "new", limit: 1, offset: 0 })).stories[0]!;
    expect((await repo.sourcesFor(story.id))[0]!.externalPoints).toBe(99);
  });

  it("merges the same link from two aggregators into ONE story with two credits", async () => {
    await repo.upsertIngested([item()]);
    const res = await repo.upsertIngested([
      item({ origin: "lobsters", externalId: "lob1", url: "http://www.ex.com/a/?utm_source=x", externalUrl: "https://lobste.rs/s/lob1" }),
    ]);
    expect(res).toMatchObject({ created: 0, merged: 1 });

    const { stories, total } = await repo.feed({ src: "all", sort: "new", limit: 10, offset: 0 });
    expect(total).toBe(1);
    const sources = await repo.sourcesFor(stories[0]!.id);
    expect(sources.map((s) => s.origin).sort()).toEqual(["hn", "lobsters"]);
  });

  it("keeps a human submission as OURS when an aggregator brings the same link", async () => {
    const u = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "Ann" });
    const { id } = await repo.submit(u.id, { kind: "link", title: "Local take", url: "https://ex.com/a" } as any);
    await repo.upsertIngested([item()]);

    const story = await repo.getStory(id);
    expect(story!.origin).toBe("bay");        // first writer wins
    expect(story!.title).toBe("Local take");  // and keeps our title
    expect((await repo.sourcesFor(id)).map((s) => s.origin).sort()).toEqual(["bay", "hn"]);
    // Still on the default front page, because it's still ours.
    const bay = await repo.feed({ src: "bay", sort: "new", limit: 10, offset: 0 });
    expect(bay.stories.map((s) => s.id)).toEqual([id]);
  });

  it("stores a text post pointed at the source thread", async () => {
    await repo.upsertIngested([
      item({ externalId: "2", url: null, externalUrl: "https://news.ycombinator.com/item?id=2" }),
    ]);
    const { stories } = await repo.feed({ src: "hn", sort: "new", limit: 10, offset: 0 });
    expect(stories[0]!.url).toBe("https://news.ycombinator.com/item?id=2");
  });

  it("is idempotent across repeated runs", async () => {
    const batch = [item(), item({ origin: "lobsters", externalId: "l1", externalUrl: "https://lobste.rs/s/l1" })];
    await repo.upsertIngested(batch);
    await repo.upsertIngested(batch);
    await repo.upsertIngested(batch);
    expect((await repo.feed({ src: "all", sort: "new", limit: 50, offset: 0 })).total).toBe(1);
  });
});

describe("syncEventStories", () => {
  let d1: any, repo: NewsRepo;
  beforeEach(() => { ({ d1 } = makeTestDb()); repo = new NewsRepo(d1); });

  const addEvent = async (id: string, title: string, score: number | null, categories: string) =>
    d1.prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, categories, interest_score, hidden, content_hash, sources_json, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'San Francisco', ?, ?, ?, 0, 'h', '[]', '2026-07-01', '2026-07-01')`,
    ).bind(id, `fp-${id}`, title, "2026-08-01T00:00:00.000Z", `https://ex.com/${id}`, categories, score).run();

  it("posts events that read as tech news and skips the ones that don't", async () => {
    // Both are tagged and scored identically by the EVENTS product, which tags
    // permissively on purpose. Only our own classifier separates them.
    await addEvent("e1", "Hardware Founders Night: MEMS and photonics", 100, '["hardware","vc","software"]');
    await addEvent("e2", "Public Tour | Auguste Rodin", 100, '["vc","math","software"]');

    const n = await repo.syncEventStories(25, "2026-07-25T00:00:00.000Z");
    expect(n).toBe(1);

    const { stories } = await repo.feed({ src: "event", sort: "new", limit: 10, offset: 0 });
    expect(stories.map((s) => s.title)).toEqual(["Hardware Founders Night: MEMS and photonics"]);
    expect(stories[0]!.topics).toEqual(expect.arrayContaining(["hardware", "vc"]));
  });

  it("drops paid course listings entirely — they are ads, not news", async () => {
    // Course vendors carpet-bomb Eventbrite with a template per Bay city. Eight
    // of these in a row was the actual live front page.
    const cities = ["Menlo Park", "San Ramon", "Pleasanton", "Redwood City", "Berkeley", "San Mateo"];
    for (const [i, city] of cities.entries()) {
      await addEvent(`t${i}`, `Enterprise AI Strategy Mastery 1 Day Training in ${city}, CA`, 100, "[]");
    }
    await addEvent("real", "Hardware Founders Night: MEMS and photonics", 100, "[]");

    await repo.syncEventStories(25, "2026-07-25T00:00:00.000Z");
    const titles = (await repo.feed({ src: "event", sort: "new", limit: 25, offset: 0 })).stories.map((s) => s.title);

    expect(titles.filter((t) => /1 Day Training/.test(t))).toHaveLength(0);
    expect(titles).toContain("Hardware Founders Night: MEMS and photonics");
  });

  it("posts ONE entry when the same real event is listed in several cities", async () => {
    // Same rule, applied to something that ISN'T a course ad — dedup must work
    // on its own, not only as a side effect of the training filter.
    for (const [i, city] of ["Oakland", "Berkeley", "San Jose"].entries()) {
      await addEvent(`m${i}`, `Robotics Grasping Research Seminar in ${city}, CA`, 100, "[]");
    }
    await repo.syncEventStories(25, "2026-07-25T00:00:00.000Z");
    const titles = (await repo.feed({ src: "event", sort: "new", limit: 25, offset: 0 })).stories.map((s) => s.title);
    expect(titles.filter((t) => /Robotics Grasping Research Seminar/.test(t))).toHaveLength(1);
  });

  it("is idempotent — a second run creates nothing new", async () => {
    await addEvent("e1", "Robotics startup demo day", 100, "[]");
    expect(await repo.syncEventStories(25, "2026-07-25T00:00:00.000Z")).toBe(1);
    expect(await repo.syncEventStories(25, "2026-07-25T00:00:00.000Z")).toBe(0);
  });

  it("respects the limit so events can't flood the front page", async () => {
    // Genuinely distinct events — "meetup 1/2/3" would (correctly) collapse as
    // near-duplicates now, which would test dedup rather than the limit.
    const distinct = [
      "Robotics grasping seminar at Berkeley",
      "Seed-stage venture office hours",
      "Compiler internals reading group",
      "MEMS fabrication teardown night",
      "Distributed databases paper club",
      "Hardware prototyping open lab",
      "Founder pitch practice session",
      "Cryptography proofs study group",
    ];
    for (const [i, t] of distinct.entries()) await addEvent(`e${i}`, t, 100, "[]");
    expect(await repo.syncEventStories(3, "2026-07-25T00:00:00.000Z")).toBe(3);
  });
});

describe("link previews", () => {
  const PAGE = `<!doctype html><html lang="en"><head>
    <meta property="og:image" content="/img/hero.png">
    <meta property="og:description" content="A two-year build log &amp; teardown.">
    <meta property="og:site_name" content="Semiconductor Engineering">
    <meta property="article:published_time" content="2026-07-20T08:00:00Z">
    <link rel="apple-touch-icon" href="https://cdn.example.com/icon.png">
  </head><body>…</body></html>`;

  it("extracts OpenGraph metadata and resolves relative URLs", () => {
    const p = parsePreview(PAGE, "https://semiengineering.com/a/b");
    expect(p.imageUrl).toBe("https://semiengineering.com/img/hero.png");
    expect(p.description).toBe("A two-year build log & teardown.");
    expect(p.siteName).toBe("Semiconductor Engineering");
    expect(p.publishedAt).toBe("2026-07-20T08:00:00.000Z");
    expect(p.faviconUrl).toBe("https://cdn.example.com/icon.png");
    expect(p.lang).toBe("en");
  });

  it("copes with attribute order, single quotes and twitter fallbacks", () => {
    const p = parsePreview(
      `<html><head><meta content='https://x.com/i.jpg' name='twitter:image'>
       <meta name="description" content="fallback desc"></head></html>`,
      "https://x.com/",
    );
    expect(p.imageUrl).toBe("https://x.com/i.jpg");
    expect(p.description).toBe("fallback desc");
  });

  it("returns nulls for a page with no metadata, never throws", () => {
    const p = parsePreview("<html><head><title>x</title></head></html>", "https://x.com/");
    expect(p.imageUrl).toBeNull();
    expect(p.description).toBeNull();
    expect(p.faviconUrl).toBe("https://x.com/favicon.ico"); // conventional default
    expect(() => parsePreview("", "not a url")).not.toThrow();
  });

  it("refuses non-http image schemes", () => {
    const p = parsePreview(`<html><head><meta property="og:image" content="javascript:alert(1)"></head></html>`, "https://x.com/");
    expect(p.imageUrl).toBeNull();
  });

  it("harvests over the network and degrades on failure", async () => {
    const okFetch = (async () =>
      new Response(PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as typeof fetch;
    const got = await harvestPreview("https://semiengineering.com/a", okFetch);
    expect(got.siteName).toBe("Semiconductor Engineering");

    for (const bad of [
      (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
      (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
      (async () => { throw new Error("network down"); }) as unknown as typeof fetch,
    ]) {
      const out = await harvestPreview("https://x.com/a", bad);
      expect(out.imageUrl).toBeNull(); // empty, not thrown
    }
    expect((await harvestPreview("javascript:alert(1)", okFetch)).imageUrl).toBeNull();
  });

  it("stamps preview_fetched_at even when empty, so it is never re-fetched", async () => {
    const { d1 } = makeTestDb();
    const repo = new NewsRepo(d1);
    const social = new SocialRepo(d1);
    const u = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "A" });
    const { id } = await repo.submit(u.id, { kind: "link", title: "A story", url: "https://ex.com/a" } as any);

    expect((await repo.needingPreview()).map((s) => s.id)).toEqual([id]);
    await repo.setPreview(id, { imageUrl: null, description: null, siteName: null, faviconUrl: null, publishedAt: null, lang: null });
    expect(await repo.needingPreview()).toEqual([]); // not retried forever
  });

  it("stores harvested metadata so the renderer can show a preview card", async () => {
    const { d1 } = makeTestDb();
    const repo = new NewsRepo(d1);
    const social = new SocialRepo(d1);
    const u = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "A" });
    const { id } = await repo.submit(u.id, { kind: "link", title: "A story", url: "https://ex.com/a" } as any);
    await repo.setPreview(id, parsePreview(PAGE, "https://ex.com/a"));

    const s = (await repo.getStory(id))!;
    expect(s.imageUrl).toBe("https://ex.com/img/hero.png");
    expect(s.siteName).toBe("Semiconductor Engineering");
    // …and it reaches the feed, which is what renders the thumbnail.
    expect((await repo.feed({ src: "bay", sort: "new", limit: 5, offset: 0 })).stories[0]!.imageUrl).toBeTruthy();
  });
});

describe("summarize", () => {
  it("derives topics on the four axes this site ranks against", () => {
    expect(deriveTopics("A new MEMS resonator and photonic chip")).toContain("hardware");
    expect(deriveTopics("Series B raise led by a venture fund")).toContain("vc");
    expect(deriveTopics("A shorter proof of the conjecture")).toContain("math");
    expect(deriveTopics("A faster compiler runtime in Rust")).toContain("software");
    expect(deriveTopics("nothing in particular")).toEqual([]);
  });

  it("falls back to the source description when it's substantial enough", () => {
    expect(fallbackSummary({ description: "short", body: null, title: "t" })).toBeNull();
    const long = "A detailed writeup of how the team rebuilt their etching rig from scrap parts over two years.";
    expect(fallbackSummary({ description: long, body: null, title: "t" })).toBe(long);
  });

  it("degrades gracefully with no AI binding at all", async () => {
    const story: any = { title: "A MEMS resonator", description: "A detailed two-year build log of garage-scale fabrication work.", body: null };
    const out = await summarizeStory({} as any, story);
    expect(out!.summary).toContain("build log");
    expect(out!.topics).toContain("hardware");
  });

  it("ignores a model response that is empty or absurdly long", async () => {
    const story: any = { title: "A MEMS resonator", description: "A detailed two-year build log of garage-scale fabrication.", body: null };
    for (const response of ["", "x".repeat(5000)]) {
      const env: any = { AI: { run: async () => ({ response }) } };
      const out = await summarizeStory(env, story);
      expect(out!.summary).toContain("build log"); // fell back, didn't store junk
    }
  });

  it("uses the model when it returns something sensible", async () => {
    const env: any = { AI: { run: async () => ({ response: "A Fremont engineer fabricated a MEMS resonator at home over two years." }) } };
    const out = await summarizeStory(env, { title: "t", description: "d".repeat(50), body: null } as any);
    expect(out!.summary).toBe("A Fremont engineer fabricated a MEMS resonator at home over two years.");
  });

  it("survives a model that throws", async () => {
    const env: any = { AI: { run: async () => { throw new Error("upstream down"); } } };
    const out = await summarizeStory(env, { title: "A chip story", description: "d".repeat(60), body: null } as any);
    expect(out).not.toBeNull();
  });
});

describe("parseGithub", () => {
  const payload = {
    items: [
      { id: 1, full_name: "acme/fastdb", description: "An embedded database for the edge",
        html_url: "https://github.com/acme/fastdb", stargazers_count: 420, open_issues_count: 7,
        created_at: "2026-07-20T00:00:00Z", language: "Rust", topics: ["database"], owner: { login: "acme" } },
      { id: 2, full_name: "hw/fpga-tools", description: null, html_url: "https://github.com/hw/fpga-tools",
        stargazers_count: 90, created_at: "2026-07-22T00:00:00Z", language: "Verilog", topics: ["fpga"], owner: { login: "hw" } },
      { id: 3, full_name: "", description: "no name", html_url: "https://github.com/x" },
    ],
  };

  it("maps repos, carrying the description into the title", () => {
    const out = parseGithub(payload);
    expect(out).toHaveLength(2); // the nameless row is dropped
    expect(out[0]!.title).toBe("acme/fastdb — An embedded database for the edge");
    expect(out[0]!.url).toBe("https://github.com/acme/fastdb");
    expect(out[0]!.points).toBe(420);
    expect(out[0]!.author).toBe("acme");
    expect(out[0]!.origin).toBe("github");
  });

  it("falls back to the repo name when there's no description", () => {
    expect(parseGithub(payload)[1]!.title).toBe("hw/fpga-tools");
  });

  it("derives topics from language and repo topics", () => {
    const out = parseGithub(payload);
    expect(out[0]!.topics).toContain("software");   // Rust
    expect(out[1]!.topics).toContain("hardware");   // Verilog + fpga
  });

  it("has no separate discussion thread — the repo is the destination", () => {
    expect(parseGithub(payload)[0]!.externalUrl).toBeNull();
  });

  it("tolerates a junk payload", () => {
    expect(parseGithub(null)).toEqual([]);
    expect(parseGithub({ items: "nope" })).toEqual([]);
  });

  it("only asks for recently-created repos, so it isn't the same giants forever", () => {
    const url = searchUrl(Date.parse("2026-07-25T00:00:00Z"));
    expect(url).toContain("created%3A%3E2026-07-11"); // 14 days back
    expect(url).toContain("sort=stars");
  });
});

describe("parseSec", () => {
  const hit = (over: any = {}) => ({
    _id: "0001-26-000013:primary_doc.xml",
    _source: {
      ciks: ["0001234567"], display_names: ["Acme Robotics Inc  (CIK 0001234567)"],
      form: "D", file_date: "2026-07-21", biz_locations: ["San Francisco, CA"],
      adsh: "0001234567-26-000013", ...over,
    },
  });

  it("keeps Bay Area filers and drops everyone else", () => {
    const out = parseSec({ hits: { hits: [
      hit(),
      hit({ adsh: "x-2", biz_locations: ["El Segundo, CA"] }),   // California, not the Bay
      hit({ adsh: "x-3", biz_locations: ["Austin, TX"] }),
      hit({ adsh: "x-4", biz_locations: ["Shanghai, F4"] }),
    ] } });
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("Acme Robotics Inc filed a Form D — San Francisco, CA");
    expect(out[0]!.origin).toBe("sec");
    expect(out[0]!.topics).toEqual(["vc"]);
  });

  it("recognises the Bay by city, and requires California", () => {
    for (const ok of ["San Francisco, CA", "Palo Alto, CA", "Menlo Park, CA", "Oakland, CA", "San Jose, CA"]) {
      expect(isBayLocation(ok), ok).toBe(true);
    }
    for (const no of ["El Segundo, CA", "Austin, TX", "San Francisco, TX", "Shanghai, F4", ""]) {
      expect(isBayLocation(no), no).toBe(false);
    }
  });

  it("emits ONE story per filing, not one per document in it", () => {
    const out = parseSec({ hits: { hits: [hit(), hit({ }), hit({ })] } });
    expect(out).toHaveLength(1);
  });

  it("strips the CIK suffix from the company name", () => {
    expect(parseSec({ hits: { hits: [hit()] } })[0]!.title).not.toContain("CIK");
  });

  it("links to the filing index page", () => {
    expect(parseSec({ hits: { hits: [hit()] } })[0]!.url)
      .toBe("https://www.sec.gov/Archives/edgar/data/1234567/000123456726000013/0001234567-26-000013-index.htm");
  });

  it("date-bounds the query so it stays small and current", () => {
    const url = secSearchUrl(Date.parse("2026-07-25T00:00:00Z"), 7);
    expect(url).toContain("forms=D");
    expect(url).toContain("startdt=2026-07-18");
    expect(url).toContain("enddt=2026-07-25");
  });

  it("tolerates a junk payload", () => {
    expect(parseSec(null)).toEqual([]);
    expect(parseSec({ hits: {} })).toEqual([]);
  });
});

describe("per-feed volume cap", () => {
  const many = (n: number) =>
    `<rss><channel>${Array.from({ length: n }, (_, i) =>
      `<item><title>Story number ${i}</title><link>https://ex.com/${i}</link><guid>g${i}</guid></item>`).join("")}</channel></rss>`;

  it("caps a feed that returns its entire history", async () => {
    // OpenAI's feed really does return 1050 items; unchecked it was 63% of the site.
    const fake = (async () => new Response(many(1050), { status: 200 })) as unknown as typeof fetch;
    const { stories } = await fetchFeeds([{ id: "huge", url: "https://x/1" }], fake);
    expect(stories).toHaveLength(MAX_ITEMS_PER_FEED);
  });

  it("takes the NEWEST items, since feeds are ordered newest-first", async () => {
    const fake = (async () => new Response(many(50), { status: 200 })) as unknown as typeof fetch;
    const { stories } = await fetchFeeds([{ id: "f", url: "https://x/1" }], fake);
    expect(stories[0]!.title).toBe("Story number 0");
  });

  it("lets a feed opt into a different cap", async () => {
    const fake = (async () => new Response(many(50), { status: 200 })) as unknown as typeof fetch;
    const { stories } = await fetchFeeds([{ id: "f", url: "https://x/1", max: 3 }], fake);
    expect(stories).toHaveLength(3);
  });

  it("leaves small feeds untouched", async () => {
    const fake = (async () => new Response(many(4), { status: 200 })) as unknown as typeof fetch;
    const { stories } = await fetchFeeds([{ id: "f", url: "https://x/1" }], fake);
    expect(stories).toHaveLength(4);
  });
});

describe("feed fetching at scale", () => {
  const FEED = (n: number) =>
    `<rss><channel>${Array.from({ length: n }, (_, i) =>
      `<item><title>Item number ${i}</title><link>https://ex.com/${i}</link><guid>g${i}</guid></item>`).join("")}</channel></rss>`;

  it("fetches concurrently rather than one feed at a time", async () => {
    // 86 feeds sequentially is ~45s of a cron tick spent waiting on sockets.
    let inFlight = 0, peak = 0;
    const fake = (async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(FEED(2), { status: 200 });
    }) as unknown as typeof fetch;

    const feeds = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, url: `https://x/${i}` }));
    await fetchFeeds(feeds, fake);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(FEED_CONCURRENCY); // bounded: still a polite client
  });

  it("still isolates failures when running concurrently", async () => {
    const fake = (async (url: any) =>
      String(url).includes("bad") ? new Response("", { status: 500 }) : new Response(FEED(2), { status: 200 })) as unknown as typeof fetch;
    const feeds = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `ok${i}`, url: `https://x/ok${i}` })),
      { id: "bad1", url: "https://x/bad1" }, { id: "bad2", url: "https://x/bad2" },
    ];
    const { stories, failed } = await fetchFeeds(feeds, fake);
    expect(failed.sort()).toEqual(["bad1", "bad2"]);
    expect(stories).toHaveLength(20);
  });

  it("every configured feed has an id, a url and a topics array", async () => {
    const feeds = (await import("../config/news-feeds.json")).default as any[];
    expect(feeds.length).toBeGreaterThan(50);
    const ids = new Set<string>();
    for (const f of feeds) {
      expect(f.id, JSON.stringify(f)).toBeTruthy();
      expect(f.url).toMatch(/^https?:\/\//);
      expect(Array.isArray(f.topics), f.id).toBe(true);
      expect(ids.has(f.id), `duplicate feed id: ${f.id}`).toBe(false);
      ids.add(f.id);
    }
  });

  it("covers every interest axis", async () => {
    const feeds = (await import("../config/news-feeds.json")).default as any[];
    for (const axis of ["hardware", "vc", "math", "software"]) {
      expect(feeds.some((f) => f.topics.includes(axis)), `no feeds for ${axis}`).toBe(true);
    }
  });
});

describe("malformed feed links can't sink a run", () => {
  const RELATIVE = `<rss><channel>
    <item><title>A relative link story</title><link>/blog/thing/</link><guid>g1</guid></item>
    <item><title>An absolute one</title><link>https://other.com/x</link><guid>g2</guid></item>
  </channel></rss>`;

  it("resolves relative links against the feed's own URL", () => {
    // Stanford's AI blog really does emit "/blog/linkbert/".
    const out = parseFeed(RELATIVE, "stan", "https://ai.stanford.edu/blog/feed.xml");
    expect(out[0]!.url).toBe("https://ai.stanford.edu/blog/thing/");
    expect(out[1]!.url).toBe("https://other.com/x");
  });

  it("drops a relative link when there's no base to resolve against", () => {
    expect(parseFeed(RELATIVE, "x").map((s) => s.url)).toEqual(["https://other.com/x"]);
  });

  it("skips an unusable link instead of aborting the whole harvest", async () => {
    // Inserting kind='link' with a null url violates the stories CHECK, which
    // 500'd the entire ingest run — one bad URL out of ~1000 killed everything.
    const { d1 } = makeTestDb();
    const repo = new NewsRepo(d1);
    const item = (over: any) => ({
      origin: "rss" as const, externalId: "x", title: "A story", url: "https://ex.com/ok",
      externalUrl: null, points: null, comments: null,
      createdAt: "2026-07-25T10:00:00.000Z", author: null, topics: [], ...over,
    });

    const res = await repo.upsertIngested([
      item({ externalId: "a", url: "/relative/path" }),      // unusable
      item({ externalId: "b", url: "javascript:alert(1)" }), // unusable
      item({ externalId: "c", url: "https://ex.com/good" }), // fine
    ]);
    expect(res.created).toBe(1);
    const { stories } = await repo.feed({ src: "all", sort: "new", limit: 10, offset: 0 });
    expect(stories.map((s) => s.url)).toEqual(["https://ex.com/good"]);
  });
});
