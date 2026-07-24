const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "with",
  "by", "from", "presents", "presented", "hosted",
]);

/** Strip HTML tags and decode a handful of common entities. */
export function stripHtml(input: string): string {
  return input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

/** Collapse whitespace; return null for empty. */
export function cleanText(input: string | null | undefined): string | null {
  if (!input) return null;
  const t = stripHtml(input).replace(/\s+/g, " ").trim();
  return t.length ? t : null;
}

/**
 * Aggressive title normalization for dedup: lowercase, strip diacritics,
 * drop punctuation/emoji, remove stopwords + 4-digit years, collapse spaces.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w) && !/^(19|20)\d{2}$/.test(w))
    .join(" ")
    .trim();
}

export function tokenSet(title: string): Set<string> {
  return new Set(normalizeTitle(title).split(/\s+/).filter(Boolean));
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
