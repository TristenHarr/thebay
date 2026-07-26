/**
 * Pure news logic: URL canonicalization, ranking, dedup, filtering, rate limits.
 * All deterministic — a fixed clock, no I/O — so these encode the actual product
 * rules rather than restating the implementation.
 */
import { describe, it, expect } from "vitest";
import { canonicalizeUrl, urlHash, displayDomain } from "../src/news/canonical";
import { hotScore, rankStories, type Rankable } from "../src/news/rank";
import { isDuplicateTitle, pickCanonicalTitle, templateKey, isTemplateDuplicate } from "../src/news/dedup";
import { applyNewsFilter } from "../src/news/filter";
import { rateVerdict, LIMITS } from "../src/news/ratelimit";
import { looksLikeCommercialTraining } from "../src/news/summarize";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

describe("canonicalizeUrl", () => {
  it("strips tracking params but keeps meaningful query", () => {
    expect(canonicalizeUrl("https://ex.com/a?utm_source=hn&utm_medium=x&id=7"))
      .toBe("https://ex.com/a?id=7");
    expect(canonicalizeUrl("https://ex.com/a?fbclid=zz&gclid=yy&ref=hn")).toBe("https://ex.com/a");
  });

  it("normalizes host, scheme, fragment and trailing slash", () => {
    const variants = [
      "https://Example.COM/path/",
      "http://example.com/path",
      "https://www.example.com/path#section",
      "https://example.com/path/?",
    ];
    const all = variants.map(canonicalizeUrl);
    expect(new Set(all).size).toBe(1);
    expect(all[0]).toBe("https://example.com/path");
  });

  it("keeps the root path as a single slash", () => {
    expect(canonicalizeUrl("https://example.com")).toBe("https://example.com/");
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("sorts query params so order can't create a duplicate", () => {
    expect(canonicalizeUrl("https://ex.com/a?b=2&a=1")).toBe(canonicalizeUrl("https://ex.com/a?a=1&b=2"));
  });

  it("unwraps AMP and Google-redirect wrappers", () => {
    expect(canonicalizeUrl("https://example.com/story/amp/")).toBe("https://example.com/story");
    expect(canonicalizeUrl("https://www.google.com/url?q=https%3A%2F%2Fex.com%2Fa"))
      .toBe("https://ex.com/a");
  });

  it("returns null for junk rather than throwing", () => {
    for (const bad of ["", "not a url", "javascript:alert(1)", "ftp://x.com/a", "data:text/html,x"]) {
      expect(canonicalizeUrl(bad)).toBeNull();
    }
  });

  it("hashes equal canonical forms identically and differing ones distinctly", () => {
    expect(urlHash("https://Example.com/a?utm_source=x")).toBe(urlHash("https://example.com/a"));
    expect(urlHash("https://example.com/a")).not.toBe(urlHash("https://example.com/b"));
    expect(urlHash("nonsense")).toBeNull();
  });

  it("derives a display domain without www", () => {
    expect(displayDomain("https://www.semiconductor-eng.com/a/b")).toBe("semiconductor-eng.com");
    expect(displayDomain("bogus")).toBe("");
  });
});

describe("hotScore", () => {
  it("decays with age: same votes, older story ranks lower", () => {
    const young = hotScore({ votes: 50, createdAt: hoursAgo(1) }, NOW);
    const old = hotScore({ votes: 50, createdAt: hoursAgo(48) }, NOW);
    expect(young).toBeGreaterThan(old);
  });

  it("rewards votes at equal age", () => {
    expect(hotScore({ votes: 100, createdAt: hoursAgo(5) }, NOW))
      .toBeGreaterThan(hotScore({ votes: 10, createdAt: hoursAgo(5) }, NOW));
  });

  it("never returns negative or NaN, even for 0 votes or a future date", () => {
    expect(hotScore({ votes: 0, createdAt: hoursAgo(3) }, NOW)).toBeGreaterThanOrEqual(0);
    expect(hotScore({ votes: 1, createdAt: new Date(NOW + 9e6).toISOString() }, NOW)).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(hotScore({ votes: 5, createdAt: "garbage" }, NOW))).toBe(true);
  });

  it("does not collapse to zero for stories with no local votes yet", () => {
    // Every aggregated story starts with 0 local votes. If the score collapses to
    // 0 for all of them, the tie-break silently decides the entire front page.
    const a = hotScore({ votes: 0, createdAt: hoursAgo(2), externalPoints: 400 }, NOW);
    const b = hotScore({ votes: 0, createdAt: hoursAgo(2), externalPoints: 10 }, NOW);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(0);
  });

  it("still decays an unvoted story by age", () => {
    const fresh = hotScore({ votes: 0, createdAt: hoursAgo(1), externalPoints: 100 }, NOW);
    const stale = hotScore({ votes: 0, createdAt: hoursAgo(72), externalPoints: 100 }, NOW);
    expect(fresh).toBeGreaterThan(stale);
  });

  it("compresses source points so one huge story can't bury everything", () => {
    // sqrt: 2000 points is ~6.3x a 50-point story, not 40x.
    const huge = hotScore({ votes: 0, createdAt: hoursAgo(2), externalPoints: 2000 }, NOW);
    const modest = hotScore({ votes: 0, createdAt: hoursAgo(2), externalPoints: 50 }, NOW);
    expect(huge / modest).toBeLessThan(8);
  });

  it("weights a friend's vote above a stranger's", () => {
    const base = { votes: 10, createdAt: hoursAgo(4) };
    expect(hotScore({ ...base, networkVotes: 5 }, NOW)).toBeGreaterThan(hotScore(base, NOW));
  });

  it("boosts a topic the reader follows", () => {
    const base = { votes: 10, createdAt: hoursAgo(4), topics: ["hardware"] };
    expect(hotScore(base, NOW, { interests: ["hardware"] })).toBeGreaterThan(hotScore(base, NOW));
  });

  it("penalizes aggregated stories relative to local ones in the Bay view", () => {
    const at = hoursAgo(4);
    const local = hotScore({ votes: 10, createdAt: at, origin: "bay" }, NOW, { bayView: true });
    const hn = hotScore({ votes: 10, createdAt: at, origin: "hn" }, NOW, { bayView: true });
    expect(local).toBeGreaterThan(hn);
    // …and treats them evenhandedly in the aggregate view.
    const at2 = hoursAgo(4);
    expect(hotScore({ votes: 10, createdAt: at2, origin: "bay" }, NOW, { bayView: false }))
      .toBeCloseTo(hotScore({ votes: 10, createdAt: at2, origin: "hn" }, NOW, { bayView: false }), 10);
  });
});

describe("rankStories", () => {
  const mk = (id: string, votes: number, h: number, extra: Partial<Rankable> = {}): Rankable =>
    ({ id, votes, createdAt: hoursAgo(h), origin: "bay", ...extra }) as Rankable;

  it("orders hot by score and is a stable, total order", () => {
    const out = rankStories([mk("a", 5, 20), mk("b", 80, 2), mk("c", 30, 6)], "hot", NOW);
    expect(out.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("orders new strictly by recency regardless of votes", () => {
    const out = rankStories([mk("old", 900, 30), mk("fresh", 0, 1)], "new", NOW);
    expect(out.map((s) => s.id)).toEqual(["fresh", "old"]);
  });

  it("orders top by raw votes, ignoring age", () => {
    const out = rankStories([mk("a", 5, 1), mk("b", 900, 400)], "top", NOW);
    expect(out.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("orders discussed by comment count", () => {
    const out = rankStories(
      [mk("a", 100, 2, { commentCount: 1 }), mk("b", 3, 2, { commentCount: 90 })],
      "discussed", NOW,
    );
    expect(out.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("breaks ties deterministically instead of leaving order to sort chance", () => {
    const same = [mk("b", 10, 5), mk("a", 10, 5), mk("c", 10, 5)];
    const once = rankStories(same, "hot", NOW).map((s) => s.id);
    const twice = rankStories([...same].reverse(), "hot", NOW).map((s) => s.id);
    expect(once).toEqual(twice);
  });

  it("breaks equal scores toward the NEWEST story, never the oldest", () => {
    // With nothing voted on, every score can be equal — and ULIDs sort oldest-first,
    // so an id tie-break would render the front page in reverse chronological order.
    const out = rankStories(
      [mk("01OLD", 0, 40), mk("01NEW", 0, 1), mk("01MID", 0, 12)],
      "hot", NOW,
    );
    expect(out.map((s) => s.id)).toEqual(["01NEW", "01MID", "01OLD"]);
  });

  it("does not mutate its input", () => {
    const input = [mk("a", 1, 1), mk("b", 2, 2)];
    const copy = [...input];
    rankStories(input, "hot", NOW);
    expect(input).toEqual(copy);
  });
});

describe("dedup", () => {
  it("treats near-identical titles as duplicates", () => {
    expect(isDuplicateTitle("Show HN: I built a MEMS resonator", "Show HN: I built a MEMS resonator!")).toBe(true);
    expect(isDuplicateTitle("A MEMS resonator in a garage", "Garage MEMS resonator, a build log")).toBe(false);
  });

  it("prefers the cleanest title when merging sources", () => {
    expect(pickCanonicalTitle([
      "Show HN: Fabricating a MEMS resonator (2026) [pdf]",
      "Fabricating a MEMS resonator",
    ])).toBe("Fabricating a MEMS resonator");
  });

  it("falls back to the first title when there's nothing to choose between", () => {
    expect(pickCanonicalTitle(["Only one"])).toBe("Only one");
    expect(pickCanonicalTitle([])).toBe("");
  });
});

describe("applyNewsFilter", () => {
  const rows = [
    { id: "1", origin: "bay", topics: ["hardware"] },
    { id: "2", origin: "hn", topics: ["software"] },
    { id: "3", origin: "lobsters", topics: ["math"] },
    { id: "4", origin: "event", topics: ["vc"] },
    { id: "5", origin: "rss", topics: ["hardware"] },
  ] as any[];

  it("defaults to OUR content, not the firehose", () => {
    expect(applyNewsFilter(rows, { src: "bay" }).map((r) => r.id)).toEqual(["1", "4"]);
  });

  it("can open up to everything", () => {
    expect(applyNewsFilter(rows, { src: "all" })).toHaveLength(5);
  });

  it("filters to a single aggregator", () => {
    expect(applyNewsFilter(rows, { src: "hn" }).map((r) => r.id)).toEqual(["2"]);
  });

  it("intersects source and topic", () => {
    expect(applyNewsFilter(rows, { src: "all", topic: "hardware" }).map((r) => r.id)).toEqual(["1", "5"]);
  });

  it("hides dead rows in every view", () => {
    const withDead = [...rows, { id: "6", origin: "bay", topics: [], dead: 1 }] as any[];
    expect(applyNewsFilter(withDead, { src: "all" }).map((r) => r.id)).not.toContain("6");
  });
});

describe("rateVerdict", () => {
  it("allows a normal posting cadence", () => {
    expect(rateVerdict({ inWindow: 2, limit: LIMITS.submit }).ok).toBe(true);
  });

  it("blocks past the limit and says when to retry", () => {
    const v = rateVerdict({ inWindow: LIMITS.submit.max, limit: LIMITS.submit });
    expect(v.ok).toBe(false);
    expect(v.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("is stricter for submissions than for comments", () => {
    expect(LIMITS.submit.max).toBeLessThan(LIMITS.comment.max);
  });
});

describe("templateKey / isTemplateDuplicate", () => {
  it("strips the trailing city so vendor templates collapse together", () => {
    const a = templateKey("Enterprise AI Strategy Mastery 1 Day Training in San Ramon, CA");
    const b = templateKey("Enterprise AI Strategy Mastery 1 Day Training in Pleasanton, CA");
    const c = templateKey("Intelligent Enterprise AI Skills 1 Day Training – San Carlos, CA");
    expect(a).toBe(b);
    expect(a).toBe("Enterprise AI Strategy Mastery 1 Day Training");
    expect(c).toBe("Intelligent Enterprise AI Skills 1 Day Training");
  });

  it("leaves genuinely distinct titles distinct", () => {
    expect(templateKey("Hardware Founders Night: MEMS and photonics"))
      .toBe("Hardware Founders Night: MEMS and photonics");
    expect(isTemplateDuplicate("Hardware Founders Night: MEMS and photonics",
      ["Enterprise AI Strategy Mastery 1 Day Training in San Ramon, CA"])).toBe(false);
  });

  it("catches the same listing posted in another city", () => {
    expect(isTemplateDuplicate(
      "Enterprise AI Strategy Mastery 1 Day Training in Berkeley, CA",
      ["Enterprise AI Strategy Mastery 1 Day Training in San Ramon, CA"],
    )).toBe(true);
  });

  it("handles empty and odd input without throwing", () => {
    expect(templateKey("")).toBe("");
    expect(isTemplateDuplicate("", ["x"])).toBe(false);
    expect(isTemplateDuplicate("anything", [])).toBe(false);
  });
});

describe("looksLikeCommercialTraining", () => {
  it("catches the course-vendor listings that flooded the front page", () => {
    for (const t of [
      "Generative AI for Business Leaders 1 Day Training in Berkeley, CA",
      "Enterprise AI Strategy Mastery 1 Day Training in San Ramon, CA",
      "SECO - IT-Security Foundation : 2-Day Workshop in San Jose, CA",
      "Data Pipeline Engineering 2 Days Training in Oakland, CA",
      "Advanced Enterprise AI Implementation 1 Day Training in Sunnyvale, CA",
    ]) {
      expect(looksLikeCommercialTraining(t), t).toBe(true);
    }
  });

  it("leaves real community events alone", () => {
    for (const t of [
      "Hardware Founders Night: MEMS and photonics",
      "Investor Connect: Pitch & Deal Flow Night | San Jose",
      "Startup Networking San Jose: Founders, Investors & Talent Mixer",
      "Open World Hackathon: building the future of physical AI",
      "Robotics & Automation Luncheon",
      "AI & The Law: Who's Responsible When Machines Decide?",
    ]) {
      expect(looksLikeCommercialTraining(t), t).toBe(false);
    }
  });

  it("handles empty input", () => {
    expect(looksLikeCommercialTraining("")).toBe(false);
  });
});

describe("summaries inherited from a source", () => {
  it("does not render someone else's mid-word truncation", async () => {
    const { fallbackSummary, tidyFragment } = await import("../src/news/summarize");
    // Real text, from a real story on the real front page.
    const cut =
      "Artificial intelligence may do more to determine the global balance of power over the next decade " +
      "than any other force, transforming how wars are fought and who dominates t";
    expect(cut.length).toBeLessThan(180); // under OUR limit — that's why it slipped through
    const out = fallbackSummary({ description: cut, body: null, title: "x" } as any)!;
    expect(out).not.toMatch(/\bt$/);
    expect(out).toMatch(/dominates…$/);
    expect(tidyFragment(cut)).toBe(out);
  });

  it("leaves a short complete phrase alone", async () => {
    const { tidyFragment } = await import("../src/news/summarize");
    expect(tidyFragment("Bay Area Rust Meetup")).toBe("Bay Area Rust Meetup");
    expect(tidyFragment("A complete sentence that ends properly.")).toBe("A complete sentence that ends properly.");
  });

  it("leaves a long sentence that simply lacks a full stop", async () => {
    const { tidyFragment } = await import("../src/news/summarize");
    const s = "A long descriptive line about a hardware meetup in Oakland that comfortably runs past the length threshold and still ends on a whole word";
    expect(tidyFragment(s)).toBe(s + "…");
  });
});
