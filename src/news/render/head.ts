/**
 * The <head>. This is the SEO surface, and it is the reason the site is
 * server-rendered at all: Slack, X, LinkedIn, Discord and iMessage never execute
 * JavaScript, so anything not present in this HTML does not exist to them.
 *
 * Every page therefore emits, synchronously: a real title, a real description, a
 * canonical URL, OpenGraph + Twitter card tags, and JSON-LD structured data.
 */
import { html, raw, escapeJsonLd, safeUrl, type RawHtml } from "./escape";

export interface PageMeta {
  /** Page title WITHOUT the site suffix — this adds it. */
  title: string;
  description?: string | null;
  /** Absolute canonical URL. Duplicate content across two domains is the one
   *  thing search engines genuinely punish, so this is required, not optional. */
  canonical: string;
  ogType?: "website" | "article";
  image?: string | null;
  imageAlt?: string | null;
  publishedAt?: string | null;
  author?: string | null;
  /** Structured data object; serialized safely into a ld+json block. */
  jsonLd?: unknown;
  noindex?: boolean;
  /** Absolute URL of the RSS feed to advertise. */
  feedUrl?: string | null;
}

export const SITE_NAME = "thebay.news";
const TITLE_SUFFIX = " — thebay.news";
/** Descriptions much past this get truncated in results anyway. */
const DESC_MAX = 158;

export function clampDescription(text: string | null | undefined): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= DESC_MAX) return s;
  // Cut on a word boundary rather than mid-word.
  return s.slice(0, DESC_MAX - 1).replace(/\s+\S*$/, "") + "…";
}

/** Full page title, suffixed unless it already is the site name. */
export function pageTitle(title: string): string {
  const t = (title || "").trim() || SITE_NAME;
  if (t === SITE_NAME) return t;
  // Long story titles + a suffix get truncated in SERPs; drop the suffix instead
  // of losing the end of the headline.
  return t.length > 52 ? t : t + TITLE_SUFFIX;
}

export function renderHead(meta: PageMeta, assets: { css: string; js: string }): RawHtml {
  const desc = clampDescription(meta.description);
  const img = meta.image ? safeUrl(meta.image) : null;
  const canonical = safeUrl(meta.canonical) ?? meta.canonical;

  return html`<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${pageTitle(meta.title)}</title>
${desc ? html`<meta name="description" content="${desc}">` : ""}
<link rel="canonical" href="${canonical}">
${meta.noindex ? html`<meta name="robots" content="noindex, follow">` : html`<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">`}

<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="${meta.ogType ?? "website"}">
<meta property="og:title" content="${meta.title}">
${desc ? html`<meta property="og:description" content="${desc}">` : ""}
<meta property="og:url" content="${canonical}">
${img ? html`<meta property="og:image" content="${img}">` : ""}
${img && meta.imageAlt ? html`<meta property="og:image:alt" content="${meta.imageAlt}">` : ""}
${meta.publishedAt ? html`<meta property="article:published_time" content="${meta.publishedAt}">` : ""}
${meta.author ? html`<meta property="article:author" content="${meta.author}">` : ""}

<meta name="twitter:card" content="${img ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${meta.title}">
${desc ? html`<meta name="twitter:description" content="${desc}">` : ""}
${img ? html`<meta name="twitter:image" content="${img}">` : ""}

<meta name="theme-color" content="#071211" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f6faf9" media="(prefers-color-scheme: light)">
<meta name="color-scheme" content="dark light">
${meta.feedUrl ? html`<link rel="alternate" type="application/rss+xml" title="${SITE_NAME}" href="${meta.feedUrl}">` : ""}
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${assets.css}">
${meta.jsonLd ? html`<script type="application/ld+json">${raw(escapeJsonLd(meta.jsonLd))}</script>` : ""}
<script src="${assets.js}" defer></script>`;
}

// ── structured data builders ─────────────────────────────────────────────────

/** A story + its comments, as Google's discussion-forum type. */
export function discussionJsonLd(input: {
  url: string;
  headline: string;
  datePublished: string;
  author: string | null;
  text?: string | null;
  upvotes: number;
  comments: { author: string | null; text: string; datePublished: string }[];
}): unknown {
  return {
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    "@id": input.url,
    url: input.url,
    headline: input.headline,
    datePublished: input.datePublished,
    author: { "@type": "Person", name: input.author || "The Bay" },
    ...(input.text ? { text: input.text } : {}),
    interactionStatistic: [
      { "@type": "InteractionCounter", interactionType: "https://schema.org/LikeAction", userInteractionCount: input.upvotes },
      { "@type": "InteractionCounter", interactionType: "https://schema.org/CommentAction", userInteractionCount: input.comments.length },
    ],
    comment: input.comments.slice(0, 50).map((c) => ({
      "@type": "Comment",
      author: { "@type": "Person", name: c.author || "anon" },
      text: c.text,
      datePublished: c.datePublished,
    })),
  };
}

/** The front page, as an ordered list of links. */
export function itemListJsonLd(origin: string, items: { url: string; title: string }[]): unknown {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    url: origin + "/",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: it.url,
      name: it.title,
    })),
  };
}

export function breadcrumbJsonLd(crumbs: { name: string; url: string }[]): unknown {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem", position: i + 1, name: c.name, item: c.url,
    })),
  };
}

/** Site-level identity, emitted on the front page. */
export function siteJsonLd(origin: string): unknown {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: origin + "/",
    description: "Bay Area tech news, submitted and discussed by the people actually here.",
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: origin + "/?q={search_term_string}" },
      "query-input": "required name=search_term_string",
    },
  };
}
