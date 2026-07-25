/**
 * The item page: one story, its preview, and the whole discussion — all present
 * in the server response, so a crawler (and a reader with JS off) gets the full
 * conversation, not an empty shell.
 */
import { html, raw, safeUrl, type RawHtml } from "./escape";
import { formatBody } from "./text";
import { timeAgo, longDate } from "./time";
import { sourceMark, itemPath } from "./story";
import type { Story, Comment } from "../../storage/d1/news-repo";

export interface CommentNode extends Comment {
  children: CommentNode[];
  /** Commenter checked in to the event this story is about. */
  wasThere?: boolean;
}

/**
 * Flat rows → a tree, in one pass. Orphans (a parent that was hard-deleted or is
 * missing) are promoted to top level rather than silently dropped — losing a
 * subtree of a conversation is worse than showing it slightly out of place.
 */
export function buildCommentTree(rows: readonly Comment[]): CommentNode[] {
  const byId = new Map<string, CommentNode>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });
  const roots: CommentNode[] = [];
  for (const r of rows) {
    const node = byId.get(r.id)!;
    const parent = r.parentId ? byId.get(r.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Total nodes in a forest — the count shown in the heading. */
export function countComments(nodes: readonly CommentNode[]): number {
  return nodes.reduce((n, c) => n + 1 + countComments(c.children), 0);
}

function commentNode(c: CommentNode, nowMs: number, signedIn: boolean, attendees?: Set<string>): RawHtml {
  // The badge nobody else can issue: this person physically checked in to the
  // event the story is about.
  const wasThere = c.wasThere ?? (!!c.authorId && !!attendees?.has(c.authorId));
  return html`<div class="comment" data-comment="${c.id}" data-collapsed="false">
    <div class="comment-meta mono">
      <button class="toggle" type="button" data-collapse aria-label="Collapse thread">[−]</button>
      ${c.author ? html`<a href="/u/${c.handle}">${c.author}</a>` : html`<span>[deleted]</span>`}
      ${wasThere ? html`<span class="was-there mono" title="Checked in to the event this story is about">◆ was there</span>` : ""}
      <span class="dot">·</span>
      <time datetime="${c.createdAt}">${timeAgo(c.createdAt, nowMs)}</time>
      ${signedIn ? html`<span class="dot">·</span><button class="toggle" type="button" data-reply="${c.id}">reply</button>` : ""}
    </div>
    <div class="comment-body">${c.dead ? html`<em style="color:var(--faint)">[flagged]</em>` : formatBody(c.body)}</div>
    ${c.children.length
      ? html`<div class="comment-nest">${c.children.map((k) => commentNode(k, nowMs, signedIn, attendees))}</div>`
      : ""}
  </div>`;
}

export function commentTree(nodes: CommentNode[], nowMs: number, signedIn: boolean, attendees?: Set<string>): RawHtml {
  return html`${nodes.map((n) => commentNode(n, nowMs, signedIn, attendees))}`;
}

/** The harvested link preview. Absent metadata simply renders less, never a gap. */
function previewCard(s: Story): RawHtml {
  const href = s.url ? safeUrl(s.url) : null;
  if (!href) return html``;
  if (!s.imageUrl && !s.description) return html``;
  const img = s.imageUrl ? safeUrl(s.imageUrl) : null;
  return html`<a class="preview" href="${href}" rel="noopener" target="_blank">
    ${img ? html`<img src="${img}" alt="" loading="lazy" decoding="async">` : ""}
    <div class="preview-text">
      <div class="preview-site mono">${s.siteName || s.domain}</div>
      <div class="preview-title serif">${s.title}</div>
      ${s.description ? html`<div class="preview-desc">${s.description}</div>` : ""}
    </div>
  </a>`;
}

export interface ItemOpts {
  nowMs: number;
  signedIn: boolean;
  inBay: boolean;
  eventsOrigin: string;
  /** User ids who checked in to this story's event, for the "was there" badge. */
  attendees?: Set<string>;
}

export function itemPage(s: Story, comments: Comment[], opts: ItemOpts): RawHtml {
  const external = s.url ? safeUrl(s.url) : null;
  const tree = buildCommentTree(comments);
  const total = countComments(tree);

  return html`<article class="item-head">
  <h1 class="item-title">
    ${external ? html`<a href="${external}" rel="noopener">${s.title}</a>` : s.title}
  </h1>
  <div class="story-meta mono">
    ${s.domain ? html`<span class="domain">${s.domain}</span><span class="dot">·</span>` : ""}
    ${sourceMark(s.origin)}
    <span class="dot">·</span>
    <button class="vote" type="button" data-vote="${s.id}" aria-pressed="${s.didVote ? "true" : "false"}"
            aria-label="Upvote">▲</button>
    <span data-votes="${s.id}">${s.voteCount}</span> point${s.voteCount === 1 ? "" : "s"}
    ${s.author ? html`<span class="dot">·</span><a href="/u/${s.handle}">${s.author}</a>` : ""}
    <span class="dot">·</span>
    <time datetime="${s.createdAt}">${longDate(s.createdAt)}</time>
  </div>

  ${previewCard(s)}
  ${s.summary ? html`<p class="tldr" style="font-size:14px">${s.summary}</p>` : ""}
  ${s.body ? html`<div class="item-body">${formatBody(s.body)}</div>` : ""}

  ${s.eventId
    ? html`<div class="notice" id="event">
        <strong>◆ This is about a real event.</strong>
        <a href="${opts.eventsOrigin}/app/event/${s.eventId}">Open it on thebay.events →</a>
      </div>`
    : ""}
</article>

<section class="comments">
  <h2 class="comments-head mono">${total} comment${total === 1 ? "" : "s"}</h2>

  ${opts.signedIn
    ? opts.inBay
      ? html`<form class="field" method="post" action="${itemPath(s)}/comment" data-comment-form style="margin:14px 0 22px">
          <textarea class="input" name="body" rows="4" maxlength="8000" placeholder="Add to the discussion…" aria-label="Your comment"></textarea>
          <div style="margin-top:8px"><button class="btn" type="submit">Comment</button></div>
        </form>`
      : html`<div class="notice notice-warn">
          <strong>You're outside the Bay.</strong>
          Reading is open to everyone; posting here is for people actually in the Bay Area.
          <button class="toggle" type="button" data-attest style="margin-left:6px">Check my location</button>
        </div>`
    : html`<div class="notice">
        <a href="/login">Sign in</a> to join the discussion — your thebay.events account works here.
      </div>`}

  ${total ? commentTree(tree, opts.nowMs, opts.signedIn, opts.attendees) : html`<p style="color:var(--muted);padding:18px 0">No comments yet.</p>`}
</section>`;
}
