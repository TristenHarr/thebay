import { describe, it, expect } from "vitest";
import { hashHue, eventThumb } from "../web/src/ui/thumb";

describe("hashHue — deterministic hue in [0,360)", () => {
  it("is stable for the same string and in range", () => {
    expect(hashHue("abc")).toBe(hashHue("abc"));
    for (const s of ["", "AI Founders Dinner", "01KY...", "🌉"]) {
      const h = hashHue(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(Number.isInteger(h)).toBe(true);
    }
  });
  it("spreads different strings across the wheel (not all the same hue)", () => {
    const hues = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(hashHue));
    expect(hues.size).toBeGreaterThan(3);
  });
});

describe("eventThumb — never-blank fallback for events with no image", () => {
  it("produces a two-tone gradient background + a glyph, deterministically per event", () => {
    const e = { id: "evt-1", title: "Robotics Night", categories: ["hardware"] };
    const a = eventThumb(e);
    const b = eventThumb(e);
    expect(a).toEqual(b); // stable
    expect(a.background).toMatch(/^linear-gradient\(.*hsl\(.*hsl\(.*\)$/);
    expect(a.glyph).toBe("🔧"); // hardware glyph
  });

  it("maps each interest category to its glyph, falling back to the Bay for none/unknown", () => {
    expect(eventThumb({ id: "1", categories: ["vc"] }).glyph).toBe("💰");
    expect(eventThumb({ id: "2", categories: ["math"] }).glyph).toBe("∑");
    expect(eventThumb({ id: "3", categories: ["software"] }).glyph).toBe("⌨️");
    expect(eventThumb({ id: "4", categories: ["tech"] }).glyph).toBe("✦");
    expect(eventThumb({ id: "5", categories: [] }).glyph).toBe("🌉"); // no category → the Bay
    expect(eventThumb({ id: "6", categories: ["unknown-cat"] }).glyph).toBe("🌉");
  });

  it("prefers an interest category over a generic one when both are present", () => {
    // 'tech' is the catch-all; a real interest tag should win the glyph
    expect(eventThumb({ id: "7", categories: ["tech", "hardware"] }).glyph).toBe("🔧");
  });

  it("seeds the hue from id, then title, then a constant — so it always yields a color", () => {
    expect(eventThumb({ title: "Only Title" }).background).toContain("hsl(");
    expect(eventThumb({}).background).toContain("hsl("); // still deterministic, no crash
  });
});
