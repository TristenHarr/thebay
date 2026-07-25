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
