/**
 * Near-duplicate detection for stories.
 *
 * `url_hash` catches the same link submitted twice; this catches the cases it
 * can't — the same story at a mirror domain, or a link post and a text post about
 * the same thing. Reuses the title similarity already proven on cross-source event
 * dedup (src/core/dedup/similarity) rather than inventing a second notion of
 * "these are the same".
 */
import { titleSimilarity } from "../core/dedup/similarity";

/** Above this, two titles are treated as the same story. Tuned to accept
 *  punctuation/casing/site-suffix drift and reject genuinely different takes. */
export const TITLE_DUP_THRESHOLD = 0.85;

export function isDuplicateTitle(a: string, b: string): boolean {
  return titleSimilarity(a, b) >= TITLE_DUP_THRESHOLD;
}

/** Site-added noise that says nothing about the article itself. */
const NOISE = [
  /^\s*(show|ask|tell)\s+hn\s*:\s*/i,
  /\s*[[(](?:pdf|video|audio|2\d{3}|\d{4})[\])]\s*/gi,
  /\s*[|–—-]\s*[^|–—-]{1,30}$/, // trailing " | Site Name"
];

function clean(title: string): string {
  let t = (title || "").trim();
  for (const re of NOISE) t = t.replace(re, " ");
  return t.replace(/\s{2,}/g, " ").trim();
}

/**
 * When several sources describe one story, choose the title to display: the one
 * carrying the least site-specific noise, tie-broken toward the shorter.
 */
export function pickCanonicalTitle(titles: readonly string[]): string {
  const cleaned = titles.map(clean).filter(Boolean);
  if (!cleaned.length) return "";
  return cleaned.reduce((best, t) => (t.length < best.length ? t : best));
}

/**
 * Strip the trailing location from an event title.
 *
 * Course vendors carpet-bomb Eventbrite with one template per city — "…1 Day
 * Training in Menlo Park, CA", "…in San Ramon, CA", "…– San Carlos, CA" — which
 * are the same listing fifteen times over. Removing the location makes those
 * collapse to one string, so near-duplicate detection can catch them. Genuinely
 * distinct events keep distinct titles once the city is gone.
 */
export function templateKey(title: string): string {
  return String(title ?? "")
    // "… in Menlo Park, CA" / "… – San Carlos, CA" / "… | San Jose"
    .replace(/\s*[-–—|,]?\s*\b(?:in|at|near)\b\s+[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3}\s*,?\s*(?:CA|California)?\s*$/i, "")
    .replace(/\s*[-–—|]\s*[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3}\s*,?\s*(?:CA|California)\s*$/i, "")
    .replace(/\s*,\s*(?:CA|California)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * True when `title` is the same listing as one already posted, ignoring the city.
 * Used to keep one entry per template on the front page instead of a column of
 * the same course in fifteen towns.
 */
export function isTemplateDuplicate(title: string, existing: readonly string[]): boolean {
  const key = templateKey(title);
  if (!key) return false;
  return existing.some((e) => isDuplicateTitle(key, templateKey(e)));
}
