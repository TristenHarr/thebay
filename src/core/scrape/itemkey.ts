/**
 * The identity of an upstream item, derived by the SERVER — pure, no I/O.
 *
 * This is the load-bearing choice of the whole consensus design. Today
 * `/api/admin/ingest` accepts a client-computed `fingerprint` and uses it as the SQL
 * match key, which means a submitter picks which existing event their data merges into.
 * That's fine for a trusted local pipeline and unacceptable for volunteers.
 *
 * So volunteers submit `RawEvent[]` and the server derives everything. Two consequences,
 * both essential:
 *
 *   1. Nobody can lie about a hash they didn't compute. Comparing "what did you see?"
 *      across workers is only meaningful if the comparison key is ours.
 *   2. Two honest workers scraping the same source produce IDENTICAL keys by
 *      construction, not by luck — so agreement means agreement, and disagreement is
 *      about the data rather than about incidental formatting.
 *
 * The key prefers the source's own stable id (`externalId`), because that is what the
 * upstream site considers "the same event" and it survives a title edit or a
 * rescheduling. Only when a source gives us no id do we fall back to the URL, and only
 * when that's missing too do we fall back to the dedup fingerprint — which is a weaker
 * identity (title + local day + city), and deliberately last.
 */
import { hash128 } from "../util/hash";

/**
 * Query parameters that identify a *visit* rather than a *thing*. Two workers hitting
 * the same event page can easily receive different tracking parameters — from a
 * redirect, from the listing page that linked them, from an A/B bucket — and if those
 * leaked into the key the two would look like different events and each would appear
 * to have invented one.
 */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^ref$/i,
  /^referrer$/i,
  /^aff$/i,
  /^affiliate/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_[ce]id$/i,
  /^_ga$/i,
  /^source$/i,
  /^campaign$/i,
  /^discount$/i, // Eventbrite promo links
];

const isTracking = (k: string) => TRACKING_PARAMS.some((re) => re.test(k));

/**
 * A URL reduced to the thing it points at: lowercase host, no `www.`, no fragment, no
 * tracking parameters, remaining parameters sorted, no trailing slash. Total — a string
 * that isn't a URL comes back trimmed and lowercased rather than throwing, because it
 * still has to key *something*.
 */
export function canonicalUrl(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return s.toLowerCase();
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  u.protocol = "https:"; // http vs https is not a different event
  const keep = [...u.searchParams.entries()].filter(([k]) => !isTracking(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = new URLSearchParams();
  for (const [k, v] of keep) qs.append(k, v);
  u.search = qs.toString();
  let out = u.toString();
  // Normalise the trailing slash, but never turn "https://host/" into "https://host".
  if (out.endsWith("/") && new URL(out).pathname !== "/") out = out.slice(0, -1);
  return out;
}

export interface KeyableRef {
  sourceId: string;
  externalId?: string | null;
  url?: string | null;
}

/**
 * The consensus key for one observed item. `fallbackFingerprint` is the dedup
 * fingerprint the normalizer already computed — used only when the source offers
 * neither a stable id nor a URL.
 *
 * Scoped by `sourceId` on purpose: the same event listed on both Luma and Eventbrite is
 * two upstream items that the existing dedup layer merges *after* promotion. Consensus
 * asks the narrower question — "did the people who looked at THIS source see the same
 * things?" — and conflating sources here would make one worker's Luma sighting appear to
 * corroborate another's Eventbrite sighting, which proves nothing about either.
 */
export function itemKey(ref: KeyableRef, fallbackFingerprint: string): string {
  const src = (ref.sourceId ?? "").trim();
  const ext = (ref.externalId ?? "").trim();
  if (ext) return hash128(`e|${src}|${ext}`);
  const url = canonicalUrl(ref.url ?? "");
  if (url) return hash128(`u|${src}|${url}`);
  return hash128(`f|${src}|${fallbackFingerprint}`);
}
