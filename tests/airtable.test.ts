import { describe, it, expect } from "vitest";
import { parseFuzzyWhen } from "../src/sources/airtable";

const NOW = new Date("2026-07-21T12:00:00Z");

describe("parseFuzzyWhen (Airtable freeform dates)", () => {
  it("parses 'Mon DD h:mmPM' into a local ISO string", () => {
    expect(parseFuzzyWhen("Aug 15 6:30PM", NOW)).toBe("2026-08-15T18:30:00");
  });

  it("resolves a year-less date to the NEAREST year, not a fabricated future one", () => {
    // "Mar 27" viewed in July 2026 is this-past-March (≈4mo back), NOT next March
    // (≈8mo ahead). The old code rolled it to 2027 and buried the event out of view.
    expect(parseFuzzyWhen("Mar 27 4:00PM", NOW)).toBe("2026-03-27T16:00:00");
  });

  it("takes the first day of a range, resolved to the nearest year", () => {
    expect(parseFuzzyWhen("Mar 20-22 4:00PM", NOW)).toBe("2026-03-20T16:00:00");
  });

  it("keeps an upcoming this-year date in this year", () => {
    expect(parseFuzzyWhen("Sep 3", NOW)).toBe("2026-09-03T09:00:00");
  });

  it("rolls to next year across the Dec→Jan boundary when that's nearest", () => {
    const dec = new Date("2026-12-20T12:00:00Z");
    // Jan 5 is ~16 days ahead (2027) vs ~11 months behind (2026) → pick 2027.
    expect(parseFuzzyWhen("Jan 5 10:00AM", dec)).toBe("2027-01-05T10:00:00");
  });

  it("defaults the time to 09:00 when none is given", () => {
    expect(parseFuzzyWhen("Sep 3", NOW)).toBe("2026-09-03T09:00:00");
  });

  it("returns null for ISO/no-month-name values (caller keeps the raw text)", () => {
    expect(parseFuzzyWhen("2026-03-27T10:00:00Z", NOW)).toBeNull();
    expect(parseFuzzyWhen("Remote", NOW)).toBeNull();
  });
});
