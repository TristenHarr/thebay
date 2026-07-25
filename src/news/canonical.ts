/**
 * URL canonicalization — the foundation of "one story per link".
 *
 * The same article reaches us as four different strings: a human pastes it with a
 * `?utm_source=`, HN has the `www.`, an RSS feed hands us the AMP variant, and
 * someone else submits it over http. If any of those produce different hashes we
 * get four rows for one article and the front page fills with duplicates. So every
 * URL is reduced to one canonical form before it is hashed or stored.
 *
 * Pure and dependency-free (uses the platform `URL`), unit-tested with fixed input.
 */
import { hash128 } from "../core/util/hash";

/** Query params that identify a campaign/referrer, never the content. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^(fbclid|gclid|dclid|msclkid|yclid|igshid|mc_eid|mc_cid|_hsenc|_hsmi|vero_id|oly_enc_id)$/i,
  // Deliberately NOT stripping bare `source`/`src`: some sites use them to select
  // content, and collapsing two distinct pages into one story is a worse failure
  // than leaving a duplicate up.
  /^(ref|referrer|ref_src|ref_url)$/i,
];

const isTracking = (k: string) => TRACKING_PARAMS.some((re) => re.test(k));

/** Hosts that wrap a real destination in a redirect param. */
const REDIRECT_WRAPPERS: Record<string, string[]> = {
  "google.com": ["q", "url"],
  "news.google.com": ["url"],
  "out.reddit.com": ["url"],
  "l.facebook.com": ["u"],
  "t.co": [],
};

/**
 * Reduce a URL to its canonical form, or null if it isn't a usable web link.
 * Only http/https survive — `javascript:` and `data:` are rejected outright
 * rather than normalized, since a stored one becomes a stored XSS vector.
 */
export function canonicalizeUrl(raw: string, depth = 0): string | null {
  const input = (raw || "").trim();
  if (!input || depth > 3) return null;

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  // Unwrap redirectors before doing anything else — the wrapper's own params are
  // noise, and the destination needs the full treatment applied to it.
  const bareHost = u.hostname.toLowerCase().replace(/^www\./, "");
  const wrapKeys = REDIRECT_WRAPPERS[bareHost];
  if (wrapKeys) {
    for (const k of wrapKeys) {
      const dest = u.searchParams.get(k);
      if (dest) return canonicalizeUrl(dest, depth + 1);
    }
  }

  u.protocol = "https:"; // http and https of the same page are the same page
  u.hostname = bareHost;
  u.hash = "";
  u.username = "";
  u.password = "";
  if ((u.port === "80" || u.port === "443")) u.port = "";

  // Drop tracking params, then sort so ?a=1&b=2 and ?b=2&a=1 collapse together.
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) if (!isTracking(k)) kept.push([k, v]);
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // AMP variants are the same article.
  let path = u.pathname.replace(/\/amp\/?$/i, "").replace(/\.amp$/i, "");
  // Collapse duplicate slashes and drop the trailing one — but the root stays "/".
  path = path.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  u.pathname = path || "/";

  return u.toString();
}

/** Stable hash of the canonical form — the UNIQUE key behind one-story-per-link. */
export function urlHash(raw: string): string | null {
  const c = canonicalizeUrl(raw);
  return c ? hash128(c) : null;
}

/** The domain shown under a story title, e.g. "semiconductor-eng.com". */
export function displayDomain(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
