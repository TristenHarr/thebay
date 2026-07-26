import { describe, it, expect } from "vitest";
import { toMatchQuery } from "../src/core/search/fts";
import { windowRange, BAY_TZ } from "../src/core/search/window";

describe("toMatchQuery — FTS5 MATCH is a query language, and user text is untrusted", () => {
  it("quotes every token so FTS operators can never be injected", () => {
    expect(toMatchQuery("hardware")).toBe('"hardware"*');
    // NEAR/AND/OR/^/- are FTS5 syntax; quoted, they are just words.
    expect(toMatchQuery("robots NEAR/2 lasers")).toBe('"robots"* OR "near"* OR "2" OR "lasers"*');
    expect(toMatchQuery('"; DROP TABLE events; --')).toBe('"drop"* OR "table"* OR "events"*');
  });

  it("ORs the tokens — bm25 already rewards documents that match more of them", () => {
    expect(toMatchQuery("free hardware")).toBe('"free"* OR "hardware"*');
  });

  it("prefix-matches words but not short tokens or bare numbers", () => {
    expect(toMatchQuery("ai")).toBe('"ai"');
    expect(toMatchQuery("2026")).toBe('"2026"');
    expect(toMatchQuery("rust")).toBe('"rust"*');
  });

  it("returns null when there is nothing searchable, so the caller can skip FTS", () => {
    expect(toMatchQuery("")).toBeNull();
    expect(toMatchQuery("   ")).toBeNull();
    expect(toMatchQuery("!!! ??? ***")).toBeNull();
    expect(toMatchQuery(undefined)).toBeNull();
  });

  it("de-duplicates and bounds the term count (a 500-word paste must not become a 500-clause MATCH)", () => {
    expect(toMatchQuery("ai ai ai")).toBe('"ai"');
    const many = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    expect(toMatchQuery(many)!.split(" OR ").length).toBeLessThanOrEqual(10);
  });

  it("keeps unicode word characters (an accented venue name is still searchable)", () => {
    expect(toMatchQuery("café")).toBe('"café"*');
  });
});

describe("windowRange — 'tonight' has to mean tonight in the Bay, not in UTC", () => {
  // Fri 2026-07-24T20:00:00Z = Fri 13:00 PDT (UTC-7).
  const NOW = Date.parse("2026-07-24T20:00:00Z");

  it("is the Bay timezone", () => {
    expect(BAY_TZ).toBe("America/Los_Angeles");
  });

  it("undefined window ⇒ 'upcoming' — a 6h grace so in-progress events still show", () => {
    const r = windowRange(undefined, NOW);
    expect(r.from).toBe(new Date(NOW - 6 * 3600_000).toISOString());
    expect(r.to).toBeUndefined();
  });

  it("'today' ends at local midnight, not UTC midnight", () => {
    const r = windowRange("today", NOW);
    // local midnight Sat 2026-07-25 00:00 PDT = 07:00Z
    expect(r.to).toBe("2026-07-25T07:00:00.000Z");
    expect(Date.parse(r.from!)).toBeLessThanOrEqual(NOW);
  });

  it("'tonight' starts in the local evening and runs past midnight", () => {
    const r = windowRange("tonight", NOW);
    expect(r.from).toBe("2026-07-25T00:00:00.000Z"); // 17:00 PDT today
    expect(r.to).toBe("2026-07-25T11:00:00.000Z"); // 04:00 PDT tomorrow
  });

  it("'tonight' asked at 11pm local does not rewind to 5pm", () => {
    const late = Date.parse("2026-07-25T06:00:00Z"); // Fri 23:00 PDT
    const r = windowRange("tonight", late);
    expect(Date.parse(r.from!)).toBeLessThanOrEqual(late);
    expect(Date.parse(r.from!)).toBeGreaterThan(late - 2 * 3600_000);
  });

  it("'weekend' on a Friday means from now through Sunday night", () => {
    const r = windowRange("weekend", NOW);
    expect(Date.parse(r.from!)).toBeLessThanOrEqual(NOW);
    expect(r.to).toBe("2026-07-27T11:00:00.000Z"); // Mon 04:00 PDT
  });

  it("'weekend' on a Tuesday means the UPCOMING Friday, not right now", () => {
    const tue = Date.parse("2026-07-21T20:00:00Z"); // Tue 13:00 PDT
    const r = windowRange("weekend", tue);
    expect(r.from).toBe("2026-07-24T07:00:00.000Z"); // Fri 00:00 PDT
    expect(r.to).toBe("2026-07-27T11:00:00.000Z"); // Mon 04:00 PDT
  });

  it("'7d' and '30d' are rolling windows off now", () => {
    expect(windowRange("7d", NOW).to).toBe(new Date(NOW + 7 * 86400_000).toISOString());
    expect(windowRange("30d", NOW).to).toBe(new Date(NOW + 30 * 86400_000).toISOString());
  });

  it("always returns from <= to", () => {
    for (const w of ["tonight", "today", "weekend", "7d", "30d"] as const) {
      const r = windowRange(w, NOW);
      expect(Date.parse(r.from!)).toBeLessThanOrEqual(Date.parse(r.to!));
    }
  });
});
