/**
 * A never-blank fallback thumbnail for events that have no cover image. Pure +
 * deterministic: a two-tone gradient whose hue is seeded from the event, plus a
 * glyph for its strongest interest category. Rendered by <EventThumb> in kit.tsx.
 */

/** Deterministic FNV-ish hash of a string → a hue in [0, 360). */
export function hashHue(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
}

// The interest categories (from config/categories.json) → an emblem. `tech` is the
// catch-all, so a real interest tag wins the glyph; nothing recognizable → the Bay.
const INTEREST_GLYPH: Record<string, string> = { hardware: "🔧", vc: "💰", math: "∑", software: "⌨️" };

export function eventThumb(e: { id?: string; title?: string; categories?: string[] }): { background: string; glyph: string } {
  const seed = e.id || e.title || "bay";
  const hue = hashHue(seed);
  const background = `linear-gradient(135deg, hsl(${hue} 68% 52%), hsl(${(hue + 42) % 360} 64% 42%))`;
  const cats = e.categories || [];
  const interest = cats.find((c) => INTEREST_GLYPH[c]);
  const glyph = (interest && INTEREST_GLYPH[interest]) || (cats.includes("tech") ? "✦" : "🌉");
  return { background, glyph };
}
