import { describe, it, expect } from "vitest";
import {
  VIBE_AXES,
  blendVibe,
  reportWeight,
  vibeConfidence,
  hostWeight,
  meanAxes,
  mixAxes,
  clampAxis,
  normalizeCrowd,
  baselinePredict,
  templateHeadline,
  templateBlurb,
  deriveBestFor,
  deriveExpect,
  HOST_MIN_EVENTS,
  REPORTED_MIN,
  type VibeAxes,
  type VibeReport,
} from "../src/core/vibe";

/** A flat axes object — every axis at the same value. Keeps the arithmetic obvious. */
const flat = (n: number): VibeAxes => Object.fromEntries(VIBE_AXES.map((a) => [a, n])) as VibeAxes;
const rep = (n: number, verified = true): VibeReport => ({ ...flat(n), verified });

describe("axis helpers", () => {
  it("clamps and integerises an axis, rejecting junk", () => {
    expect(clampAxis(50)).toBe(50);
    expect(clampAxis(-20)).toBe(0);
    expect(clampAxis(400)).toBe(100);
    expect(clampAxis(63.6)).toBe(64);
    expect(clampAxis("nope")).toBeNull();
    expect(clampAxis(null)).toBeNull();
    expect(clampAxis(NaN)).toBeNull();
  });

  it("means a set of axes", () => {
    expect(meanAxes([flat(0), flat(100)])).toEqual(flat(50));
    expect(meanAxes([])).toBeNull();
  });

  it("mixes two axis sets by weight", () => {
    expect(mixAxes(flat(0), flat(100), 0.25)).toEqual(flat(25));
    expect(mixAxes(flat(0), flat(100), 0)).toEqual(flat(0));
    expect(mixAxes(flat(0), flat(100), 1)).toEqual(flat(100));
  });
});

describe("the blend weights", () => {
  it("w = n/(n+3) — three verified reports weigh exactly as much as the prior", () => {
    expect(reportWeight(0)).toBe(0);
    expect(reportWeight(3)).toBeCloseTo(0.5, 10);
    expect(reportWeight(9)).toBeCloseTo(0.75, 10);
  });

  it("conf = min(0.95, 0.3 + 0.15n), monotonic and capped", () => {
    expect(vibeConfidence(0)).toBeCloseTo(0.3, 10);
    expect(vibeConfidence(1)).toBeCloseTo(0.45, 10);
    expect(vibeConfidence(4)).toBeCloseTo(0.9, 10);
    expect(vibeConfidence(5)).toBeCloseTo(0.95, 10);
    expect(vibeConfidence(500)).toBeCloseTo(0.95, 10);
    // never decreases as evidence accumulates
    for (let n = 0; n < 30; n++) expect(vibeConfidence(n + 1)).toBeGreaterThanOrEqual(vibeConfidence(n));
  });

  it("a host track record only counts once it is earned (>= 3 reported events)", () => {
    for (let n = 0; n < HOST_MIN_EVENTS; n++) expect(hostWeight(n)).toBe(0);
    expect(hostWeight(3)).toBeCloseTo(0.5, 10);
    expect(hostWeight(9)).toBeLessThanOrEqual(0.6); // capped: a listing always counts
    expect(hostWeight(9)).toBeGreaterThan(hostWeight(4));
  });
});

describe("blendVibe", () => {
  it("with zero reports the result IS the prediction, marked predicted", () => {
    const predicted = { energy: 70, formality: 30, intimacy: 40, talkRatio: 20, signal: 80, approachability: 65 };
    const out = blendVibe({ predicted, reports: [] });
    expect(out.axes).toEqual(predicted);
    expect(out.source).toBe("predicted");
    expect(out.nReports).toBe(0);
    expect(out.confidence).toBeCloseTo(0.3, 10);
  });

  it("one verified report moves the blend by exactly w = 1/4", () => {
    const out = blendVibe({ predicted: flat(20), reports: [rep(100)] });
    expect(out.axes).toEqual(flat(40)); // 0.25*100 + 0.75*20
    expect(out.source).toBe("blended");
    expect(out.nReports).toBe(1);
  });

  it("converges to the verified mean as reports accumulate", () => {
    const predicted = flat(20);
    const dist = (n: number) => Math.abs(blendVibe({ predicted, reports: Array.from({ length: n }, () => rep(80)) }).axes.energy - 80);
    const ns = [1, 2, 5, 10, 50];
    for (let i = 1; i < ns.length; i++) expect(dist(ns[i]!)).toBeLessThan(dist(ns[i - 1]!));
    expect(dist(1000)).toBeLessThanOrEqual(1);
  });

  it("UNVERIFIED reports never move the blend — no check-in, no vote", () => {
    const predicted = flat(20);
    const withNoise = blendVibe({ predicted, reports: [rep(100, false), rep(0, false), rep(100, false)] });
    expect(withNoise.axes).toEqual(predicted);
    expect(withNoise.source).toBe("predicted");
    expect(withNoise.nReports).toBe(0);
    expect(withNoise.nUnverified).toBe(3);
    expect(withNoise.confidence).toBeCloseTo(0.3, 10);
  });

  it("mixes verified and unverified: only the verified ones count", () => {
    const only = blendVibe({ predicted: flat(20), reports: [rep(100)] });
    const plusNoise = blendVibe({ predicted: flat(20), reports: [rep(100), rep(0, false), rep(0, false)] });
    expect(plusNoise.axes).toEqual(only.axes);
    expect(plusNoise.nReports).toBe(1);
  });

  it("becomes 'reported' once the room has spoken loudly enough", () => {
    const many = Array.from({ length: REPORTED_MIN }, () => rep(80));
    expect(blendVibe({ predicted: flat(20), reports: many }).source).toBe("reported");
    expect(blendVibe({ predicted: flat(20), reports: many.slice(0, REPORTED_MIN - 1) }).source).toBe("blended");
  });

  it("confidence is monotonic in the number of VERIFIED reports", () => {
    let prev = -1;
    for (let n = 0; n <= 10; n++) {
      const c = blendVibe({ predicted: flat(50), reports: Array.from({ length: n }, () => rep(80)) }).confidence;
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });

  it("a host's earned track record shifts the PRIOR, not the report weighting", () => {
    const predicted = flat(20);
    const host = { events: 3, axes: flat(80) };
    const out = blendVibe({ predicted, reports: [], host });
    expect(out.axes).toEqual(flat(50)); // 0.5 * 80 + 0.5 * 20
    expect(out.prior).toEqual(flat(50));
    expect(out.source).toBe("predicted"); // still nobody has reported THIS room
    expect(out.nReports).toBe(0);
  });

  it("an unearned track record (< 3 reported events) is ignored — caliber must be earned", () => {
    const predicted = flat(20);
    const out = blendVibe({ predicted, reports: [], host: { events: 2, axes: flat(80) } });
    expect(out.axes).toEqual(predicted);
  });

  it("attendee reports override the host prior as they pile up", () => {
    const host = { events: 3, axes: flat(100) };
    const withReports = blendVibe({ predicted: flat(100), reports: Array.from({ length: 40 }, () => rep(10)), host });
    expect(withReports.axes.energy).toBeLessThan(20);
  });

  it("clamps every output axis into 0..100", () => {
    const out = blendVibe({ predicted: { ...flat(50), energy: 999 }, reports: [] });
    expect(out.axes.energy).toBe(100);
  });
});

describe("crowd mix", () => {
  it("normalises shares to sum to 100", () => {
    const c = normalizeCrowd({ founders: 2, engineers: 2 });
    expect(c.founders! + c.engineers!).toBe(100);
  });
  it("drops junk and empty input", () => {
    expect(normalizeCrowd({ founders: -1 })).toEqual({});
    expect(normalizeCrowd(null)).toEqual({});
  });
});

describe("baselinePredict — the deterministic prior, with no model at all", () => {
  it("reads a happy hour as loud, casual, mingling-first", () => {
    const p = baselinePredict({ title: "Founders Happy Hour @ SoMa", categories: ["networking"] });
    expect(p.axes.talkRatio).toBeLessThan(30);
    expect(p.axes.energy).toBeGreaterThan(60);
    expect(p.axes.formality).toBeLessThan(40);
  });

  it("reads a conference as talk-heavy and formal", () => {
    const p = baselinePredict({ title: "AI Infrastructure Summit 2026" });
    expect(p.axes.talkRatio).toBeGreaterThan(70);
    expect(p.axes.formality).toBeGreaterThan(55);
    expect(p.axes.intimacy).toBeLessThan(40);
  });

  it("reads a small dinner as intimate and high-signal", () => {
    const p = baselinePredict({ title: "Founders Dinner: 12 seats" });
    expect(p.axes.intimacy).toBeGreaterThan(70);
    expect(p.axes.signal).toBeGreaterThan(65);
  });

  it("matches on WORD BOUNDARIES — 'partnership' is not a 'party'", () => {
    const partnership = baselinePredict({ title: "Enterprise Partnership Briefing" });
    const party = baselinePredict({ title: "Launch Party" });
    expect(partnership.axes.energy).toBeLessThan(party.axes.energy);
  });

  it("an invite-only room reads as higher signal than an open free one", () => {
    const curated = baselinePredict({ title: "Founders Dinner", description: "Invite only, applications reviewed." });
    const open = baselinePredict({ title: "Founders Dinner", isFree: true });
    expect(curated.axes.signal).toBeGreaterThan(open.axes.signal);
  });

  it("is a pure function — same facts, same numbers, every time", () => {
    const facts = { title: "Hardware Hackathon", categories: ["hardware"], isFree: true };
    expect(baselinePredict(facts)).toEqual(baselinePredict(facts));
  });

  it("always yields all six axes in range, a crowd mix, best-for and expectations", () => {
    for (const title of ["", "Random Thing", "Panel: The Future of X", "Coworking Jam", "Series A Pitch Night"]) {
      const p = baselinePredict({ title });
      for (const a of VIBE_AXES) {
        expect(p.axes[a]).toBeGreaterThanOrEqual(0);
        expect(p.axes[a]).toBeLessThanOrEqual(100);
        expect(Number.isInteger(p.axes[a])).toBe(true);
      }
      expect(Object.keys(p.crowd).length).toBeGreaterThan(0);
      expect(p.bestFor.length).toBeGreaterThan(0);
      expect(p.expect.length).toBeGreaterThan(0);
    }
  });
});

describe("deterministic prose (the fallback that must ALWAYS render)", () => {
  const facts = { title: "Founders Happy Hour", city: "san-francisco" };

  it("writes a strain-card headline from the numbers alone", () => {
    const h = templateHeadline({ energy: 90, formality: 15, intimacy: 30, talkRatio: 10, signal: 85, approachability: 80 }, facts);
    expect(h).toMatch(/^[A-Z]/);
    expect(h.endsWith(".")).toBe(true);
    expect(h.split(",").length).toBe(3);
    expect(h.toLowerCase()).toContain("loud");
  });

  it("headlines differ when the room differs", () => {
    const loud = templateHeadline({ energy: 95, formality: 10, intimacy: 20, talkRatio: 5, signal: 90, approachability: 90 }, facts);
    const stiff = templateHeadline({ energy: 15, formality: 90, intimacy: 80, talkRatio: 95, signal: 20, approachability: 10 }, facts);
    expect(loud).not.toBe(stiff);
  });

  it("writes a blurb that names the talk/mingle split", () => {
    const b = templateBlurb({ energy: 60, formality: 30, intimacy: 50, talkRatio: 80, signal: 70, approachability: 60 }, facts);
    expect(b.length).toBeGreaterThan(40);
    expect(b).toMatch(/80%/);
  });

  it("derives best-for tags and expectations from the axes", () => {
    const axes = { energy: 50, formality: 30, intimacy: 80, talkRatio: 20, signal: 85, approachability: 80 };
    const bf = deriveBestFor(axes, { title: "Founders Dinner" });
    expect(bf.length).toBeGreaterThan(0);
    expect(bf.length).toBeLessThanOrEqual(4);
    expect(new Set(bf).size).toBe(bf.length); // no duplicates
    expect(deriveExpect(axes, { title: "Founders Dinner" }).some((s) => /20%/.test(s))).toBe(true);
  });
});
