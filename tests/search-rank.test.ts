import { describe, it, expect } from "vitest";
import {
  fuse,
  fuseIds,
  byRecency,
  byQuality,
  RRF_K,
  DEFAULT_WEIGHTS,
  type RankLists,
} from "../src/core/search/rank";

/**
 * Reciprocal rank fusion is the whole ranking brain of hybrid search, and it is a
 * pure function over rank lists — so it gets the heaviest tests in the track. The
 * property that matters is *agreement beats brilliance*: a result two retrievers
 * both like should outrank one that a single retriever loves.
 */
describe("fuse — reciprocal rank fusion", () => {
  it("returns [] for no lists at all and for lists that are all empty", () => {
    expect(fuse({})).toEqual([]);
    expect(fuse({ bm25: [], vector: [], recency: [], quality: [] })).toEqual([]);
  });

  it("preserves the order of a single list (fusion is a no-op on one retriever)", () => {
    expect(fuseIds({ bm25: ["a", "b", "c"] })).toEqual(["a", "b", "c"]);
  });

  it("scores by Σ w/(k + rank) with 1-based ranks", () => {
    const [top] = fuse({ bm25: ["a"] }, { bm25: 1 });
    expect(top!.score).toBeCloseTo(1 / (RRF_K + 1), 12);
    const [second] = fuse({ bm25: ["x", "a"] }, { bm25: 1 }).filter((r) => r.id === "a");
    expect(second!.score).toBeCloseTo(1 / (RRF_K + 2), 12);
  });

  it("an item ranked well in TWO lists outranks one ranked great in a single list", () => {
    // `solo` is #1 in bm25 and nowhere else; `both` is only #2 in each of two lists.
    const lists: RankLists = { bm25: ["solo", "both"], vector: ["x", "both"] };
    expect(fuseIds(lists, { bm25: 1, vector: 1 })).toEqual(["both", "solo", "x"]);
  });

  it("fusion beats either list alone: the item both retrievers agree on wins", () => {
    // bm25 alone says A (and buries B); vector alone says B (and buries A);
    // the only thing they agree on is that C is good.
    const lists: RankLists = { bm25: ["A", "C", "x", "y", "B"], vector: ["B", "C", "y", "x", "A"] };
    expect(fuseIds({ bm25: lists.bm25 })[0]).toBe("A");
    expect(fuseIds({ vector: lists.vector })[0]).toBe("B");
    expect(fuseIds(lists, { bm25: 1, vector: 1 })[0]).toBe("C");
  });

  it("honours per-list weights — a heavier retriever can carry a result", () => {
    const lists: RankLists = { bm25: ["b"], vector: ["v"] };
    expect(fuseIds(lists, { bm25: 10, vector: 1 })).toEqual(["b", "v"]);
    expect(fuseIds(lists, { bm25: 1, vector: 10 })).toEqual(["v", "b"]);
  });

  it("a zero-weight list contributes nothing but does not introduce ids", () => {
    const out = fuse({ bm25: ["a"], recency: ["z"] }, { bm25: 1, recency: 0 });
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  it("breaks exact ties deterministically by id so paging never shuffles", () => {
    const a = fuseIds({ bm25: ["b", "a"], vector: ["a", "b"] }, { bm25: 1, vector: 1 });
    const b = fuseIds({ bm25: ["b", "a"], vector: ["a", "b"] }, { bm25: 1, vector: 1 });
    expect(a).toEqual(b);
    expect(a).toEqual(["a", "b"]); // identical scores → lexical id order
  });

  it("ignores duplicate ids inside one list — the first (best) rank wins", () => {
    const out = fuse({ bm25: ["a", "a", "b"] }, { bm25: 1 });
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out[0]!.score).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  it("reports per-list contributions so a result is explainable", () => {
    const [top] = fuse({ bm25: ["a"], vector: ["a"] }, { bm25: 1, vector: 2 });
    expect(top!.contributions.bm25).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(top!.contributions.vector).toBeCloseTo(2 / (RRF_K + 1), 12);
    expect(top!.contributions.recency).toBeUndefined();
  });

  it("defaults weight every list, so omitting weights still fuses all four", () => {
    const out = fuse({ bm25: ["a"], vector: ["b"], recency: ["c"], quality: ["d"] });
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(DEFAULT_WEIGHTS.bm25).toBeGreaterThan(0);
  });

  it("a bigger k flattens the curve (later ranks lose less)", () => {
    const tight = fuse({ bm25: ["a", "b"] }, { bm25: 1 }, 1);
    const flat = fuse({ bm25: ["a", "b"] }, { bm25: 1 }, 1000);
    const ratio = (r: { score: number }[]) => r[1]!.score / r[0]!.score;
    expect(ratio(flat)).toBeGreaterThan(ratio(tight));
  });
});

describe("list builders (pure, no I/O)", () => {
  const rows = [
    { id: "far", startUtc: "2026-09-01T00:00:00Z", interestScore: 90 },
    { id: "soon", startUtc: "2026-07-27T00:00:00Z", interestScore: 10 },
    { id: "past", startUtc: "2026-07-01T00:00:00Z", interestScore: 50 },
    { id: "null", startUtc: "2026-08-01T00:00:00Z", interestScore: null },
  ];
  const NOW = Date.parse("2026-07-26T00:00:00Z");

  it("byRecency puts the soonest upcoming event first and past events last", () => {
    expect(byRecency(rows, NOW)).toEqual(["soon", "null", "far", "past"]);
  });

  it("byQuality sorts by interest score desc, unscored last, ties by id", () => {
    expect(byQuality(rows)).toEqual(["far", "past", "soon", "null"]);
  });

  it("both builders are total on an empty input", () => {
    expect(byRecency([], NOW)).toEqual([]);
    expect(byQuality([])).toEqual([]);
  });
});
