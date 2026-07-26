/**
 * Which hostname does a recipe actually hit? Pure, and load-bearing for politeness:
 * `scrape_hosts` is keyed by host, so a recipe whose host we can't determine is a
 * recipe we cannot rate-limit — and the coordinator refuses to schedule those rather
 * than crawl something with no budget attached.
 *
 * Each adapter type is listed explicitly instead of guessing from params. That's more
 * code than a generic `params.url` sniff, but the alternative fails silently: a `luma`
 * recipe has no URL in its params at all (it has a calendar slug), so a sniffer would
 * return null and quietly stop scheduling the twelve Luma sources that produce most of
 * the catalog. If you add an adapter to src/sources/registry.ts, add it here too —
 * tests/net-politeness.test.ts walks config/sources.json and fails on any source whose
 * host can't be resolved, so you'll know immediately.
 */

/** Hosts that are a property of the adapter, not of its params. */
const FIXED_HOST: Record<string, string> = {
  luma: "api.luma.com",
  eventbrite: "www.eventbrite.com",
  partiful: "partiful.com",
};

/**
 * The path a recipe will hit, for a robots.txt check. Representative rather than exhaustive: a
 * paginated crawl touches many URLs, but they share a prefix, and a rule that disallows the
 * prefix disallows all of them. Falls back to "/" — the most conservative answer, since a
 * `Disallow: /` must stop a recipe whose shape we can't read.
 */
export function recipePath(type: string, params: Record<string, unknown> = {}): string {
  const of = (u: unknown): string | null => {
    if (typeof u !== "string" || !u) return null;
    try {
      const url = new URL(u);
      return url.pathname + (url.search || "");
    } catch {
      return null;
    }
  };
  switch (type) {
    case "eventbrite": {
      // The hub pages src/sources/eventbrite.ts builds.
      const loc = Array.isArray(params.locations) ? params.locations[0] : params.location;
      const q = Array.isArray(params.queries) ? params.queries[0] : params.query;
      return `/d/${loc ?? "ca--san-francisco"}/${q ?? "events"}/`;
    }
    case "luma":
      return "/discover/get-paginated-events";
    case "partiful":
      return "/discover";
    case "airtable":
      return params.mode === "share" ? (of(params.shareUrl) ?? "/") : "/v0";
    default: {
      const first = Array.isArray(params.urls) ? params.urls[0] : params.url;
      return of(first) ?? "/";
    }
  }
}

/** Lowercased hostname of a URL, or null if it isn't one. */
export function hostOfUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h || null;
  } catch {
    return null;
  }
}

/** First usable host among a params key that may hold a string or an array of them. */
function firstHost(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const item of v) {
      const h = hostOfUrl(item);
      if (h) return h;
    }
    return null;
  }
  return hostOfUrl(v);
}

/**
 * The host a recipe will crawl, or null when we can't tell. Null is a rejection at
 * proposal time, not a shrug at schedule time.
 */
export function recipeHost(type: string, params: Record<string, unknown> = {}): string | null {
  const fixed = FIXED_HOST[type];
  if (fixed) return fixed;

  switch (type) {
    case "airtable":
      // The share mode fetches a published grid off the website; the api mode talks to
      // the REST API. Different budgets, so different hosts.
      if (params.mode === "share" || params.shareUrl || params.discoverFrom) {
        return firstHost(params.shareUrl) ?? firstHost(params.discoverFrom) ?? "airtable.com";
      }
      return "api.airtable.com";
    case "ical":
    case "html":
      return firstHost(params.urls) ?? firstHost(params.url);
    case "generic-json":
      // The url may be a template ({{now}}); templates keep the origin intact, so the
      // host resolves even before substitution.
      return firstHost(params.url);
    default:
      // An adapter we don't know how to place. Deliberately null — see the module doc.
      return firstHost(params.url) ?? firstHost(params.urls);
  }
}
