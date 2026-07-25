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

/**
 * If a request arrived on a `www.` host, the canonical URL without it.
 *
 * Browsers autocomplete to `www.` constantly, and a bare Worker custom domain
 * covers only the exact hostname — so `www.` resolves to nothing and the visitor
 * gets a connection failure, not a 404. Serving both and 301'ing to the apex
 * keeps one canonical host for search engines and stops the site looking dead to
 * anyone whose browser filled in the `www.` for them.
 */
export function apexRedirectUrl(requestUrl: string): string | null {
  try {
    const u = new URL(requestUrl);
    if (!u.hostname.toLowerCase().startsWith("www.")) return null;
    u.hostname = u.hostname.slice(4);
    u.protocol = "https:";
    return u.toString();
  } catch {
    return null;
  }
}

/** Canonical origin of the news site. Used for rel=canonical, OG urls, sitemap
 *  and RSS entries — all of which must be absolute and must not vary by request. */
export function newsOrigin(env: { NEWS_ORIGIN?: string }): string {
  return (env.NEWS_ORIGIN || NEWS_CANONICAL_ORIGIN).replace(/\/+$/, "");
}
