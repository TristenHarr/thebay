#!/usr/bin/env node
/**
 * Production smoke for thebay.news.
 *
 * The assertions that matter most here are the ones a normal functional test
 * can't see: that a crawler with no JavaScript gets the whole page, and that the
 * news domain never serves the events site (the silent-wrong-site failure mode
 * that motivated splitting the Workers in the first place).
 *
 *   node tests/news-prod-e2e.mjs
 *   NEWS_BASE=http://127.0.0.1:8788 node tests/news-prod-e2e.mjs
 */
const NEWS = (process.env.NEWS_BASE || "https://thebay.news").replace(/\/+$/, "");
const EVENTS = (process.env.BASE || "https://thebay.events").replace(/\/+$/, "");

let passed = 0, failed = 0;
const ok = (name) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
const bad = (name, detail) => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); };
const check = (name, cond, detail) => (cond ? ok(name) : bad(name, detail));
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/** Fetch with a timeout and one retry — this network is intermittently flaky. */
async function get(path, init = {}) {
  const url = path.startsWith("http") ? path : NEWS + path;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      const res = await fetch(url, { redirect: "manual", signal: ctl.signal, ...init });
      clearTimeout(timer);
      const body = res.headers.get("content-type")?.includes("application/json") || /\.(json)$/.test(path)
        ? await res.text() : await res.text();
      return { status: res.status, headers: res.headers, body };
    } catch (err) {
      if (attempt === 1) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

(async () => {
  console.log(`\n\x1b[1mthebay.news production smoke\x1b[0m  (${NEWS})`);

  section("1 · Server-rendered content (what a crawler sees)");
  const front = await get("/");
  check("front page 200", front.status === 200, `got ${front.status}`);
  check("is HTML", (front.headers.get("content-type") || "").includes("text/html"));
  check("closes the document", front.body.includes("</html>"));
  const titles = [...front.body.matchAll(/<h2 class="story-title">\s*<a[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
  check("story titles present WITHOUT javascript", titles.length > 0, `found ${titles.length}`);
  check("story metadata rendered server-side", /class="story-meta/.test(front.body));

  section("2 · The bundle actually exists (catches build-order regressions)");
  const css = /href="(\/assets\/news\.[a-f0-9]+\.css)"/.exec(front.body)?.[1];
  const js = /src="(\/assets\/news\.[a-f0-9]+\.js)"/.exec(front.body)?.[1];
  check("hashed CSS referenced", !!css, "no /assets/news.*.css in the HTML");
  check("hashed JS referenced", !!js, "no /assets/news.*.js in the HTML");
  if (css) check("CSS 200s", (await get(css)).status === 200);
  if (js) check("JS 200s", (await get(js)).status === 200);

  section("3 · SEO surface");
  check("canonical URL", front.body.includes(`<link rel="canonical" href="${NEWS}/"`));
  check("meta description", /<meta name="description" content="[^"]{20,}"/.test(front.body));
  check("OpenGraph title", /property="og:title"/.test(front.body));
  check("OpenGraph site_name", /property="og:site_name" content="thebay\.news"/.test(front.body));
  check("Twitter card", /name="twitter:card"/.test(front.body));
  check("indexable", /name="robots" content="index/.test(front.body));
  check("JSON-LD WebSite", front.body.includes('"@type":"WebSite"'));
  check("JSON-LD ItemList", front.body.includes('"@type":"ItemList"'));
  check("RSS advertised", /rel="alternate" type="application\/rss\+xml"/.test(front.body));

  section("4 · Item page + canonical slug");
  const href = /<h2 class="story-title">\s*<a href="(\/item\/[^"]+)"/.exec(front.body)?.[1]
    || /href="(\/item\/[^"#]+)"/.exec(front.body)?.[1];
  if (!href) {
    bad("found an item link on the front page");
  } else {
    const item = await get(href);
    check("item page 200", item.status === 200, `got ${item.status} for ${href}`);
    check("JSON-LD DiscussionForumPosting", item.body.includes('"@type":"DiscussionForumPosting"'));
    check("og:type=article", /property="og:type" content="article"/.test(item.body));
    const id = href.split("/")[2];
    const bare = await get(`/item/${id}`);
    check("slug-less URL 301s to canonical", bare.status === 301, `got ${bare.status}`);
  }

  section("5 · Feeds, sitemap, robots");
  const feed = await get("/feed.xml");
  check("feed.xml 200 + rss content-type", feed.status === 200 && (feed.headers.get("content-type") || "").includes("rss"));
  const sitemap = await get("/sitemap.xml");
  check("sitemap.xml 200", sitemap.status === 200);
  check("sitemap lists story URLs", sitemap.body.includes(`${NEWS}/item/`));
  const robots = await get("/robots.txt");
  check("robots.txt points at the NEWS sitemap", robots.body.includes(`Sitemap: ${NEWS}/sitemap.xml`));
  check("robots disallows /submit and /api", robots.body.includes("Disallow: /submit") && robots.body.includes("Disallow: /api/"));

  section("6 · Filters");
  for (const src of ["all", "hn", "lobsters", "rss", "event"]) {
    const r = await get(`/?src=${src}`);
    check(`?src=${src} 200`, r.status === 200);
  }
  const api = await get("/api/news/feed?src=all&limit=5");
  let parsed = null;
  try { parsed = JSON.parse(api.body); } catch { /* handled below */ }
  check("public JSON feed returns stories", !!parsed?.stories?.length, `total=${parsed?.total}`);

  section("7 · Security + gates");
  check("HSTS", !!front.headers.get("strict-transport-security"));
  check("nosniff", front.headers.get("x-content-type-options") === "nosniff");
  check("Referrer-Policy", !!front.headers.get("referrer-policy"));
  const notFound = await get("/definitely/not/a/page");
  check("unknown path 404s", notFound.status === 404, `got ${notFound.status}`);
  check("404 is noindex", /name="robots" content="noindex/.test(notFound.body));
  check("submit requires auth", (await get("/submit")).status === 401);
  const vote = await get("/api/news/vote", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("vote requires auth", vote.status === 401, `got ${vote.status}`);
  const admin = await get("/api/admin/ingest-news", { method: "POST" });
  check("admin ingest requires bearer", admin.status === 401, `got ${admin.status}`);
  check("websocket route rejects non-upgrade", (await get("/ws/item/x")).status === 426);

  section("8 · The two sites are distinct (the silent-wrong-site check)");
  check("news does NOT serve the events dashboard", !front.body.includes("events.json") && !/id="app"/.test(front.body));
  check("news brand present", front.body.includes("the.bay"));
  check("news links back to events", front.body.includes(EVENTS));
  const eventsHome = await get(EVENTS + "/");
  check("events site still 200s", eventsHome.status === 200);
  check("events site is NOT the news page", !eventsHome.body.includes("≈ thebay.news"));

  console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed  (${NEWS})`);
  if (failed === 0) console.log("\x1b[32mthebay.news is live, indexable, and readable without JavaScript.\x1b[0m\n");
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error("\x1b[31msmoke run failed:\x1b[0m", err);
  process.exit(1);
});
