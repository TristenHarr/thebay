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
import { PushPayloadSchema } from "../news/ingest/push";
import { canonicalOrigin, newsOrigin, apexRedirectUrl } from "./origin";
import { authRoutes } from "./routes/auth";
import { optionalAuth, requireAuth } from "../auth/middleware";
import { NewsRepo, type Story } from "../storage/d1/news-repo";
import { ModerationRepo } from "../storage/d1/moderation-repo";
import { requireAdmin, isAdmin } from "../auth/admin";
import { attestLocation, hasAttestation } from "../news/attest";
import { LIMITS, rateVerdict, waitMessage, type Limit } from "../news/ratelimit";
import { NewsFilterSchema, StorySubmitSchema, CommentCreateSchema, GeoAttestSchema } from "../../shared/schema";
import { html, raw, toHtml } from "../news/render/escape";
import { page } from "../news/render/layout";
import { storyList, filterBar, itemPath } from "../news/render/story";
import { itemPage } from "../news/render/item";
import { excerpt, formatBody } from "../news/render/text";
import { rfc822, timeAgo } from "../news/render/time";
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
/**
 * Per-hour cap AND cooldown. Best-effort KV — good enough to stop flooding,
 * which is all this needs to do; the real invariants live in the schema.
 *
 * This is the ONLY automatic enforcement on the site. It is content-neutral by
 * construction: it knows how often you acted, never what you said.
 */
async function checkRate(env: Env, userId: string, kind: keyof typeof LIMITS): Promise<{ ok: boolean; retryAfter: number }> {
  // Widened to Limit: `vote` has no cooldown, so the literal union lacks the key.
  const limit: Limit = LIMITS[kind];
  const nowMs = Date.now();
  const bucket = Math.floor(nowMs / (limit.windowSeconds * 1000));
  const countKey = `rl:${kind}:${userId}:${bucket}`;
  const lastKey = `rl:last:${kind}:${userId}`;

  const [countRaw, lastRaw] = await Promise.all([env.SESSIONS.get(countKey), env.SESSIONS.get(lastKey)]);
  const n = parseInt(countRaw || "0", 10) || 0;
  const lastMs = parseInt(lastRaw || "0", 10) || 0;
  const sinceLastSeconds = lastMs ? (nowMs - lastMs) / 1000 : Infinity;

  const verdict = rateVerdict({ inWindow: n, limit, sinceLastSeconds });
  if (verdict.ok) {
    await Promise.all([
      env.SESSIONS.put(countKey, String(n + 1), { expirationTtl: limit.windowSeconds * 2 }),
      env.SESSIONS.put(lastKey, String(nowMs), { expirationTtl: Math.max(60, (limit.cooldownSeconds ?? 60) * 4) }),
    ]);
  }
  return { ok: verdict.ok, retryAfter: verdict.retryAfterSeconds };
}

/**
 * Every write requires: a signed-in user, not banned, physically in the Bay, and
 * within the rate limits. Note what is NOT here — no content inspection at all.
 */
async function gateWrite(c: any, kind: keyof typeof LIMITS): Promise<Response | null> {
  const user = c.get("user")!;

  // A ban blocks writing only. Reading stays open and prior contributions stand.
  if (await new ModerationRepo(c.env.DB).isBanned(user.id)) {
    return c.json({ error: "banned", message: "Your account can't post right now." }, 403);
  }
  if (!(await hasAttestation(c.env, user.id))) {
    return c.json({ error: "not_in_bay", message: "You must be in the Bay Area to post here." }, 403);
  }
  const rate = await checkRate(c.env, user.id, kind);
  if (!rate.ok) {
    // Say exactly how long to wait — a vague refusal reads as a judgement.
    c.header("retry-after", String(rate.retryAfter));
    return c.json(
      { error: "rate_limited", retryAfter: rate.retryAfter, message: `You can do that again in ${waitMessage(rate.retryAfter)}.` },
      429,
    );
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
//
// Registered for BOTH shapes. The form's action is built from itemPath(), which
// includes the slug — so `/item/:id/comment` alone leaves the rendered form
// posting to a 404. Accepting both keeps old links working too.
const commentHandler = async (c: any) => {
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
};

app.post("/item/:id/comment", requireAuth, commentHandler);
app.post("/item/:id/:slug/comment", requireAuth, commentHandler);

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

  if (await new ModerationRepo(c.env.DB).isBanned(c.get("user")!.id)) {
    return submitForm(c, chrome, input, "Your account can't post right now.");
  }
  if (!chrome.inBay) return submitForm(c, chrome, input, "You must be in the Bay Area to post here.");
  const rate = await checkRate(c.env, c.get("user")!.id, "submit");
  if (!rate.ok) {
    return submitForm(c, chrome, input, `You can submit again in ${waitMessage(rate.retryAfter)}.`);
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

// ── flags ────────────────────────────────────────────────────────────────────
// A flag is a SIGNAL, not an action. It never hides anything at any count; it
// only sorts the queue a human reviews. Same gate as any other write, so it's
// rate-limited and can't be used to brigade.
app.post("/api/news/flag", requireAuth, async (c) => {
  const b: any = await c.req.json().catch(() => ({}));
  const targetType = b.targetType === "comment" ? "comment" : "story";
  const targetId = String(b.targetId ?? "");
  const reason = ["spam", "off_topic", "abuse", "duplicate", "broken", "other"].includes(b.reason) ? b.reason : "other";
  if (!targetId) return c.json({ error: "bad_request" }, 400);

  const gate = await gateWrite(c, "flag");
  if (gate) return gate;

  const res = await new ModerationRepo(c.env.DB).flag(targetType, targetId, c.get("user")!.id, reason);
  // Deliberately does NOT report the total back — a visible flag count invites
  // pile-ons and tells a spammer how close they are to attention.
  return c.json({ ok: true, counted: res.counted });
});

// ── moderation queue (admin only) ────────────────────────────────────────────
// 404s for everyone else, signed in or not: no reason to advertise that this
// exists, and a 403 would tell an attacker they only need the right account.
app.get("/moderation", optionalAuth, requireAdmin, async (c) => {
  const mod = new ModerationRepo(c.env.DB);
  const [queue, log, blocked] = await Promise.all([mod.queue(), mod.actionLog(40), mod.blockedDomains()]);
  const chrome = await chromeFor(c);
  const nowMs = Date.now();

  const action = (label: string, act: string, type: string, id: string, danger = false) =>
    html`<form method="post" action="/moderation/act" style="display:inline">
      <input type="hidden" name="action" value="${act}">
      <input type="hidden" name="targetType" value="${type}">
      <input type="hidden" name="targetId" value="${id}">
      <button class="toggle" type="submit" style="${danger ? "color:var(--crit)" : ""}">${label}</button>
    </form>`;

  const body = html`<h1 class="item-title serif" style="margin-top:22px">Moderation</h1>
<div class="notice">
  <strong>Flags never hide anything.</strong>
  They only sort this queue — every decision below is yours, logged, and reversible.
</div>

<h2 class="comments-head mono">Flagged · ${queue.length}</h2>
${queue.length
      ? queue.map((q) => html`<div class="comment">
          <div class="comment-meta mono">
            <span class="mark">${q.targetType}</span>
            <span class="dot">·</span><span>${q.flagCount} flag${q.flagCount === 1 ? "" : "s"}</span>
            ${q.reasons.length ? html`<span class="dot">·</span><span>${q.reasons.join(", ")}</span>` : ""}
            ${q.handle ? html`<span class="dot">·</span><a href="/u/${q.handle}">${q.author}</a>` : ""}
            <span class="dot">·</span><time datetime="${q.createdAt}">${timeAgo(q.createdAt, nowMs)}</time>
            ${q.dead ? html`<span class="dot">·</span><span style="color:var(--warn)">hidden</span>` : ""}
          </div>
          <div class="comment-body">
            ${q.targetType === "place"
        ? html`<a href="${chrome.eventsOrigin}/app/city?place=${q.targetId}">${q.title.slice(0, 200)}</a>`
        : html`<a href="/item/${q.storyId}${q.storySlug ? "/" + q.storySlug : ""}">${q.title.slice(0, 200)}</a>`}
          </div>
          <div class="comment-meta mono" style="margin-top:6px">
            ${q.targetType === "story"
        ? (q.dead ? action("unhide", "unhide", "story", q.targetId) : action("hide", "hide", "story", q.targetId, true))
        : q.targetType === "place"
          ? (q.dead ? action("unhide", "unhide_place", "place", q.targetId) : action("hide", "hide_place", "place", q.targetId, true))
          : (q.dead ? action("revive", "revive", "comment", q.targetId) : action("kill", "kill", "comment", q.targetId, true))}
            ${q.handle ? html`<span class="dot">·</span>${action("ban author", "ban", "user", q.handle, true)}` : ""}
          </div>
        </div>`)
      : html`<p style="color:var(--muted);padding:14px 0">Nothing flagged. Quiet is good.</p>`}

<h2 class="comments-head mono" style="margin-top:32px">Blocked domains · ${blocked.length}</h2>
<form method="post" action="/moderation/act" style="margin:12px 0">
  <input type="hidden" name="action" value="block_domain">
  <input type="hidden" name="targetType" value="story">
  <input class="input" name="targetId" placeholder="example.com" style="max-width:280px;display:inline-block">
  <button class="btn btn-quiet" type="submit">Block</button>
</form>
${blocked.length ? html`<p class="mono" style="font-size:12px;color:var(--muted)">${blocked.join(" · ")}</p>` : ""}

<h2 class="comments-head mono" style="margin-top:32px">Audit log</h2>
${log.length
      ? log.map((a) => html`<div class="comment-meta mono" style="padding:4px 0">
          <span>${a.action}</span><span class="dot">·</span><span>${a.targetType}</span>
          <span class="dot">·</span><span style="color:var(--faint)">${a.targetId.slice(0, 26)}</span>
          <span class="dot">·</span><span>${a.actor ?? "system"}</span>
          <span class="dot">·</span><time datetime="${a.createdAt}">${timeAgo(a.createdAt, nowMs)}</time>
        </div>`)
      : html`<p style="color:var(--muted);padding:14px 0">No actions taken yet.</p>`}`;

  return htmlResponse(
    page({ title: "Moderation", canonical: newsOrigin(c.env) + "/moderation", noindex: true }, chrome, body),
  );
});

// Form POSTs, so the queue works with JavaScript disabled.
app.post("/moderation/act", optionalAuth, requireAdmin, async (c) => {
  const form = await c.req.parseBody().catch(() => ({} as any));
  const actorId = c.get("user")!.id;
  const act = String((form as any).action ?? "");
  const targetId = String((form as any).targetId ?? "").trim();
  const mod = new ModerationRepo(c.env.DB);
  if (!targetId) return c.redirect("/moderation", 303);

  switch (act) {
    case "hide": await mod.hideStory(targetId, actorId); break;
    case "unhide": await mod.unhideStory(targetId, actorId); break;
    case "kill": await mod.killComment(targetId, actorId); break;
    case "revive": await mod.reviveComment(targetId, actorId); break;
    // Crowd-map pins share this queue — a bad parking spot is a moderation
    // problem exactly like a bad link, and one queue is better than two.
    case "hide_place": await mod.hidePlace(targetId, actorId); break;
    case "unhide_place": await mod.unhidePlace(targetId, actorId); break;
    case "block_domain": await mod.blockDomain(targetId, actorId); break;
    case "ban": {
      // The form carries a handle; resolve it rather than trusting an id.
      const u = await repo(c).userByHandle(targetId);
      if (u) await mod.ban(u.id, actorId);
      break;
    }
    case "unban": {
      const u = await repo(c).userByHandle(targetId);
      if (u) await mod.unban(u.id, actorId);
      break;
    }
  }
  return c.redirect("/moderation", 303);
});

// ── profiles ─────────────────────────────────────────────────────────────────
// Every story byline and every comment links here, so this route existing is not
// optional — without it the site is full of 404s that only show up when clicked.
app.get("/u/:handle", optionalAuth, async (c) => {
  const handle = c.req.param("handle");
  const r = repo(c);
  const user = await r.userByHandle(handle);
  const chrome = await chromeFor(c);
  if (!user) return notFound(c);

  const [stories, comments, stats] = await Promise.all([
    r.storiesByAuthor(user.id),
    r.commentsByAuthor(user.id),
    r.authorStats(user.id),
  ]);
  const nowMs = Date.now();

  const body = html`<h1 class="item-title serif" style="margin-top:22px">${user.displayName}</h1>
<div class="story-meta mono" style="margin-bottom:18px">
  <span>@${user.handle}</span><span class="dot">·</span>
  <span>${stats.stories} submission${stats.stories === 1 ? "" : "s"}</span><span class="dot">·</span>
  <span>${stats.comments} comment${stats.comments === 1 ? "" : "s"}</span><span class="dot">·</span>
  <span>${stats.points} point${stats.points === 1 ? "" : "s"}</span><span class="dot">·</span>
  <a href="${chrome.eventsOrigin}/app/u/${user.handle}">profile on thebay.events →</a>
</div>

<h2 class="comments-head mono">Submissions</h2>
${stories.length
      ? storyList(stories, { nowMs, signedIn: !!c.get("user") })
      : html`<p style="color:var(--muted);padding:14px 0">Nothing submitted yet.</p>`}

<h2 class="comments-head mono" style="margin-top:32px">Comments</h2>
${comments.length
      ? comments.map(
        (cm) => html`<div class="comment">
            <div class="comment-meta mono">
              <a href="${itemPath({ id: cm.storyId, slug: cm.storySlug })}">${cm.storyTitle}</a>
              <span class="dot">·</span>
              <time datetime="${cm.createdAt}">${timeAgo(cm.createdAt, nowMs)}</time>
            </div>
            <div class="comment-body">${formatBody(cm.body)}</div>
          </div>`,
      )
      : html`<p style="color:var(--muted);padding:14px 0">No comments yet.</p>`}`;

  return htmlResponse(
    page(
      {
        title: `${user.displayName} (@${user.handle})`,
        description: `${user.displayName} on thebay.news — ${stats.stories} submissions, ${stats.comments} comments.`,
        canonical: `${newsOrigin(c.env)}/u/${user.handle}`,
        ogType: "website",
      },
      chrome,
      body,
    ),
  );
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

// Accept stories harvested on a residential IP. OpenAlex 429s the Worker's
// shared Cloudflare egress but answers a laptop fine, so `npm run scrape-news`
// fetches locally and posts here — the same bridge the events scraper uses for
// Eventbrite. Narrow by construction: allowlisted origins, validated fields,
// bounded batch. See src/news/ingest/push.ts for why each limit exists.
app.post("/api/admin/push-news", async (c) => {
  const token = c.env.INGEST_TOKEN;
  if (!token || c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);

  const parsed = PushPayloadSchema.safeParse(await c.req.json().catch(() => null));
  // Reject the batch whole rather than applying the valid half — a partial write
  // from a malformed payload is the state that's hardest to reason about later.
  if (!parsed.success) {
    return c.json({ error: "invalid", issues: parsed.error.issues.slice(0, 5) }, 400);
  }

  const res = await new NewsRepo(c.env.DB).upsertIngested(parsed.data.stories as any);
  return c.json({ ok: true, received: parsed.data.stories.length, ...res });
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
