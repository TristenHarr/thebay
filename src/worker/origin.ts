/**
 * Canonical origin — the single source of truth for URLs that outlive the request
 * that created them.
 *
 * Anything emitted OFF-platform (calendar subscribe URLs, emailed links, push
 * payloads, cross-domain redirects) must never be derived from the request's own
 * origin: the same Worker now answers on more than one hostname, so a request that
 * happened to arrive on a secondary domain would bake that hostname into a URL
 * that lives for months. A calendar `.ics` URL sits in someone's Google Calendar
 * for 400 days; it has to point somewhere we still control and still serve.
 *
 * `PUBLIC_ORIGIN` lets a preview/staging deploy override it; the hardcoded
 * fallback means a missing var degrades to "correct in production" rather than
 * "whatever host this request used".
 */
export const CANONICAL_ORIGIN = "https://thebay.events";
export const NEWS_CANONICAL_ORIGIN = "https://thebay.news";

/** Origin for long-lived / off-platform URLs. Never the request origin. */
export function canonicalOrigin(env: { PUBLIC_ORIGIN?: string }): string {
  return (env.PUBLIC_ORIGIN || CANONICAL_ORIGIN).replace(/\/+$/, "");
}

/** Canonical origin of the news site. Used for rel=canonical, OG urls, sitemap
 *  and RSS entries — all of which must be absolute and must not vary by request. */
export function newsOrigin(env: { NEWS_ORIGIN?: string }): string {
  return (env.NEWS_ORIGIN || NEWS_CANONICAL_ORIGIN).replace(/\/+$/, "");
}
