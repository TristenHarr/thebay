/**
 * The story list — the front page. A LIST, not cards: density is what makes a
 * news page scannable, and it's what makes this recognisably descended from HN.
 * The beauty comes from type and hairlines, not from boxes and shadows.
 */
import { html, raw, safeUrl, type RawHtml } from "./escape";
import { timeAgo } from "./time";
import type { Story } from "../../storage/d1/news-repo";
import type { StoryOrigin, NewsFeedSource, NewsSort } from "../../../shared/schema";

/** Path to a story's discussion. Slug is decoration for humans and crawlers;
 *  the id is what resolves. */
export function itemPath(s: { id: string; slug?: string | null }): string {
  return s.slug ? `/item/${s.id}/${s.slug}` : `/item/${s.id}`;
}

const MARK_LABEL: Record<StoryOrigin, string> = {
  bay: "◉ bay",
  event: "event",
  hn: "hn",
  lobsters: "lo",
  rss: "rss",
};

/** Ours is turquoise, aggregated is neutral — local content leads the eye. */
export function sourceMark(origin: StoryOrigin): RawHtml {
  const cls = origin === "bay" || origin === "event" ? `mark mark-${origin}` : "mark";
  return html`<span class="${cls}">${MARK_LABEL[origin] ?? origin}</span>`;
}

/** Where the source thread lives, credited rather than copied. */
function discussElsewhere(s: Story): RawHtml {
  const ref = (s.sources ?? []).find((x) => x.origin === "hn" || x.origin === "lobsters");
  const href = ref?.externalUrl ? safeUrl(ref.externalUrl) : null;
  if (!ref || !href) return html``;
  const where = ref.origin === "hn" ? "HN" : "Lobsters";
  const pts = ref.externalPoints ? ` ${ref.externalPoints}` : "";
  return html`<span class="dot">·</span><a href="${href}" rel="noopener nofollow" target="_blank">${where}${pts} ↗</a>`;
}

export interface RowOpts {
  rank?: number;
  nowMs: number;
  /** Signed-in readers get an interactive vote control. */
  signedIn: boolean;
}

export function storyRow(s: Story, opts: RowOpts): RawHtml {
  const external = s.url ? safeUrl(s.url) : null;
  const discussion = itemPath(s);
  // Link posts point out to the article; text/ask/show posts point at the thread.
  const titleHref = external ?? discussion;
  const thumb = s.imageUrl ? safeUrl(s.imageUrl) : null;

  return html`<li class="story">
  <span class="rank">${opts.rank ?? ""}</span>
  <button class="vote" type="button"
          data-vote="${s.id}"
          aria-pressed="${s.didVote ? "true" : "false"}"
          aria-label="Upvote ${s.title}"
          ${!opts.signedIn ? raw('data-needs-auth="1"') : ""}>▲</button>
  <div class="story-main">
    ${thumb ? html`<img class="thumb" src="${thumb}" alt="" loading="lazy" decoding="async" width="72" height="54">` : ""}
    <h2 class="story-title">
      <a href="${titleHref}"${external ? raw(' rel="noopener"') : ""}>${s.title}</a>
    </h2>
    <div class="story-meta mono">
      ${s.domain ? html`<span class="domain">${s.domain}</span><span class="dot">·</span>` : ""}
      ${sourceMark(s.origin)}
      ${/* Our points are OUR readers' votes. Showing "0 points" on every freshly
            aggregated story is just noise — and implying an HN front-pager has no
            support would be wrong. So the counter appears once it means something;
            the source's own score is credited separately below. */
        s.voteCount > 0
          ? html`<span class="dot">·</span><span data-votes="${s.id}">${s.voteCount}</span> point${s.voteCount === 1 ? "" : "s"}`
          : html`<span class="dot" hidden>·</span><span data-votes="${s.id}" hidden>0</span>`}
      ${s.author ? html`<span class="dot">·</span><a href="/u/${s.handle}">${s.author}</a>` : ""}
      <span class="dot">·</span>
      <time datetime="${s.createdAt}">${timeAgo(s.createdAt, opts.nowMs)}</time>
      <span class="dot">·</span>
      <a href="${discussion}">${s.commentCount} comment${s.commentCount === 1 ? "" : "s"}</a>
      ${discussElsewhere(s)}
      ${s.eventId ? html`<span class="dot">·</span><a href="${discussion}#event">◆ event</a>` : ""}
    </div>
    ${s.summary ? html`<p class="tldr">${s.summary}</p>` : ""}
  </div>
</li>`;
}

export function storyList(stories: Story[], opts: RowOpts & { offset?: number }): RawHtml {
  if (!stories.length) {
    return html`<div class="empty">
      <h2 class="serif">Nothing here yet</h2>
      <p>Be the first to post something worth reading.</p>
      <p style="margin-top:14px"><a class="btn" href="/submit">Submit a story</a></p>
    </div>`;
  }
  const start = opts.offset ?? 0;
  return html`<ol class="stories">
    ${stories.map((s, i) => storyRow(s, { ...opts, rank: start + i + 1 }))}
  </ol>`;
}

// ── filters ──────────────────────────────────────────────────────────────────

const SOURCES: { key: NewsFeedSource; label: string }[] = [
  { key: "bay", label: "◉ the bay" },
  { key: "all", label: "all" },
  { key: "hn", label: "hn" },
  { key: "lobsters", label: "lobsters" },
  { key: "rss", label: "feeds" },
  { key: "event", label: "events" },
];

const SORTS: { key: NewsSort; label: string }[] = [
  { key: "hot", label: "hot" },
  { key: "new", label: "new" },
  { key: "top", label: "top" },
  { key: "discussed", label: "discussed" },
];

/**
 * Filter chips are real links, so they work without JS, are crawlable, and
 * produce shareable URLs. The island upgrades them to no-reload navigation.
 */
export function filterBar(current: { src: NewsFeedSource; sort: NewsSort; topic?: string }): RawHtml {
  const q = (over: Partial<{ src: string; sort: string; topic: string }>) => {
    const p = new URLSearchParams();
    const src = over.src ?? current.src;
    const sort = over.sort ?? current.sort;
    const topic = over.topic ?? current.topic;
    if (src !== "bay") p.set("src", src);
    if (sort !== "hot") p.set("sort", sort);
    if (topic) p.set("topic", topic);
    const s = p.toString();
    return s ? `/?${s}` : "/";
  };

  return html`<nav class="filters" aria-label="Filter stories">
    ${SOURCES.map((s) =>
      html`<a class="chip" href="${q({ src: s.key })}" aria-pressed="${s.key === current.src ? "true" : "false"}">${s.label}</a>`)}
    <span class="sep" aria-hidden="true"></span>
    ${SORTS.map((s) =>
      html`<a class="chip" href="${q({ sort: s.key })}" aria-pressed="${s.key === current.sort ? "true" : "false"}">${s.label}</a>`)}
    ${current.topic
      ? html`<span class="sep" aria-hidden="true"></span><a class="chip" href="${q({ topic: "" })}" aria-pressed="true">${current.topic} ✕</a>`
      : ""}
  </nav>`;
}
