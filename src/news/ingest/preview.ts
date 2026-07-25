/**
 * Link preview harvesting — the OpenGraph metadata behind the thumbnails, the
 * preview card, and `og:image` when one of our links is shared.
 *
 * Metadata is fetched ONCE and stored. Rendering must never depend on thirty
 * third-party origins being reachable, and a crawler has to get `og:image`
 * synchronously in our HTML.
 *
 * Good citizenship is enforced here, not assumed: bounded per run, never
 * re-fetched, short timeout, capped read size, honest User-Agent, http(s) only.
 */
import { USER_AGENT } from "./hn";

export interface PreviewMeta {
  imageUrl: string | null;
  description: string | null;
  siteName: string | null;
  faviconUrl: string | null;
  publishedAt: string | null;
  lang: string | null;
}

/** Only read this much of the page — everything we need is in the <head>. */
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;

const EMPTY: PreviewMeta = {
  imageUrl: null, description: null, siteName: null, faviconUrl: null, publishedAt: null, lang: null,
};

/** Decode the handful of entities that actually show up in meta content. */
function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m) =>
      ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read a <meta> value by property/name. Attribute order varies wildly in the
 * wild, so match the tag first and pull `content` out of it rather than assuming
 * a fixed layout.
 */
function meta(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const re = new RegExp(
      `<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
      "i",
    );
    const tag = re.exec(html)?.[0];
    if (!tag) continue;
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]
      ?? /content\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (content && content.trim()) return decode(content);
  }
  return null;
}

/** Resolve a possibly-relative asset URL against the page, http(s) only. */
function absolute(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Pure: HTML + its URL → the metadata we store. Never throws. */
export function parsePreview(html: string, pageUrl: string): PreviewMeta {
  const head = String(html ?? "").slice(0, MAX_BYTES);

  const iconHref = (() => {
    const tags = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    // Prefer a real icon rel; apple-touch-icon is usually the highest quality.
    const pick = tags.find((t) => /rel\s*=\s*["'][^"']*apple-touch-icon/i.test(t))
      ?? tags.find((t) => /rel\s*=\s*["'][^"']*\bicon\b/i.test(t));
    return pick ? /href\s*=\s*["']([^"']+)["']/i.exec(pick)?.[1] ?? null : null;
  })();

  const published = meta(head, ["article:published_time", "og:published_time", "datePublished", "date"]);
  const parsedDate = published ? Date.parse(published) : NaN;

  return {
    imageUrl: absolute(meta(head, ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]), pageUrl),
    description: meta(head, ["og:description", "twitter:description", "description"]),
    siteName: meta(head, ["og:site_name", "application-name"]),
    faviconUrl: absolute(iconHref ?? "/favicon.ico", pageUrl),
    publishedAt: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : null,
    lang: /<html\b[^>]*\blang\s*=\s*["']([a-zA-Z-]{2,8})["']/i.exec(head)?.[1] ?? null,
  };
}

/**
 * Fetch a page and extract its preview metadata. Returns EMPTY rather than
 * throwing for anything unreachable, non-HTML, or oversized — a story with no
 * preview renders fine; a failed harvest must never fail an ingest run.
 */
export async function harvestPreview(url: string, fetchImpl: typeof fetch = fetch): Promise<PreviewMeta> {
  let target: URL;
  try {
    target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return EMPTY;
  } catch {
    return EMPTY;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(target.toString(), {
      redirect: "follow",
      signal: ctl.signal,
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": USER_AGENT },
    });
    if (!res.ok) return EMPTY;
    if (!(res.headers.get("content-type") || "").toLowerCase().includes("html")) return EMPTY;

    // Read at most MAX_BYTES — some pages are enormous and we only need <head>.
    const reader = res.body?.getReader();
    if (!reader) return EMPTY;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    try { await reader.cancel(); } catch { /* already closed */ }

    const buf = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, size - off)), off); off += c.length; }
    return parsePreview(new TextDecoder("utf-8", { fatal: false }).decode(buf), res.url || target.toString());
  } catch {
    return EMPTY;
  } finally {
    clearTimeout(timer);
  }
}
