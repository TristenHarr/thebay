/**
 * thebay.news end-to-end through the REAL Worker: server-rendered HTML, the SEO
 * surface, the Bay-presence gate, and escaping of user content.
 *
 * The SEO assertions matter as much as the behavioural ones — the whole reason
 * this site is server-rendered is that crawlers never run JavaScript, and that
 * property is invisible to a normal functional test.
 */
import { describe, it, expect, beforeEach } from "vitest";
import newsWorker from "../src/worker/news";
import { makeTestEnv } from "./helpers/app";
import { NewsRepo } from "../src/storage/d1/news-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";

const SF = { lat: 37.7749, lng: -122.4194 };
const LA = { lat: 34.0522, lng: -118.2437 };

describe("thebay.news worker", () => {
  let env: any, repo: NewsRepo, social: SocialRepo;

  const get = (path: string, init: RequestInit = {}) =>
    newsWorker.fetch(new Request("https://thebay.news" + path, init), env, {} as any);

  const post = (path: string, body: any, cookie?: string, form = false) =>
    newsWorker.fetch(
      new Request("https://thebay.news" + path, {
        method: "POST",
        headers: {
          "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      }),
      env,
      {} as any,
    );

  async function login(email = "ann@x.com", name = "Ann") {
    const res = await post("/auth/dev", { email, name });
    return (res.headers.get("set-cookie") || "").split(";")[0]!;
  }

  beforeEach(async () => {
    ({ env } = makeTestEnv({ NEWS_ORIGIN: "https://thebay.news", PUBLIC_ORIGIN: "https://thebay.events" }));
    repo = new NewsRepo(env.DB);
    social = new SocialRepo(env.DB);
  });

  async function seed(over: any = {}) {
    const u = await social.upsertByIdentity({ provider: "dev", providerUid: "seed@x.com", email: "seed@x.com", displayName: "Seeder" });
    const { id } = await repo.submit(u.id, {
      kind: "link", title: "Fabricating a MEMS resonator", url: "https://semiconductor-eng.com/mems", ...over,
    } as any);
    return { id, user: u };
  }

  // ── server-rendered content ────────────────────────────────────────────────

  it("renders the front page as complete HTML, with the story text in the response", async () => {
    await seed();
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    // The proof that a crawler sees the content: it's in the bytes, no JS needed.
    expect(body).toContain("Fabricating a MEMS resonator");
    expect(body).toContain("semiconductor-eng.com");
    expect(body).toContain("</html>");
  });

  it("emits the full SEO head — canonical, OpenGraph, Twitter, JSON-LD", async () => {
    await seed();
    const body = await (await get("/")).text();
    expect(body).toContain('<link rel="canonical" href="https://thebay.news/"');
    expect(body).toContain('property="og:title"');
    expect(body).toContain('property="og:site_name" content="thebay.news"');
    expect(body).toContain('name="twitter:card"');
    expect(body).toContain('name="description"');
    expect(body).toContain('type="application/ld+json"');
    expect(body).toContain('"@type":"WebSite"');
    expect(body).toContain('"@type":"ItemList"');
    expect(body).toContain('rel="alternate" type="application/rss+xml"');
  });

  it("renders an item page with its comments in the HTML and DiscussionForumPosting data", async () => {
    const { id, user } = await seed();
    await repo.addComment(id, user.id, "This is a great writeup about etching.");
    const res = await get(`/item/${id}/fabricating-a-mems-resonator`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("This is a great writeup about etching.");
    expect(body).toContain('"@type":"DiscussionForumPosting"');
    expect(body).toContain('"@type":"BreadcrumbList"');
    expect(body).toContain('property="og:type" content="article"');
  });

  it("redirects to the canonical slug so only one URL per story is indexable", async () => {
    const { id } = await seed();
    const bare = await get(`/item/${id}`);
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe(`/item/${id}/fabricating-a-mems-resonator`);

    const wrong = await get(`/item/${id}/some-other-slug`);
    expect(wrong.status).toBe(301);
    expect(wrong.headers.get("location")).toBe(`/item/${id}/fabricating-a-mems-resonator`);
  });

  it("serves robots.txt, sitemap.xml and an RSS feed", async () => {
    await seed();
    const robots = await get("/robots.txt");
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain("Sitemap: https://thebay.news/sitemap.xml");

    // /sitemap.xml is an INDEX now — story URLs live one hop down.
    const sitemap = await get("/sitemap.xml");
    expect(sitemap.headers.get("content-type")).toContain("application/xml");
    const indexXml = await sitemap.text();
    expect(indexXml).toContain("<sitemapindex");
    expect(indexXml).toContain("https://thebay.news/sitemap/1.xml");
    expect(await (await get("/sitemap/1.xml")).text()).toContain("https://thebay.news/item/");

    const feed = await get("/feed.xml");
    expect(feed.headers.get("content-type")).toContain("application/rss+xml");
    const rss = await feed.text();
    expect(rss).toContain("<title>thebay.news</title>");
    expect(rss).toContain("Fabricating a MEMS resonator");
  });

  it("exposes the admin ingest route ahead of the catch-all, gated by bearer token", async () => {
    // Registered after app.all("*") this returns the 404 PAGE instead of a 401 —
    // a shadowing bug that looks like a working site. Assert the gate, not the page.
    const noToken = await post("/api/admin/ingest-news", {});
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("content-type")).toContain("application/json");

    const wrong = await newsWorker.fetch(
      new Request("https://thebay.news/api/admin/ingest-news", {
        method: "POST", headers: { authorization: "Bearer nope" },
      }),
      { ...env, INGEST_TOKEN: "right" }, {} as any,
    );
    expect(wrong.status).toBe(401);
  });

  it("credits the source thread in the LIST, not only on the item page", async () => {
    await env.DB
      .prepare(
        `INSERT INTO stories (id,kind,title,url,url_hash,slug,origin,created_at)
         VALUES ('hn9','link','A front page story','https://ex.com/hn9','h9','a-front-page-story','hn',?)`,
      )
      .bind(new Date().toISOString())
      .run();
    await env.DB
      .prepare(
        `INSERT INTO story_sources (story_id,origin,external_id,external_url,external_points,external_comments,fetched_at)
         VALUES ('hn9','hn','9','https://news.ycombinator.com/item?id=9',412,88,?)`,
      )
      .bind(new Date().toISOString())
      .run();

    const body = await (await get("/?src=all")).text();
    expect(body).toContain("https://news.ycombinator.com/item?id=9");
    expect(body).toContain("HN 412");
    // …and it must not claim the story has zero support from our readers.
    expect(body).not.toMatch(/>0<\/span> points/);
  });

  it("degrades cleanly when realtime is unavailable, and rejects non-upgrade requests", async () => {
    // No NEWS_ROOM binding in the test env — the page must still work, and the
    // socket route must say so rather than throwing.
    expect((await get("/ws/item/abc")).status).toBe(426); // no Upgrade header
    const upgrade = await get("/ws/item/abc", { headers: { upgrade: "websocket" } });
    expect(upgrade.status).toBe(503);

    // And commenting still succeeds with no realtime available at all.
    const { id } = await seed();
    const cookie = await login();
    await post("/api/news/attest", SF, cookie);
    const res = await post(`/item/${id}/comment`, { body: "works without realtime" }, cookie, true);
    expect(res.status).toBe(303);
  });

  it("accepts a comment at the URL the RENDERED FORM actually posts to", async () => {
    // Regression: the form's action comes from itemPath() and includes the slug,
    // but only /item/:id/comment was registered — so every comment POST 404'd in
    // production. Posting to a hand-written route path hid it. Extract the action
    // from the real HTML and post THERE.
    const { id } = await seed();
    const cookie = await login();
    await post("/api/news/attest", SF, cookie);

    const page = await (await get(`/item/${id}/fabricating-a-mems-resonator`, { headers: { cookie } })).text();
    const action = /<form[^>]*action="([^"]+)"[^>]*data-comment-form/.exec(page)?.[1]
      ?? /<form[^>]*data-comment-form[^>]*action="([^"]+)"/.exec(page)?.[1];
    expect(action, "the comment form must render an action").toBeTruthy();
    expect(action).toContain("/comment");

    const res = await post(action!, { body: "posted at the form's own action" }, cookie, true);
    expect(res.status).toBe(303);

    const after = await (await get(`/item/${id}/fabricating-a-mems-resonator`)).text();
    expect(after).toContain("posted at the form&#39;s own action");
  });

  it("404s unknown paths instead of serving another page", async () => {
    const res = await get("/no/such/page");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("Nothing here");
    expect(body).toContain('name="robots" content="noindex');
  });

  it("stamps security headers on every response, including the 404", async () => {
    for (const path of ["/", "/no/such/page"]) {
      const res = await get(path);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    }
  });

  // ── the Bay gate ───────────────────────────────────────────────────────────

  it("lets anyone read but nobody anonymous write", async () => {
    const { id } = await seed();
    expect((await get("/")).status).toBe(200);
    expect((await get(`/item/${id}/fabricating-a-mems-resonator`)).status).toBe(200);
    expect((await post("/api/news/vote", { storyId: id })).status).toBe(401);

    // The submit PAGE sends a signed-out visitor to sign in — a 401 is correct
    // for an API and a dead end for a navigation. What must not happen is the
    // form being served, or a submission being accepted.
    const page = await get("/submit");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login");
    expect((await post("/submit", { title: "x", url: "https://ex.com/x" })).status).toBe(401);
  });

  it("refuses writes from outside the Bay and allows them from inside", async () => {
    const { id } = await seed();
    const cookie = await login();

    // Signed in, but no location proof yet.
    const blocked = await post("/api/news/vote", { storyId: id }, cookie);
    expect(blocked.status).toBe(403);
    expect((await blocked.json() as any).error).toBe("not_in_bay");

    // Los Angeles is not the Bay.
    const la = await post("/api/news/attest", LA, cookie);
    expect(la.status).toBe(403);
    expect((await post("/api/news/vote", { storyId: id }, cookie)).status).toBe(403);

    // San Francisco is.
    const sf = await post("/api/news/attest", SF, cookie);
    expect(sf.status).toBe(200);
    const voted = await post("/api/news/vote", { storyId: id }, cookie);
    expect(voted.status).toBe(200);
    expect((await voted.json() as any).votes).toBe(1);
  });

  it("counts a vote once however many times it is sent", async () => {
    const { id } = await seed();
    const cookie = await login();
    await post("/api/news/attest", SF, cookie);
    await post("/api/news/vote", { storyId: id }, cookie);
    const again = await post("/api/news/vote", { storyId: id }, cookie);
    expect((await again.json() as any).votes).toBe(1);
  });

  it("accepts a submission from inside the Bay and sends the submitter to the story", async () => {
    const cookie = await login();
    await post("/api/news/attest", SF, cookie);
    const res = await post("/submit", { title: "A new fab in Fremont", url: "https://ex.com/fab" }, cookie, true);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/item/");
    const body = await (await get("/")).text();
    expect(body).toContain("A new fab in Fremont");
  });

  it("sends a resubmitted link to the existing discussion rather than duplicating", async () => {
    const { id } = await seed();
    const cookie = await login("bob@x.com", "Bob");
    await post("/api/news/attest", SF, cookie);
    const res = await post(
      "/submit",
      { title: "MEMS again", url: "http://www.semiconductor-eng.com/mems/?utm_source=x" },
      cookie, true,
    );
    expect(res.headers.get("location")).toContain(`/item/${id}`);
    expect(res.headers.get("location")).toContain("dupe=1");
  });

  // ── escaping ───────────────────────────────────────────────────────────────

  it("never emits user content as live markup", async () => {
    const { user } = await seed();
    // Includes a double quote and a single quote, to prove attribute values can't
    // be broken out of either.
    const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>" autofocus onfocus="alert(3)' onload='alert(4)`;
    const { id } = await repo.submit(user.id, { kind: "text", title: evil, body: evil } as any);
    await repo.addComment(id, user.id, evil);

    for (const path of ["/", `/item/${id}`]) {
      const res = await get(path);
      const body = res.status === 301 ? await (await get(res.headers.get("location")!)).text() : await res.text();

      // Two different contexts with two different escaping rules, so assert them
      // separately. In MARKUP the invariant is that no tag and no attribute can
      // form from user input. (Literal text like "onerror=alert(2)" may appear
      // inside an escaped attribute value — with < and > as entities it's inert.)
      // JSON-LD is JSON, where \" is correct escaping and only </script> breaks
      // out; that's covered by its own test below.
      const markup = body.replace(/<script[\s\S]*?<\/script>/gi, "");
      expect(markup).not.toContain("<script>alert(1)");
      expect(markup).not.toContain("<img src=x");
      expect(markup).not.toContain('" autofocus');
      expect(markup).not.toContain("' onload=");
      expect(markup).toContain("&lt;script&gt;");
      expect(markup).toContain("&quot;");
    }
  });

  it("keeps a malicious title out of the JSON-LD script block", async () => {
    const { user } = await seed();
    const { id } = await repo.submit(
      user.id,
      { kind: "text", title: '</script><script>alert(1)</script>', body: "x" } as any,
    );
    const res = await get(`/item/${id}`);
    const body = res.status === 301 ? await (await get(res.headers.get("location")!)).text() : await res.text();
    const ld = body.slice(body.indexOf("application/ld+json"));
    expect(ld.slice(0, ld.indexOf("</script>"))).not.toContain("<script>alert(1)");
  });

  // ── filters ────────────────────────────────────────────────────────────────

  it("defaults the front page to our own stories and opens up on request", async () => {
    await seed();
    await env.DB
      .prepare(
        `INSERT INTO stories (id,kind,title,url,url_hash,origin,created_at)
         VALUES ('hn1','link','Something from HN','https://ex.com/hn','hh','hn',?)`,
      )
      .bind(new Date().toISOString())
      .run();

    const bay = await (await get("/")).text();
    expect(bay).toContain("Fabricating a MEMS resonator");
    expect(bay).not.toContain("Something from HN");

    const all = await (await get("/?src=all")).text();
    expect(all).toContain("Something from HN");
    expect(all).toContain("Fabricating a MEMS resonator");
  });
});

describe("sitemap covers the WHOLE catalog", () => {
  let env: any, repo: NewsRepo;
  const get = (path: string) => newsWorker.fetch(new Request("https://thebay.news" + path), env, {} as any);
  beforeEach(() => {
    ({ env } = makeTestEnv({ NEWS_ORIGIN: "https://thebay.news", PUBLIC_ORIGIN: "https://thebay.events" }));
    repo = new NewsRepo(env.DB);
  });

  /**
   * The old sitemap listed the 2,000 newest stories. Production passed 4,000, so
   * half the site was undiscoverable — and the cap would have hidden a larger
   * share every day the catalog grew, silently, forever.
   */
  it("indexes enough files to reach every story", async () => {
    // 2,400 stories = 3 pages at 1,000 per file.
    const rows = Array.from({ length: 2400 }, (_, i) => ({
      origin: "rss" as const, externalId: `s${i}`, title: `Story ${i}`,
      url: `https://ex.com/${i}`, externalUrl: null, points: null, comments: null,
      createdAt: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 60_000).toISOString(),
      author: null, topics: [],
    }));
    await repo.upsertIngested(rows as any);

    const index = await get("/sitemap.xml");
    expect(index.status).toBe(200);
    const xml = await index.text();
    expect(xml).toContain("<sitemapindex");
    const files = (xml.match(/<sitemap>/g) ?? []).length;
    expect(files).toBe(1 + 3); // pages + 3 story files

    // Every story URL must appear across the files — that is the whole point.
    const seen = new Set<string>();
    for (let p = 1; p <= 3; p++) {
      const res = await get(`/sitemap/${p}.xml`);
      expect(res.status).toBe(200);
      for (const m of (await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)) seen.add(m[1]!);
    }
    expect(seen.size).toBe(2400);
  });

  it("orders oldest-first so full pages never change again", async () => {
    const mk = (i: number, when: string) => ({
      origin: "rss" as const, externalId: `x${i}`, title: `T${i}`, url: `https://ex.com/x${i}`,
      externalUrl: null, points: null, comments: null, createdAt: when, author: null, topics: [],
    });
    await repo.upsertIngested([mk(1, "2026-01-01T00:00:00.000Z"), mk(2, "2026-02-01T00:00:00.000Z")] as any);
    const before = await (await get("/sitemap/1.xml")).text();

    // A newer story arrives. Newest-first would push everything down a slot.
    await repo.upsertIngested([mk(3, "2026-03-01T00:00:00.000Z")] as any);
    const after = await (await get("/sitemap/1.xml")).text();

    const locs = (s: string) => [...s.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs(after).slice(0, 2)).toEqual(locs(before)); // existing entries did not move
  });

  it("404s a page number the index never offered", async () => {
    expect((await get("/sitemap/99.xml")).status).toBe(404);
  });

  it("still serves the static pages file, and robots still points at the index", async () => {
    const pages = await get("/sitemap-pages.xml");
    expect(pages.status).toBe(200);
    const body = await pages.text();
    for (const p of ["/", "/newest", "/about"]) expect(body).toContain(`<loc>https://thebay.news${p}</loc>`);
    expect(await (await get("/robots.txt")).text()).toContain("/sitemap.xml");
  });
});
