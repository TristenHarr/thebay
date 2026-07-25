/**
 * HTML escaping. Server-rendering user-submitted titles, comments and URLs means
 * escaping is a security boundary, not a formatting detail — every value that
 * reaches a template goes through one of these, and none of them can be bypassed
 * by forgetting a call, because the template helpers below are the only way to
 * interpolate.
 *
 * Pure, dependency-free, adversarially tested.
 */

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for use in element content OR a quoted attribute value. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch]!);
}

/**
 * A URL safe to put in href/src. Only http(s) survives — a stored `javascript:`
 * or `data:` URL is a stored XSS, and users submit URLs here by design.
 * Returns null when the URL is unusable, so callers render no link at all.
 */
export function safeUrl(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    // Allow site-relative paths (our own links), but never protocol-relative
    // "//evil.com" or anything with a control character.
    if (/^\/(?!\/)[\w\-./?=&%#:+,~]*$/.test(raw)) return raw;
    return null;
  }
}

/** Escape for embedding inside a <script type="application/ld+json"> block. */
export function escapeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    // U+2028/U+2029 are legal in JSON but terminate a line in JS source, so a
    // raw one inside an inline <script> block breaks the page.
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Tagged template that escapes every interpolation by default.
 * Use `raw()` to opt a value out — which makes every unescaped value greppable.
 *
 *   html`<h1>${userTitle}</h1>`           // escaped
 *   html`<div>${raw(alreadyRendered)}</div>`  // explicit, auditable
 */
export class RawHtml {
  constructor(public readonly value: string) {}
  toString(): string { return this.value; }
}

export function raw(value: string): RawHtml {
  return new RawHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): RawHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += renderValue(v) + (strings[i + 1] ?? "");
  }
  return new RawHtml(out);
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof RawHtml) return v.value;
  if (Array.isArray(v)) return v.map(renderValue).join("");
  return escapeHtml(v);
}

/** Render a template result to a string for a Response body. */
export function toHtml(v: RawHtml | string): string {
  return v instanceof RawHtml ? v.value : escapeHtml(v);
}
