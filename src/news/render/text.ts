/**
 * User-submitted prose → safe HTML. Paragraphs and autolinked URLs, nothing else.
 *
 * No markdown: it's a comment box, and every additional syntax is another escape
 * surface. Escaping happens FIRST, then links are woven into already-escaped text,
 * so no ordering mistake can emit raw user input.
 */
import { escapeHtml, safeUrl, raw, type RawHtml } from "./escape";

/** Matches bare http(s) URLs; trailing punctuation is excluded from the match. */
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** Autolink inside a chunk that is ALREADY html-escaped. */
function linkify(escaped: string): string {
  return escaped.replace(URL_RE, (m) => {
    // The chunk is escaped, so &amp; must be restored before parsing the URL.
    const candidate = m.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    const href = safeUrl(candidate);
    if (!href) return m;
    const shown = candidate.length > 60 ? candidate.slice(0, 57) + "…" : candidate;
    return `<a href="${escapeHtml(href)}" rel="nofollow noopener ugc" target="_blank">${escapeHtml(shown)}</a>`;
  });
}

/** Render a comment or self-post body as paragraphs. */
export function formatBody(text: string | null | undefined): RawHtml {
  const s = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!s) return raw("");
  const paras = s.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out = paras
    .map((p) => `<p>${linkify(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return raw(out);
}

/** Plain-text excerpt for meta descriptions and RSS, with no markup at all. */
export function excerpt(text: string | null | undefined, max = 200): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}
