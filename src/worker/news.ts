/**
 * thebay.news — the news Worker.
 *
 * A SEPARATE Worker from thebay.events, deliberately. `run_worker_first` has no
 * host dimension and `not_found_handling` resolves to the root index.html, so one
 * Worker serving two domains would either force the events site through the
 * Worker for every request or silently serve the events dashboard on news URLs
 * (verified: thebay.events/item/123 returns 200 + the dashboard today). Splitting
 * them means the events Worker's asset routing is untouched and a news outage
 * cannot reach it.
 *
 * The two share everything that matters: the same D1, the same KV sessions, the
 * same accounts and social graph, and the same code in src/.
 *
 * Pages are SERVER-RENDERED. Social crawlers never run JavaScript, and a news
 * site lives or dies on how its links preview.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Vars } from "./env";
import type { ScheduledController, ExecutionContext } from "@cloudflare/workers-types";
import { harden } from "./security";
import { runNewsIngest } from "../news/ingest";
import { canonicalOrigin, newsOrigin, apexRedirectUrl } from "./origin";
import { authRoutes } from "./routes/auth";
import { optionalAuth, requireAuth } from "../auth/middleware";
import { NewsRepo, type Story } from "../storage/d1/news-repo";
import { attestLocation, hasAttestation } from "../news/attest";
import { LIMITS, rateVerdict } from "../news/ratelimit";
import { NewsFilterSchema, StorySubmitSchema, CommentCreateSchema, GeoAttestSchema } from "../../shared/schema";
import { html, raw, toHtml } from "../news/render/escape";
import { page } from "../news/render/layout";
import { storyList, filterBar, itemPath } from "../news/render/story";
import { itemPage } from "../news/render/item";
import { excerpt } from "../news/render/text";
import { rfc822 } from "../news/render/time";
import {
  discussionJsonLd, itemListJsonLd, siteJsonLd, breadcrumbJsonLd, clampDescription, SITE_NAME,
} from "../news/render/head";

type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;

const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

/* eslint-disable @typescript-eslint/no-explicit-any */
const repo = (c: { env: Env }) => new NewsRepo(c.env.DB);

// ── asset manifest ───────────────────────────────────────────────────────────
// build-news content-hashes the CSS/JS so they can be cached immutably. The
// Worker reads the manifest once per isolate rather than hardcoding filenames.
let ASSETS_CACHE: { css: string; js: string } | null = null;
async function assets(env: Env): Promise<{ css: string; js: string }> {
  if (ASSETS_CACHE) return ASSETS_CACHE;
  try {
    const res = await env.ASSETS.fetch(new Request("https://assets.local/asset-manifest.json"));
    if (res.ok) {
      const m: any = await res.json();
      if (m?.css && m?.js) return (ASSETS_CACHE = { css: m.css, js: m.js });
    }
  } catch { /* fall through to unhashed names */ }
  return { css: "/news.css", js: "/news.js" };
}

// ── chrome ───────────────────────────────────────────────────────────────────
async function chromeFor(c: any, active: "top" | "new" | "submit" | null = null) {
  const user = c.get("user") ?? null;
  return {
    user: user ? { displayName: user.displayName, handle: user.handle } : null,
    inBay: user ? await hasAttestation(c.env, user.id) : false,
    eventsOrigin: canonicalOrigin(c.env),
    assets: await assets(c.env),
    active,
  };
}

const htmlResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

// ── middleware ───────────────────────────────────────────────────────────────
app.use("*", async (c, next) => {
  // www.thebay.news → thebay.news, before anything else looks at the path.
  const apex = apexRedirectUrl(c.req.url);
  if (apex) return harden(c.redirect(apex, 301));

  const visitor = c.req.header("cf-visitor") || "";
  if (visitor.includes('"scheme":"http"')) {
    const u = new URL(c.req.url);
    u.protocol = "https:";
    return harden(c.redirect(u.toString(), 301));
  }
  await next();
  c.res = harden(c.res);
});

app.use("/api/*", cors({ origin: "*" }));

app.onError((err, c) => {
  const msg = String((err as Error)?.message || err);
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/auth/")) {
    if (/FOREIGN KEY|constraint|UNIQUE/i.test(msg)) return harden(c.json({ error: "conflict" }, 409));
    return harden(c.json({ error: "server_error" }, 500));
  }
  return harden(htmlResponse("<h1>Something went wrong</h1><p><a href=\"/\">Back to thebay.news</a></p>", 500));
});

// Shared auth: the same accounts, the same session cookie mechanism, scoped to
// this host. Mounted first so /auth/* never falls through to a page route.
app.route("/", authRoutes());

// ── rate limiting ────────────────────────────────────────────────────────────
/** Best-effort KV counter. Not atomic — good enough to stop flooding, which is
 *  all a rate limit needs to do; the real invariants are in the schema. */
async function underLimit(env: Env, userId: string, kind: keyof typeof LIMITS): Promise<boolean> {
  const limit = LIMITS[kind];
  const bucket = Math.floor(Date.now() / (limit.windowSeconds * 1000));
  const key = `rl:${kind}:${userId}:${bucket}`;
  const n = parseInt((await env.SESSIONS.get(key)) || "0", 10) || 0;
  const verdict = rateVerdict({ inWindow: n, limit });
  if (verdict.ok) await env.SESSIONS.put(key, String(n + 1), { expirationTtl: limit.windowSeconds * 2 });
  return verdict.ok;
}

/** Every write requires a signed-in user who has proved they're in the Bay. */
async function gateWrite(c: any, kind: keyof typeof LIMITS): Promise<Response | null> {
  const user = c.get("user")!;
  if (!(await hasAttestation(c.env, user.id))) {
    return c.json({ error: "not_in_bay", message: "You must be in the Bay Area to post here." }, 403);
  }
  if (!(await underLimit(c.env, user.id, kind))) {
    return c.json({ error: "rate_limited", message: "Slow down a moment." }, 429);
  }
  return null;
}

// ── front page ───────────────────────────────────────────────────────────────
async function renderFeed(c: any, forcedSort?: "new") {
  const q = c.req.query();
  const parsed = NewsFilterSchema.safeParse({ ...q, ...(forcedSort ? { sort: forcedSort } : {}) });
  const f = parsed.success ? parsed.data : NewsFilterSchema.parse({});
  const user = c.get("user") ?? null;
  const nowMs = Date.now();

  const { stories } = await repo(c).feed(
    { src: f.src, sort: f.sort, topic: f.topic, limit: f.limit, offset: f.offset },
    user?.id ?? null,
    nowMs,
  );

  const origin = newsOrigin(c.env);
  const chrome = await chromeFor(c, forcedSort === "new" ? "new" : "top");
  const body = html`${filterBar({ src: f.src, sort: f.sort, topic: f.topic })}
${storyList(stories, { nowMs, signedIn: !!user, offset: f.offset })}
${stories.length >= f.limit
    ? html`<div class="pager">
        <a class="btn btn-quiet" href="${pagerHref(f, f.offset + f.limit)}">more →</a>
      </div>`
    : ""}`;

  const title = f.src === "bay" ? SITE_NAME : `${f.src} · ${SITE_NAME}`;
  return htmlResponse(
    page(
      {
        title: f.src === "bay" && f.sort === "hot"
          ? "The Bay, in one page"
          : title,
        description:
          "Bay Area tech news — submitted, ranked and discussed by the people actually here. Hardware, early-stage venture, mathematics and software.",
        canonical: origin + (forcedSort === "new" ? "/newest" : "/"),
        ogType: "website",
        feedUrl: origin + "/feed.xml",
        jsonLd: [
          siteJsonLd(origin),
          itemListJsonLd(origin, stories.map((s) => ({ url: origin + itemPath(s), title: s.title }))),
        ],
      },
      chrome,
      body,
    ),
  );
}

function pagerHref(f: any, offset: number): string {
  const p = new URLSearchParams();
  if (f.src !== "bay") p.set("src", f.src);
  if (f.sort !== "hot") p.set("sort", f.sort);
  if (f.topic) p.set("topic", f.topic);
  if (offset) p.set("offset", String(offset));
  const s = p.toString();
  return s ? `/?${s}` : "/";
}

app.get("/", optionalAuth, (c) => renderFeed(c));
app.get("/newest", optionalAuth, (c) => renderFeed(c, "new"));

// ── item page ────────────────────────────────────────────────────────────────
async function renderItem(c: any) {
  const id = c.req.param("id");
  const user = c.get("user") ?? null;
  const story = await repo(c).getStory(id, user?.id ?? null);
  if (!story) return notFound(c);

  // Canonical URL always carries the slug; a slug-less or wrong-slug request
  // redirects so search engines only ever index one URL per story.
  const wantPath = itemPath(story);
  const gotPath = new URL(c.req.url).pathname;
  if (gotPath !== wantPath) return c.redirect(wantPath, 301);

  const comments = await repo(c).comments(id);
  const origin = newsOrigin(c.env);
  const chrome = await chromeFor(c);
  const canonical = origin + wantPath;

  const body = itemPage(story, comments, {
    nowMs: Date.now(),
    signedIn: !!user,
    inBay: chrome.inBay,
    eventsOrigin: chrome.eventsOrigin,
    // Only worth a lookup when the story is actually about an event.
    attendees: story.eventId ? await repo(c).attendeesOf(story.eventId) : undefined,
  });

  return htmlResponse(
    page(
      {
        title: story.title,
        description: clampDescription(story.summary || story.description || excerpt(story.body) || story.title),
        canonical,
        ogType: "article",
        image: story.imageUrl,
        imageAlt: story.title,
        publishedAt: story.publishedAt || story.createdAt,
        author: story.author,
        feedUrl: origin + "/feed.xml",
        jsonLd: [
          discussionJsonLd({
            url: canonical,
            headline: story.title,
            datePublished: story.createdAt,
            author: story.author,
            text: story.body || story.summary || undefined,
            upvotes: story.voteCount,
            comments: comments.filter((x) => !x.dead).map((x) => ({
              author: x.author, text: x.body, datePublished: x.createdAt,
            })),
          }),
          breadcrumbJsonLd([
            { name: SITE_NAME, url: origin + "/" },
            { name: story.title, url: canonical },
          ]),
        ],
      },
      chrome,
      body,
    ),
  );
}

app.get("/item/:id", optionalAuth, renderItem);
app.get("/item/:id/:slug", optionalAuth, renderItem);

// Comment via a real form POST, so the thread works with JavaScript disabled.
app.post("/item/:id/comment", requireAuth, async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody().catch(() => ({} as any));
  const parsed = CommentCreateSchema.safeParse({
    body: String((form as any).body ?? ""),
    parentId: (form as any).parentId ? String((form as any).parentId) : undefined,
  });
  if (!parsed.success) return c.redirect(`/item/${id}`, 303);

  const gate = await gateWrite(c, "comment");
  if (gate) return gate;

  const user = c.get("user")!;
  const res = await repo(c).addComment(id, user.id, parsed.data.body, parsed.data.parentId ?? null);
  if ("error" in res) return c.redirect(`/item/${id}`, 303);

  // Tell anyone already reading this thread. Best-effort: a realtime failure must
  // never fail the write that already succeeded.
  await fanOutComment(c, id, { id: res.id, author: user.displayName, handle: user.handle });

  return c.redirect(`/item/${id}#${res.id}`, 303);
});

/** Push a new comment to readers currently on the page. Never throws. */
async function fanOutComment(c: any, storyId: string, payload: unknown): Promise<void> {
  try {
    const ns = c.env.NEWS_ROOM;
    if (!ns) return; // binding absent (e.g. tests) — the page still works
    const stub = ns.get(ns.idFromName(storyId));
    await stub.fetch(new Request("https://news-room/comment", { method: "POST", body: JSON.stringify(payload) }));
  } catch {
    /* realtime is an enhancement, not a guarantee */
  }
}

// Live thread socket: presence + new comments.
app.get("/ws/item/:id", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.text("expected websocket", 426);
  const ns = c.env.NEWS_ROOM;
  if (!ns) return c.text("realtime unavailable", 503);
  const stub = ns.get(ns.idFromName(c.req.param("id")));
  return stub.fetch(new Request("https://news-room/ws", { headers: c.req.raw.headers }));
});

// ── submit ───────────────────────────────────────────────────────────────────
function submitForm(c: any, chrome: any, values: any = {}, error?: string) {
  const body = html`<h1 class="item-title serif" style="margin-top:22px">Submit a story</h1>
${error ? html`<div class="notice notice-warn"><strong>${error}</strong></div>` : ""}
${!chrome.inBay
      ? html`<div class="notice notice-warn">
          <strong>Posting is for people in the Bay.</strong>
          Reading is open to everyone, but submitting needs a location check.
          <button class="toggle" type="button" data-attest style="margin-left:6px">Check my location</button>
        </div>`
      : ""}
<form method="post" action="/submit" style="margin-top:18px">
  <label class="field"><span>Title</span>
    <input class="input" name="title" maxlength="200" required value="${values.title ?? ""}" autofocus>
  </label>
  <label class="field"><span>URL</span>
    <input class="input" name="url" type="url" maxlength="2000" placeholder="https://" value="${values.url ?? ""}">
  </label>
  <label class="field"><span>or text</span>
    <textarea class="input" name="body" maxlength="8000" placeholder="Leave the URL blank and write something instead.">${values.body ?? ""}</textarea>
  </label>
  <button class="btn" type="submit">Submit</button>
</form>
<p style="color:var(--muted);font-size:13px;margin-top:18px">
  One story per link — if it's already here you'll be taken to the existing discussion.
</p>`;
  return htmlResponse(
    page(
      { title: "Submit", canonical: newsOrigin(c.env) + "/submit", noindex: true, description: "Submit a story to thebay.news." },
      chrome,
      body,
    ),
  );
}

app.get("/submit", requireAuth, async (c) => submitForm(c, await chromeFor(c, "submit")));

app.post("/submit", requireAuth, async (c) => {
  const form = await c.req.parseBody().catch(() => ({} as any));
  const url = String((form as any).url ?? "").trim();
  const bodyText = String((form as any).body ?? "").trim();
  const input = {
    kind: url ? "link" : "text",
    title: String((form as any).title ?? "").trim(),
    url: url || undefined,
    body: bodyText || undefined,
  };
  const parsed = StorySubmitSchema.safeParse(input);
  const chrome = await chromeFor(c, "submit");
  if (!parsed.success) {
    return submitForm(c, chrome, input, parsed.error.issues[0]?.message ?? "That submission isn't valid.");
  }

  if (!chrome.inBay) return submitForm(c, chrome, input, "You must be in the Bay Area to post here.");
  if (!(await underLimit(c.env, c.get("user")!.id, "submit"))) {
    return submitForm(c, chrome, input, "You've submitted a lot recently — try again later.");
  }

  const { id, duplicate } = await repo(c).submit(c.get("user")!.id, parsed.data as any);
  const story = await repo(c).getStory(id);
  return c.redirect(story ? itemPath(story) + (duplicate ? "?dupe=1" : "") : `/item/${id}`, 303);
});

// ── JSON endpoints for the island ────────────────────────────────────────────
app.post("/api/news/vote", requireAuth, async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const storyId = String(b.storyId ?? "");
  if (!storyId) return c.json({ error: "bad_request" }, 400);

  const gate = await gateWrite(c, "vote");
  if (gate) return gate;

  const userId = c.get("user")!.id;
  if (b.on === false) await repo(c).unvote(storyId, userId);
  else await repo(c).vote(storyId, userId);

  const story = await repo(c).getStory(storyId, userId);
  if (!story) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, votes: story.voteCount, didVote: !!story.didVote });
});

app.post("/api/news/attest", requireAuth, async (c) => {
  const parsed = GeoAttestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad_request" }, 400);
  const ok = await attestLocation(c.env, c.get("user")!.id, parsed.data.lat, parsed.data.lng);
  return c.json({ ok }, ok ? 200 : 403);
});

/** Public read API, same spirit as thebay.events' open events API. */
app.get("/api/news/feed", optionalAuth, async (c) => {
  const f = NewsFilterSchema.parse(c.req.query());
  const user = c.get("user") ?? null;
  const { stories, total } = await repo(c).feed(f, user?.id ?? null);
  c.header("cache-control", "public, max-age=30");
  return c.json({ total, stories });
});

// ── login ────────────────────────────────────────────────────────────────────
app.get("/login", optionalAuth, async (c) => {
  const chrome = await chromeFor(c);
  const events = chrome.eventsOrigin;
  const body = html`<h1 class="item-title serif" style="margin-top:22px">Sign in</h1>
<p style="color:var(--muted);max-width:56ch">
  thebay.news and thebay.events share one account. Sign in on the events side and
  you'll be brought straight back here.
</p>
<p style="margin-top:20px">
  <a class="btn" href="${events}/auth/handoff/start?next=${encodeURIComponent(new URL(c.req.url).searchParams.get("next") || "/")}">
    Continue with The Bay →
  </a>
</p>`;
  return htmlResponse(page({ title: "Sign in", canonical: newsOrigin(c.env) + "/login", noindex: true }, chrome, body));
});

app.get("/about", optionalAuth, async (c) => {
  const chrome = await chromeFor(c);
  const body = html`<h1 class="item-title serif" style="margin-top:22px">About</h1>
<div class="item-body">
  <p><strong>thebay.news</strong> is a news page for the San Francisco Bay Area tech community —
  the reading half of <a href="${chrome.eventsOrigin}">thebay.events</a>.</p>
  <p>Anyone anywhere can read it. Posting, commenting and voting are open to people
  physically in the Bay, because a local paper should be written by locals.</p>
  <p>The front page defaults to <em>our</em> stories. Hacker News, Lobsters and a set of
  feeds are aggregated alongside and clearly marked — we link to the original article
  and credit their discussion, never copy it.</p>
</div>`;
  return htmlResponse(
    page({ title: "About", canonical: newsOrigin(c.env) + "/about", description: "What thebay.news is and who it's for." }, chrome, body),
  );
});

// ── feeds, sitemap, robots ───────────────────────────────────────────────────
app.get("/feed.xml", async (c) => {
  const origin = newsOrigin(c.env);
  const stories = (await repo(c).recent(50)).filter((s) => s.origin === "bay" || s.origin === "event");
  const items = stories
    .map((s: Story) => {
      const link = origin + itemPath(s);
      return `  <item>
    <title>${xml(s.title)}</title>
    <link>${xml(link)}</link>
    <guid isPermaLink="true">${xml(link)}</guid>
    <pubDate>${rfc822(s.createdAt)}</pubDate>
    <description>${xml(s.summary || s.description || excerpt(s.body) || s.title)}</description>
  </item>`;
    })
    .join("\n");
  c.header("content-type", "application/rss+xml; charset=utf-8");
  c.header("cache-control", "public, max-age=600");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${SITE_NAME}</title>
  <link>${origin}/</link>
  <atom:link href="${origin}/feed.xml" rel="self" type="application/rss+xml"/>
  <description>Bay Area tech news, submitted and discussed by the people actually here.</description>
  <language>en-us</language>
${items}
</channel>
</rss>`);
});

app.get("/sitemap.xml", async (c) => {
  const origin = newsOrigin(c.env);
  const stories = await repo(c).recent(2000);
  const urls = [
    `  <url><loc>${origin}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`,
    `  <url><loc>${origin}/newest</loc><changefreq>hourly</changefreq><priority>0.8</priority></url>`,
    `  <url><loc>${origin}/about</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>`,
    ...stories.map(
      (s) => `  <url><loc>${xml(origin + itemPath(s))}</loc><lastmod>${xml(s.createdAt.slice(0, 10))}</lastmod></url>`,
    ),
  ].join("\n");
  c.header("content-type", "application/xml; charset=utf-8");
  c.header("cache-control", "public, max-age=3600");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`);
});

app.get("/robots.txt", (c) => {
  const origin = newsOrigin(c.env);
  c.header("content-type", "text/plain; charset=utf-8");
  return c.body(`User-agent: *
Allow: /
Disallow: /submit
Disallow: /login
Disallow: /api/
Disallow: /auth/

Sitemap: ${origin}/sitemap.xml
`);
});

const xml = (s: unknown) =>
  String(s ?? "").replace(/[<>&'"]/g, (ch) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[ch]!);

// ── admin ────────────────────────────────────────────────────────────────────
// Run ingestion on demand (the same work the cron does). Bearer-gated with the
// same INGEST_TOKEN the events Worker's admin routes use.
// MUST be registered before the app.all("*") catch-all below, or the 404 handler
// shadows it.
app.post("/api/admin/ingest-news", async (c) => {
  const token = c.env.INGEST_TOKEN;
  if (!token || c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
  return c.json({ ok: true, ...(await runNewsIngest(c.env)) });
});

// ── static assets + 404 ──────────────────────────────────────────────────────
app.get("/assets/*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/icon.svg", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/news.css", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/news.js", (c) => c.env.ASSETS.fetch(c.req.raw));

async function notFound(c: any) {
  const chrome = await chromeFor(c);
  const body = html`<div class="empty">
    <h2 class="serif">Nothing here</h2>
    <p>That page doesn't exist — or the tide took it.</p>
    <p style="margin-top:14px"><a class="btn btn-quiet" href="/">Back to the front page</a></p>
  </div>`;
  return htmlResponse(
    page({ title: "Not found", canonical: newsOrigin(c.env) + "/", noindex: true }, chrome, body),
    404,
  );
}

app.all("*", optionalAuth, (c) => notFound(c));

export default {
  fetch: app.fetch,
  /**
   * Every 15 minutes: pull HN, Lobsters and the configured feeds, turn upcoming
   * events into discussable stories, and summarize what's new. Wrapped in
   * waitUntil so a slow feed can't hold the scheduled invocation open, and
   * try/caught so a bad run is logged rather than throwing into the runtime.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runNewsIngest(env)
        .then((r) => console.log("news ingest", JSON.stringify(r)))
        .catch((err) => console.error("news ingest failed", String(err))),
    );
  },
};

export { NewsRoom } from "../realtime/news-room";
export { app as newsApp };
export { toHtml, raw };
