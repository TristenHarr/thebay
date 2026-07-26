/**
 * Reddit — the largest technical community by a wide margin, and the one that
 * needs a key.
 *
 * Its public RSS is not usable at our scale: probing sequentially with 1.5s
 * spacing, the FIRST request succeeded and every subsequent one returned 429.
 * Reddit rate-limits unauthenticated traffic by IP, and a Worker shares egress
 * IPs with everything else on Cloudflare, so we are permanently in someone
 * else's penalty box.
 *
 * With OAuth (free, "script" app, ~2 minutes to create) the limit is 100
 * requests/minute — vastly more than the handful per cron tick we need.
 *
 * KEY-OPTIONAL BY DESIGN: with no credentials this module reports itself as
 * unconfigured and the orchestrator skips it. It never fails a run, and adding
 * the secret later turns it on with no code change.
 *
 * Credentials: https://www.reddit.com/prefs/apps → "create app" → type "script".
 *   wrangler secret put REDDIT_CLIENT_ID -c wrangler.news.jsonc
 *   wrangler secret put REDDIT_CLIENT_SECRET -c wrangler.news.jsonc
 */
import type { IngestedStory } from "./types";
import { isUsable } from "./types";

export const REDDIT_USER_AGENT = "web:thebay.news:v1.0 (+https://thebay.news/about)";

/** Communities worth carrying, and the axis each maps to. */
export const SUBREDDITS: { sub: string; topics: string[] }[] = [
  { sub: "startups", topics: ["vc"] },
  { sub: "ycombinator", topics: ["vc"] },
  { sub: "SaaS", topics: ["vc"] },
  { sub: "MachineLearning", topics: ["software"] },
  { sub: "programming", topics: ["software"] },
  { sub: "ExperiencedDevs", topics: ["software"] },
  { sub: "hardware", topics: ["hardware"] },
  { sub: "embedded", topics: ["hardware"] },
  { sub: "math", topics: ["math"] },
  { sub: "bayarea", topics: [] },
  { sub: "sanfrancisco", topics: [] },
];

/** Below this score a Reddit post is noise at our volume. */
const MIN_SCORE = 50;
const PER_SUB = 10;

export interface RedditCreds { clientId: string; clientSecret: string }

export function credsFrom(env: { REDDIT_CLIENT_ID?: string; REDDIT_CLIENT_SECRET?: string }): RedditCreds | null {
  const clientId = env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = env.REDDIT_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Application-only OAuth. No user context, so no refresh dance. */
export async function getToken(creds: RedditCreds, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": REDDIT_USER_AGENT,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`reddit auth ${res.status}`);
  const body: any = await res.json();
  if (!body?.access_token) throw new Error("reddit auth: no token");
  return body.access_token;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseReddit(payload: any, sub: string, topics: string[] = []): IngestedStory[] {
  const children: any[] = payload?.data?.children ?? [];
  const out: IngestedStory[] = [];
  for (const c of children) {
    const d = c?.data ?? {};
    if (d.stickied || d.over_18) continue;               // pinned mod posts and NSFW
    if ((d.score ?? 0) < MIN_SCORE) continue;
    const permalink = d.permalink ? `https://www.reddit.com${d.permalink}` : null;
    // A self-post's destination IS the discussion; a link post points outward and
    // the thread is credited separately, same as HN.
    const isSelf = !!d.is_self;
    const candidate: Partial<IngestedStory> = {
      origin: "reddit",
      externalId: `r/${sub}:${d.id ?? ""}`,
      title: String(d.title ?? "").trim(),
      url: isSelf ? permalink : (typeof d.url === "string" ? d.url : permalink),
      externalUrl: permalink,
      points: Number.isFinite(d.score) ? d.score : null,
      comments: Number.isFinite(d.num_comments) ? d.num_comments : null,
      createdAt: Number.isFinite(d.created_utc)
        ? new Date(d.created_utc * 1000).toISOString()
        : new Date().toISOString(),
      author: d.author ? String(d.author) : null,
      topics,
    };
    if (isUsable(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * Fetch every configured subreddit. Per-sub failures are isolated; we only throw
 * if every one failed, matching the RSS adapter's convention.
 */
export async function fetchReddit(
  env: { REDDIT_CLIENT_ID?: string; REDDIT_CLIENT_SECRET?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<IngestedStory[]> {
  const creds = credsFrom(env);
  if (!creds) return []; // not configured — silently skipped, never a failure

  const token = await getToken(creds, fetchImpl);
  const out: IngestedStory[] = [];
  let failed = 0;

  for (const { sub, topics } of SUBREDDITS) {
    try {
      const res = await fetchImpl(`https://oauth.reddit.com/r/${sub}/top?t=day&limit=${PER_SUB}`, {
        headers: { authorization: `Bearer ${token}`, "user-agent": REDDIT_USER_AGENT },
      });
      if (!res.ok) throw new Error(String(res.status));
      out.push(...parseReddit(await res.json(), sub, topics));
    } catch { failed++; }
  }
  if (failed === SUBREDDITS.length) throw new Error(`all ${failed} subreddits failed`);
  return out;
}
