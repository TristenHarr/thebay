import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import type { StoryOrigin, NewsSort, NewsFeedSource, StorySubmit } from "../../../shared/schema";
import { canonicalizeUrl, urlHash, displayDomain } from "../../news/canonical";
import { rankStories, type Rankable } from "../../news/rank";
import { curateFrontPage, SUBMISSION } from "../../news/curate";
import type { IngestedStory } from "../../news/ingest/types";
import { deriveTopics, looksLikeCommercialTraining } from "../../news/summarize";
import { isTemplateDuplicate } from "../../news/dedup";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

/**
 * How many candidates the hot ranker considers. Ranking is per-viewer and can't
 * be an ORDER BY, so we bound the set instead of scoring the whole table.
 *
 * Sized to cover the entire hot window, because the cap is applied by RECENCY:
 * at 500 it silently excluded every GitHub story (a source that posts a handful
 * of older-but-still-relevant repos), so that source vanished from the front
 * page even though it had a quota. A source being quiet must not mean a source
 * being invisible. Ranking a couple of thousand rows in JS is microseconds.
 */
const HOT_CANDIDATES = 2000;
/** Hot only considers the last week — older stories belong to /top, not the front page. */
const HOT_WINDOW_DAYS = 7;

export interface Story {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  slug: string | null;
  body: string | null;
  origin: StoryOrigin;
  eventId: string | null;
  summary: string | null;
  topics: string[];
  imageUrl: string | null;
  description: string | null;
  siteName: string | null;
  faviconUrl: string | null;
  publishedAt: string | null;
  domain: string;
  voteCount: number;
  commentCount: number;
  createdAt: string;
  authorId: string | null;
  author: string | null;
  handle: string | null;
  /** Set when the feed is read by a signed-in user. */
  didVote?: boolean;
  sources?: StorySourceRef[];
  /** Best score this story has on the source it came from. Derived from
   *  `sources` by attachSources so ranking and curation don't each re-walk it. */
  externalPoints?: number;
}

export interface StorySourceRef {
  origin: StoryOrigin;
  externalId: string;
  externalUrl: string | null;
  externalPoints: number | null;
  externalComments: number | null;
}

export interface Comment {
  id: string;
  storyId: string;
  parentId: string | null;
  body: string;
  depth: number;
  voteCount: number;
  dead: number;
  createdAt: string;
  authorId: string | null;
  author: string | null;
  handle: string | null;
}

/** URL-safe slug for /item/<id>/<slug>. Ids resolve the story; slugs are for
 *  humans and search engines, so they never need to be unique or stable. */
export function slugify(title: string): string {
  return (title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents left by NFKD
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

const SELECT_STORY = `
  SELECT s.id, s.kind, s.title, s.url, s.slug, s.body, s.origin, s.event_id, s.summary,
         s.topics_json, s.image_url, s.description, s.site_name, s.favicon_url, s.published_at,
         s.vote_count, s.comment_count, s.created_at, s.author_id,
         u.display_name AS author, u.handle
    FROM stories s
    LEFT JOIN users u ON u.id = s.author_id`;

function rowToStory(x: Row): Story {
  let topics: string[] = [];
  try { const p = JSON.parse(x.topics_json ?? "[]"); if (Array.isArray(p)) topics = p.map(String); } catch { topics = []; }
  return {
    id: x.id,
    kind: x.kind,
    title: x.title,
    url: x.url ?? null,
    slug: x.slug ?? null,
    body: x.body ?? null,
    origin: x.origin,
    eventId: x.event_id ?? null,
    summary: x.summary ?? null,
    topics,
    imageUrl: x.image_url ?? null,
    description: x.description ?? null,
    siteName: x.site_name ?? null,
    faviconUrl: x.favicon_url ?? null,
    publishedAt: x.published_at ?? null,
    domain: x.url ? displayDomain(x.url) : "",
    voteCount: x.vote_count ?? 0,
    commentCount: x.comment_count ?? 0,
    createdAt: x.created_at,
    authorId: x.author_id ?? null,
    author: x.author ?? null,
    handle: x.handle ?? null,
  };
}

/**
 * NewsRepo — thebay.news data access. Thin: the ranking, canonicalization and
 * filtering rules live as pure functions in src/news/ and are unit-tested there;
 * this class only moves rows.
 */
export class NewsRepo {
  constructor(private db: D1Database) {}

  // ── reads ───────────────────────────────────────────────────────────────────

  /**
   * Origins matching a feed source, or null for "everything".
   *
   * `bay` is NOT a filter — it's the curated front page, which draws from every
   * source and is assembled by curateFrontPage(). Returning null here lets the
   * ranker see all candidates; curation then decides the mix.
   */
  private originsFor(src: NewsFeedSource): StoryOrigin[] | null {
    if (src === "all" || src === "bay") return null;
    return [src];
  }

  /**
   * The ranked feed. `hot` scores a bounded recent candidate set in JS (SQLite has
   * no POW, and network/interest weighting is per-viewer); the other sorts are
   * plain whitelisted ORDER BYs.
   */
  async feed(
    opts: { src: NewsFeedSource; sort: NewsSort; topic?: string; limit: number; offset: number },
    viewerId?: string | null,
    nowMs: number = Date.now(),
  ): Promise<{ stories: Story[]; total: number }> {
    const origins = this.originsFor(opts.src);
    const where: string[] = ["s.dead = 0"];
    const binds: any[] = [];
    if (origins) {
      where.push(`s.origin IN (${origins.map(() => "?").join(",")})`);
      binds.push(...origins);
    }
    if (opts.topic) {
      // topics_json is a small JSON array; a LIKE on the quoted token is exact
      // enough here and avoids requiring the JSON1 extension.
      where.push("s.topics_json LIKE ?");
      binds.push(`%"${opts.topic}"%`);
    }

    let rows: Row[];
    if (opts.sort === "hot") {
      const since = new Date(nowMs - HOT_WINDOW_DAYS * 86_400_000).toISOString();
      const r = await this.db
        .prepare(`${SELECT_STORY} WHERE ${where.join(" AND ")} AND s.created_at >= ? ORDER BY s.created_at DESC LIMIT ?`)
        .bind(...binds, since, HOT_CANDIDATES)
        .all<Row>();
      rows = r.results ?? [];
    } else {
      // Whitelisted, never interpolated from user input.
      const order =
        opts.sort === "new" ? "s.created_at DESC, s.id DESC"
        : opts.sort === "top" ? "s.vote_count DESC, s.created_at DESC"
        : "s.comment_count DESC, s.created_at DESC";
      const r = await this.db
        .prepare(`${SELECT_STORY} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .bind(...binds, opts.limit, opts.offset)
        .all<Row>();
      rows = r.results ?? [];
    }

    let stories = rows.map(rowToStory);

    if (opts.sort === "hot") {
      const network = viewerId ? await this.networkVoteCounts(stories.map((s) => s.id), viewerId) : new Map<string, number>();
      // Ranking needs each story's source score, so attach sources BEFORE scoring.
      await this.attachSources(stories);
      const rankable: (Rankable & { _s: Story })[] = stories.map((s) => ({
        id: s.id,
        votes: s.voteCount,
        createdAt: s.createdAt,
        origin: s.origin,
        topics: s.topics,
        commentCount: s.commentCount,
        networkVotes: network.get(s.id) ?? 0,
        externalPoints: s.externalPoints ?? 0,
        _s: s,
      }));
      const ranked = rankStories(rankable, "hot", nowMs, { bayView: opts.src === "bay" }).map((r) => r._s);

      if (opts.src === "bay") {
        // The curated front page: human submissions lead, then a quality-barred,
        // per-source-quota'd mix of everything else. See src/news/curate.ts —
        // the whole editorial policy lives there, not in this query.
        const submissions = ranked.filter((s) => s.origin === SUBMISSION);
        const rest = ranked.filter((s) => s.origin !== SUBMISSION);
        stories = curateFrontPage(submissions, rest, opts.offset + opts.limit).slice(opts.offset);
      } else {
        stories = ranked.slice(opts.offset, opts.offset + opts.limit);
      }
    }

    if (viewerId) await this.markVoted(stories, viewerId);
    // Attribution must be present in the LIST, not just on the item page —
    // otherwise an aggregated story shows no credit to where it came from.
    await this.attachSources(stories);
    // `total` must count the same rows the sort can actually show. Hot only
    // considers the last week, so counting the whole table made ?src=fda report
    // "14 stories" above an empty page — a source whose content is older than
    // the window looked broken rather than quiet.
    const countWhere = [...where];
    const countBinds = [...binds];
    if (opts.sort === "hot") {
      countWhere.push("s.created_at >= ?");
      countBinds.push(new Date(nowMs - HOT_WINDOW_DAYS * 86_400_000).toISOString());
    }
    const total = await this.countStories(countWhere, countBinds);
    return { stories, total };
  }

  /**
   * Load the source rows for a set of stories.
   *
   * CHUNKED: D1 caps bound parameters per statement, and the hot ranker passes
   * its whole candidate set (up to HOT_CANDIDATES) through here — a single
   * `IN (?,?,…)` with 500 placeholders fails at runtime. Same 90-per-chunk
   * convention as D1Repo's fingerprint lookups.
   */
  private async attachSources(stories: Story[]): Promise<void> {
    if (!stories.length) return;
    const by = new Map<string, StorySourceRef[]>();

    for (let i = 0; i < stories.length; i += 90) {
      const ids = stories.slice(i, i + 90).map((s) => s.id);
      const r = await this.db
        .prepare(
          `SELECT story_id, origin, external_id, external_url, external_points, external_comments
             FROM story_sources WHERE story_id IN (${ids.map(() => "?").join(",")})`,
        )
        .bind(...ids)
        .all<Row>();
      for (const x of r.results ?? []) {
        const list = by.get(x.story_id) ?? [];
        list.push({
          origin: x.origin,
          externalId: x.external_id,
          externalUrl: x.external_url ?? null,
          externalPoints: x.external_points ?? null,
          externalComments: x.external_comments ?? null,
        });
        by.set(x.story_id, list);
      }
    }
    for (const s of stories) {
      s.sources = by.get(s.id) ?? [];
      s.externalPoints = Math.max(0, ...s.sources.map((x) => x.externalPoints ?? 0));
    }
  }

  private async countStories(where: string[], binds: any[]): Promise<number> {
    const r = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM stories s WHERE ${where.join(" AND ")}`)
      .bind(...binds)
      .first<Row>();
    return r?.n ?? 0;
  }

  /** Stamp `didVote` on a page of stories with one query rather than N. */
  private async markVoted(stories: Story[], viewerId: string): Promise<void> {
    if (!stories.length) return;
    const voted = new Set<string>();
    // Chunked for the same reason as attachSources — a full page plus the viewer
    // id can exceed D1's bound-parameter cap.
    for (let i = 0; i < stories.length; i += 90) {
      const ids = stories.slice(i, i + 90).map((s) => s.id);
      const r = await this.db
        .prepare(`SELECT story_id FROM story_votes WHERE user_id = ? AND story_id IN (${ids.map(() => "?").join(",")})`)
        .bind(viewerId, ...ids)
        .all<Row>();
      for (const x of r.results ?? []) voted.add(x.story_id);
    }
    for (const s of stories) s.didVote = voted.has(s.id);
  }

  /**
   * How many of each story's votes came from people the viewer is connected to.
   * This is what makes ranking *local* — a global aggregator cannot compute it.
   */
  async networkVoteCounts(storyIds: string[], viewerId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!storyIds.length) return out;

    // CHUNKED, like attachSources and markVoted. This one runs over the hot
    // ranker's FULL candidate window and only for signed-in readers — so an
    // unchunked IN (?,?,…) blows D1's bound-parameter cap and 500s the front
    // page for logged-in users while anonymous requests look perfectly healthy.
    for (let i = 0; i < storyIds.length; i += 90) {
      const chunk = storyIds.slice(i, i + 90);
      const ph = chunk.map(() => "?").join(",");
      // friendships stores one row per pair with user_low < user_high, so "the
      // other person" is whichever column isn't the viewer.
      const r = await this.db
        .prepare(
          `SELECT v.story_id, COUNT(*) AS n
             FROM story_votes v
            WHERE v.story_id IN (${ph})
              AND v.user_id <> ?
              AND v.user_id IN (
                SELECT CASE WHEN user_low = ? THEN user_high ELSE user_low END
                  FROM friendships
                 WHERE status = 'accepted' AND (user_low = ? OR user_high = ?)
              )
            GROUP BY v.story_id`,
        )
        .bind(...chunk, viewerId, viewerId, viewerId, viewerId)
        .all<Row>();
      for (const x of r.results ?? []) out.set(x.story_id, x.n);
    }
    return out;
  }

  async getStory(id: string, viewerId?: string | null): Promise<Story | null> {
    const r = await this.db.prepare(`${SELECT_STORY} WHERE s.id = ? AND s.dead = 0`).bind(id).first<Row>();
    if (!r) return null;
    const story = rowToStory(r);
    story.sources = await this.sourcesFor(id);
    if (viewerId) await this.markVoted([story], viewerId);
    return story;
  }

  async sourcesFor(storyId: string): Promise<StorySourceRef[]> {
    const r = await this.db
      .prepare(
        `SELECT origin, external_id, external_url, external_points, external_comments
           FROM story_sources WHERE story_id = ? ORDER BY origin`,
      )
      .bind(storyId)
      .all<Row>();
    return (r.results ?? []).map((x) => ({
      origin: x.origin,
      externalId: x.external_id,
      externalUrl: x.external_url ?? null,
      externalPoints: x.external_points ?? null,
      externalComments: x.external_comments ?? null,
    }));
  }

  /** Existing story for a URL, if we already have it (one story per link). */
  async findByUrl(rawUrl: string): Promise<Story | null> {
    const h = urlHash(rawUrl);
    if (!h) return null;
    const r = await this.db.prepare(`${SELECT_STORY} WHERE s.url_hash = ?`).bind(h).first<Row>();
    return r ? rowToStory(r) : null;
  }

  // ── writes ──────────────────────────────────────────────────────────────────

  /**
   * Submit a story. If the canonical URL already exists we return that story
   * instead of creating a duplicate — the caller redirects the submitter to the
   * existing discussion, which is the correct behaviour and also what the UNIQUE
   * index would otherwise enforce with a 409.
   */
  async submit(
    authorId: string,
    input: StorySubmit,
    atIso: string = nowIso(),
  ): Promise<{ id: string; duplicate: boolean }> {
    if (input.url) {
      const existing = await this.findByUrl(input.url);
      if (existing) return { id: existing.id, duplicate: true };
    }
    const id = ulid();
    const canonical = input.url ? canonicalizeUrl(input.url) : null;
    await this.db
      .prepare(
        `INSERT INTO stories (id, kind, title, url, url_hash, slug, body, author_id, origin, event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'bay', ?, ?)`,
      )
      .bind(
        id,
        input.kind,
        input.title.trim(),
        canonical,
        canonical ? urlHash(canonical) : null,
        slugify(input.title),
        input.body?.trim() || null,
        authorId,
        input.eventId ?? null,
        atIso,
      )
      .run();
    await this.db
      .prepare("INSERT OR IGNORE INTO story_sources (story_id, origin, external_id, fetched_at) VALUES (?, 'bay', ?, ?)")
      .bind(id, id, atIso)
      .run();
    return { id, duplicate: false };
  }

  /**
   * Upvote. The PK makes double-voting unrepresentable; we only touch the
   * denormalized counter when the insert actually happened, so the count can't
   * drift on a retry. (D1 can't read-after-write inside a batch, hence two calls.)
   */
  async vote(storyId: string, userId: string, atIso: string = nowIso()): Promise<{ counted: boolean }> {
    const r = await this.db
      .prepare("INSERT OR IGNORE INTO story_votes (story_id, user_id, created_at) VALUES (?, ?, ?)")
      .bind(storyId, userId, atIso)
      .run();
    const counted = !!r.meta?.changes;
    if (counted) {
      await this.db.prepare("UPDATE stories SET vote_count = vote_count + 1 WHERE id = ?").bind(storyId).run();
    }
    return { counted };
  }

  async unvote(storyId: string, userId: string): Promise<{ counted: boolean }> {
    const r = await this.db
      .prepare("DELETE FROM story_votes WHERE story_id = ? AND user_id = ?")
      .bind(storyId, userId)
      .run();
    const counted = !!r.meta?.changes;
    if (counted) {
      await this.db
        .prepare("UPDATE stories SET vote_count = MAX(0, vote_count - 1) WHERE id = ?")
        .bind(storyId)
        .run();
    }
    return { counted };
  }

  // ── comments ────────────────────────────────────────────────────────────────

  /** Flat, chronological. The tree is assembled by a pure function at render time. */
  async comments(storyId: string): Promise<Comment[]> {
    const r = await this.db
      .prepare(
        `SELECT c.id, c.story_id, c.parent_id, c.body, c.depth, c.vote_count, c.dead, c.created_at,
                c.author_id, u.display_name AS author, u.handle
           FROM comments c
           LEFT JOIN users u ON u.id = c.author_id
          WHERE c.story_id = ?
          ORDER BY c.created_at ASC, c.id ASC`,
      )
      .bind(storyId)
      .all<Row>();
    return (r.results ?? []).map((x) => ({
      id: x.id,
      storyId: x.story_id,
      parentId: x.parent_id ?? null,
      body: x.body,
      depth: x.depth ?? 0,
      voteCount: x.vote_count ?? 0,
      dead: x.dead ?? 0,
      createdAt: x.created_at,
      authorId: x.author_id ?? null,
      author: x.author ?? null,
      handle: x.handle ?? null,
    }));
  }

  /**
   * Add a comment. `depth` is derived from the parent server-side — a client-sent
   * depth would let someone forge indentation — and the parent is verified to
   * belong to this story so a reply can't be grafted across threads.
   */
  async addComment(
    storyId: string,
    authorId: string,
    body: string,
    parentId?: string | null,
    atIso: string = nowIso(),
  ): Promise<{ id: string } | { error: "bad_parent" }> {
    let depth = 0;
    if (parentId) {
      const p = await this.db
        .prepare("SELECT story_id, depth FROM comments WHERE id = ?")
        .bind(parentId)
        .first<Row>();
      if (!p || p.story_id !== storyId) return { error: "bad_parent" };
      depth = Math.min((p.depth ?? 0) + 1, 12); // cap runaway nesting
    }
    const id = ulid();
    await this.db
      .prepare(
        `INSERT INTO comments (id, story_id, parent_id, author_id, body, depth, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, storyId, parentId ?? null, authorId, body.trim(), depth, atIso)
      .run();
    await this.db.prepare("UPDATE stories SET comment_count = comment_count + 1 WHERE id = ?").bind(storyId).run();
    return { id };
  }

  // ── ingestion ───────────────────────────────────────────────────────────────

  /**
   * Merge aggregated stories in. The rules, in order:
   *
   *   1. Already seen this exact source item → refresh its points/comments only.
   *   2. Same canonical URL as an existing story → attach a source row to THAT
   *      story. One link, one discussion, many credits.
   *   3. Otherwise → a new story.
   *
   * A story's `origin` is never rewritten: if a person here posted it first it
   * stays `bay`, and HN merely becomes one of its attributions. Idempotent, so
   * the cron can run every 15 minutes without creating duplicates.
   */
  async upsertIngested(items: readonly IngestedStory[], atIso: string = nowIso()): Promise<{ created: number; merged: number; refreshed: number }> {
    let created = 0, merged = 0, refreshed = 0;

    for (const item of items) {
      // A source thread IS the article for text posts (Ask HN and friends).
      const link = item.url ?? item.externalUrl;
      if (!link) continue;

      const seen = await this.db
        .prepare("SELECT story_id FROM story_sources WHERE origin = ? AND external_id = ?")
        .bind(item.origin, item.externalId)
        .first<Row>();
      if (seen) {
        await this.db
          .prepare(
            `UPDATE story_sources SET external_points = ?, external_comments = ?, fetched_at = ?
              WHERE origin = ? AND external_id = ?`,
          )
          .bind(item.points ?? null, item.comments ?? null, atIso, item.origin, item.externalId)
          .run();
        refreshed++;
        continue;
      }

      const canonical = canonicalizeUrl(link);
      // A link we can't canonicalize can't be deduped and would violate the
      // stories CHECK (kind='link' requires a url). Skip the ITEM rather than
      // let one malformed URL abort the whole harvest — which is exactly what
      // happened when a feed emitted relative links.
      if (!canonical) continue;
      const hash = urlHash(canonical);
      let storyId: string | null = null;

      if (hash) {
        const existing = await this.db.prepare("SELECT id FROM stories WHERE url_hash = ?").bind(hash).first<Row>();
        if (existing) { storyId = existing.id; merged++; }
      }

      if (!storyId) {
        storyId = ulid();
        await this.db
          .prepare(
            `INSERT INTO stories (id, kind, title, url, url_hash, slug, origin, topics_json, published_at, author_name, created_at)
             VALUES (?, 'link', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            storyId,
            item.title.slice(0, 200),
            canonical,
            hash,
            slugify(item.title),
            item.origin,
            JSON.stringify(item.topics ?? []),
            item.createdAt,
            item.author,
            item.createdAt,
          )
          .run();
        created++;
      }

      await this.db
        .prepare(
          `INSERT OR IGNORE INTO story_sources
             (story_id, origin, external_id, external_url, external_points, external_comments, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(storyId, item.origin, item.externalId, item.externalUrl, item.points ?? null, item.comments ?? null, atIso)
        .run();
    }

    return { created, merged, refreshed };
  }

  /**
   * Turn upcoming events into discussable stories — the cross-product that makes
   * this a Bay news site rather than a generic aggregator. Idempotent via the
   * story_sources UNIQUE(origin, external_id) on the event id.
   */
  async syncEventStories(limit = 25, atIso: string = nowIso()): Promise<number> {
    // NOTE: we deliberately do NOT use events.interest_score / events.categories
    // to choose these. That tagging is intentionally permissive — the events
    // product's rule is "cast the widest net, never filter out" — so a museum
    // tour scores 100 and is tagged ["vc","math","software"]. Correct for a
    // calendar, wrong for a front page. A news page has to be selective, so we
    // re-classify from the title with our own stricter signals and post only
    // what actually reads as tech news. Everything else stays on thebay.events,
    // which is where a calendar belongs.
    const r = await this.db
      .prepare(
        `SELECT e.id, e.title, e.url, e.start_utc, e.city
           FROM events e
          WHERE e.hidden = 0
            AND e.start_utc >= ?
            AND NOT EXISTS (SELECT 1 FROM story_sources s WHERE s.origin = 'event' AND s.external_id = e.id)
          ORDER BY e.start_utc ASC
          LIMIT ?`,
      )
      .bind(atIso, limit * 20)
      .all<Row>();

    // Titles already posted as event stories, so one course template doesn't
    // occupy the whole front page in fifteen different towns.
    const posted = await this.db
      .prepare("SELECT title FROM stories WHERE origin = 'event' AND dead = 0 ORDER BY created_at DESC LIMIT 300")
      .all<Row>();
    const seenTitles: string[] = (posted.results ?? []).map((x) => String(x.title));

    let n = 0;
    for (const e of r.results ?? []) {
      if (n >= limit) break;
      const title0 = String(e.title ?? "");
      const topics = deriveTopics(title0);
      if (!topics.length) continue; // not news, just an event
      if (looksLikeCommercialTraining(title0)) continue; // a course ad, not news
      if (isTemplateDuplicate(title0, seenTitles)) continue; // same listing, different city
      const link = e.url || null;
      const canonical = link ? canonicalizeUrl(link) : null;
      const hash = canonical ? urlHash(canonical) : null;
      // Don't create a second story for a link someone already submitted.
      if (hash) {
        const dupe = await this.db.prepare("SELECT id FROM stories WHERE url_hash = ?").bind(hash).first<Row>();
        if (dupe) {
          await this.db
            .prepare("INSERT OR IGNORE INTO story_sources (story_id, origin, external_id, fetched_at) VALUES (?, 'event', ?, ?)")
            .bind(dupe.id, e.id, atIso)
            .run();
          await this.db.prepare("UPDATE stories SET event_id = COALESCE(event_id, ?) WHERE id = ?").bind(e.id, dupe.id).run();
          continue;
        }
      }
      const id = ulid();
      const title = String(e.title ?? "").slice(0, 200);
      if (!title) continue;
      await this.db
        .prepare(
          `INSERT INTO stories (id, kind, title, url, url_hash, slug, origin, event_id, body, topics_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'event', ?, ?, ?, ?)`,
        )
        .bind(
          id,
          canonical ? "link" : "text",
          title,
          canonical,
          hash,
          slugify(title),
          e.id,
          canonical ? null : `An upcoming event${e.city ? ` in ${e.city}` : ""}.`,
          JSON.stringify(topics),
          atIso,
        )
        .run();
      await this.db
        .prepare("INSERT OR IGNORE INTO story_sources (story_id, origin, external_id, fetched_at) VALUES (?, 'event', ?, ?)")
        .bind(id, e.id, atIso)
        .run();
      seenTitles.push(title);
      n++;
    }
    return n;
  }

  /** Link stories whose preview metadata has never been harvested. */
  async needingPreview(limit = 15): Promise<Story[]> {
    const r = await this.db
      .prepare(
        `${SELECT_STORY} WHERE s.dead = 0 AND s.url IS NOT NULL AND s.preview_fetched_at IS NULL
          ORDER BY s.created_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return (r.results ?? []).map(rowToStory);
  }

  /**
   * Store harvested preview metadata. `preview_fetched_at` is stamped even when
   * the harvest came back empty — that's what stops us re-fetching a page that
   * has no OpenGraph tags on every single cron tick.
   */
  async setPreview(
    storyId: string,
    p: { imageUrl: string | null; description: string | null; siteName: string | null; faviconUrl: string | null; publishedAt: string | null; lang: string | null },
    atIso: string = nowIso(),
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE stories
            SET image_url = COALESCE(?, image_url),
                description = COALESCE(?, description),
                site_name = COALESCE(?, site_name),
                favicon_url = COALESCE(?, favicon_url),
                published_at = COALESCE(?, published_at),
                lang = COALESCE(?, lang),
                preview_fetched_at = ?
          WHERE id = ?`,
      )
      .bind(p.imageUrl, p.description, p.siteName, p.faviconUrl, p.publishedAt, p.lang, atIso, storyId)
      .run();
  }

  /** Stories still missing an AI summary, oldest-first. */
  async needingSummary(limit = 8): Promise<Story[]> {
    const r = await this.db
      .prepare(`${SELECT_STORY} WHERE s.dead = 0 AND s.summary IS NULL AND s.title IS NOT NULL ORDER BY s.created_at DESC LIMIT ?`)
      .bind(limit)
      .all<Row>();
    return (r.results ?? []).map(rowToStory);
  }

  async setSummary(storyId: string, summary: string, topics?: string[]): Promise<void> {
    if (topics?.length) {
      await this.db
        .prepare("UPDATE stories SET summary = ?, topics_json = ? WHERE id = ?")
        .bind(summary, JSON.stringify(topics), storyId)
        .run();
    } else {
      await this.db.prepare("UPDATE stories SET summary = ? WHERE id = ?").bind(summary, storyId).run();
    }
  }

  /** Users who checked in to the event a story is about — the "was there" badge. */
  async attendeesOf(eventId: string): Promise<Set<string>> {
    const r = await this.db.prepare("SELECT user_id FROM checkins WHERE event_id = ?").bind(eventId).all<Row>();
    return new Set((r.results ?? []).map((x) => x.user_id));
  }

  // ── profiles ────────────────────────────────────────────────────────────────

  /** A reader's public identity on the news site, by handle. */
  async userByHandle(handle: string): Promise<{ id: string; handle: string; displayName: string; createdAt: string } | null> {
    const r = await this.db
      .prepare("SELECT id, handle, display_name, created_at FROM users WHERE handle = ?")
      .bind(String(handle ?? "").toLowerCase())
      .first<Row>();
    return r ? { id: r.id, handle: r.handle, displayName: r.display_name, createdAt: r.created_at } : null;
  }

  /** What they've submitted here (their own posts only, never aggregated rows). */
  async storiesByAuthor(userId: string, limit = 30): Promise<Story[]> {
    const r = await this.db
      .prepare(`${SELECT_STORY} WHERE s.author_id = ? AND s.dead = 0 ORDER BY s.created_at DESC LIMIT ?`)
      .bind(userId, limit)
      .all<Row>();
    const stories = (r.results ?? []).map(rowToStory);
    await this.attachSources(stories);
    return stories;
  }

  /** Their comments, with the story each belongs to for context. */
  async commentsByAuthor(userId: string, limit = 30): Promise<(Comment & { storyTitle: string; storySlug: string | null })[]> {
    const r = await this.db
      .prepare(
        `SELECT c.id, c.story_id, c.parent_id, c.body, c.depth, c.vote_count, c.dead, c.created_at,
                c.author_id, u.display_name AS author, u.handle,
                s.title AS story_title, s.slug AS story_slug
           FROM comments c
           JOIN stories s ON s.id = c.story_id
           LEFT JOIN users u ON u.id = c.author_id
          WHERE c.author_id = ? AND c.dead = 0 AND s.dead = 0
          ORDER BY c.created_at DESC LIMIT ?`,
      )
      .bind(userId, limit)
      .all<Row>();
    return (r.results ?? []).map((x) => ({
      id: x.id, storyId: x.story_id, parentId: x.parent_id ?? null, body: x.body,
      depth: x.depth ?? 0, voteCount: x.vote_count ?? 0, dead: x.dead ?? 0, createdAt: x.created_at,
      authorId: x.author_id ?? null, author: x.author ?? null, handle: x.handle ?? null,
      storyTitle: x.story_title, storySlug: x.story_slug ?? null,
    }));
  }

  /** Karma: points earned here, so a profile says something. */
  async authorStats(userId: string): Promise<{ stories: number; comments: number; points: number }> {
    const r = await this.db
      .prepare(
        // Plain positional binds, repeated — the convention everywhere in this
        // layer. Numbered (?1) placeholders work on D1 but not under the
        // better-sqlite3 test shim, so they'd pass in production and fail in CI.
        `SELECT (SELECT COUNT(*) FROM stories WHERE author_id = ? AND dead = 0) AS stories,
                (SELECT COUNT(*) FROM comments WHERE author_id = ? AND dead = 0) AS comments,
                (SELECT COALESCE(SUM(vote_count), 0) FROM stories WHERE author_id = ? AND dead = 0) AS points`,
      )
      .bind(userId, userId, userId)
      .first<Row>();
    return { stories: r?.stories ?? 0, comments: r?.comments ?? 0, points: r?.points ?? 0 };
  }

  // ── sitemap / feeds ─────────────────────────────────────────────────────────

  /** Stories for sitemap.xml and the RSS feed. */
  async recent(limit = 500): Promise<Story[]> {
    const r = await this.db
      .prepare(`${SELECT_STORY} WHERE s.dead = 0 ORDER BY s.created_at DESC LIMIT ?`)
      .bind(limit)
      .all<Row>();
    return (r.results ?? []).map(rowToStory);
  }
}
