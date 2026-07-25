import { describe, it, expect } from "vitest";
import { looksOutOfRegion } from "../src/core/normalize/region";

describe("looksOutOfRegion — high-precision drop of non-Bay noise", () => {
  it("flags other US states by their ZIP-anchored state code", () => {
    expect(looksOutOfRegion("102 North Avenue, Wake Forest, NC 27587, USA")).toBe(true);
    expect(looksOutOfRegion("For venue details reach us at: Savannah, GA 31401")).toBe(true);
    expect(looksOutOfRegion("H.O.M.E.S. Inc, 690 NE 13 Street, Fort Lauderdale, FL 33304")).toBe(true);
    expect(looksOutOfRegion("123 Main St, Austin, TX 78701")).toBe(true);
    expect(looksOutOfRegion("5th Ave, New York, NY 10001")).toBe(true);
  });

  it("flags foreign addresses (UK postcode / country names)", () => {
    expect(looksOutOfRegion("Shore Road, Brodick, KA27 8DL")).toBe(true); // Scotland
    expect(looksOutOfRegion("Brodick Golf Club, Isle of Arran, United Kingdom")).toBe(true);
    expect(looksOutOfRegion("Av. Reforma, Mexico City, Mexico")).toBe(true);
  });

  it("NEVER flags Bay / California / Santa Cruz addresses", () => {
    expect(looksOutOfRegion("447 Minna St, San Francisco, CA 94103")).toBe(false);
    expect(looksOutOfRegion("58 South 1st Street, San Jose, CA 95113")).toBe(false);
    expect(looksOutOfRegion("1415 Pacific Ave, Santa Cruz, CA 95060, USA")).toBe(false);
    expect(looksOutOfRegion("1331 1st Street, Napa, CA 94559")).toBe(false);
    // even a non-Bay CA city stays (conservative — we only drop clearly other-region)
    expect(looksOutOfRegion("6648 Lonetree Blvd, Rocklin, CA 95765")).toBe(false);
  });

  it("does NOT flag missing/ambiguous addresses (online or Bay-with-no-city — keep them)", () => {
    expect(looksOutOfRegion(null)).toBe(false);
    expect(looksOutOfRegion("")).toBe(false);
    expect(looksOutOfRegion("Online")).toBe(false);
    expect(looksOutOfRegion("Zoom")).toBe(false);
    // a street literally named "Georgia" in SF must not trip the state matcher
    expect(looksOutOfRegion("Georgia St, San Francisco, CA 94112")).toBe(false);
  });
});
