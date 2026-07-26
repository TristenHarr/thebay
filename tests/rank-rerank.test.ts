import { describe, it, expect } from "vitest";
import { rerank, eventToRankItem, type EventLike } from "../src/core/rank/rerank";
import { ANON_VIEWER, FEATURE_NAMES, type ViewerCtx } from "../src/core/rank/features";

const NOW = Date.parse("2026-07-26T12:00:00Z");

const ev = (id: string, o: Partial<EventLike> = {}): EventLike => ({
  id,
  startUtc: "2026-08-01T18:00:00Z",
  ...o,
});

const viewer = (over: Partial<ViewerCtx> = {}): ViewerCtx => ({
  tagAffinity: new Map(),
  authorAffinity: new Map(),
  checkins: 0,
  ...over,
});

const run = (items: EventLike[], over: Record<string, any> = {}) =>
  rerank({
    items,
    toRankItem: (e) => eventToRankItem(e),
    viewer: ANON_VIEWER,
    surface: "events",
    nowMs: NOW,
    ...over,
  });

describe("eventToRankItem", () => {
  it("maps the columns the candidate query already returns", () => {
    const item = eventToRankItem(
      ev("e1", { interestScore: 80, organizer: "Frontier Tower", categories: ["AI", "Hardware"], isFree: true }),
      { total: 12, friends: 2 },
    );
    expect(item.id).toBe("e1");
    expect(item.quality).toBe(80);
    expect(item.tags).toEqual(["ai", "hardware"]); // lowercased to match the affinity map
    expect(item.authorKey).toBe("frontier tower");
    expect(item.engagements).toBe(12);
    expect(item.friendEngagements).toBe(2);
    expect(item.isFree).toBe(true);
  });

  it("treats a blank organizer as no author rather than an empty group", () => {
    expect(eventToRankItem(ev("e1", { organizer: "   " })).authorKey).toBeNull();
    expect(eventToRankItem(ev("e1", { organizer: null })).authorKey).toBeNull();
  });

  it("survives missing everything", () => {
    const item = eventToRankItem(ev("e1"));
    expect(item.tags).toEqual([]);
    expect(item.quality).toBeNull();
    expect(item.engagements).toBe(0);
  });
});

describe("rerank: features are always computed, even with no model", () => {
  it("returns a full vector per candidate in the passthrough", () => {
    const out = run([ev("a", { interestScore: 50 }), ev("b")]);
    expect(out.rescored).toBe(false);
    expect(out.features.size).toBe(2);
    for (const id of ["a", "b"]) {
      expect(Object.keys(out.features.get(id)!).sort()).toEqual([...FEATURE_NAMES].sort());
    }
    // This is the bootstrap: without it, no model could ever be trained.
    expect(out.features.get("a")!.quality).toBeCloseTo(0.5, 6);
  });

  it("does NOT reorder without a model", () => {
    const out = run([ev("low", { interestScore: 1 }), ev("high", { interestScore: 99 })]);
    expect(out.items.map((e) => e.id)).toEqual(["low", "high"]); // input order, untouched
    expect(out.rescored).toBe(false);
  });

  it("an empty weight vector is still a passthrough", () => {
    const out = run([ev("a"), ev("b")], { weights: {} });
    expect(out.rescored).toBe(false);
  });

  it("handles an empty candidate set", () => {
    const out = run([]);
    expect(out.items).toEqual([]);
    expect(out.features.size).toBe(0);
  });
});

describe("rerank: a live model reorders", () => {
  it("ranks by the learned weight", () => {
    const out = run([ev("low", { interestScore: 10 }), ev("high", { interestScore: 90 })], {
      weights: { quality: 5 },
    });
    expect(out.rescored).toBe(true);
    expect(out.items.map((e) => e.id)).toEqual(["high", "low"]);
    expect(out.detail[0]!.id).toBe("high");
    expect(out.detail[0]!.score).toBeGreaterThan(out.detail[1]!.score);
  });

  it("respects a negative weight", () => {
    const out = run([ev("low", { interestScore: 10 }), ev("high", { interestScore: 90 })], {
      weights: { quality: -5 },
    });
    expect(out.items.map((e) => e.id)).toEqual(["low", "high"]);
  });

  it("applies host diversity, so one organizer cannot take the whole page", () => {
    const items = [
      ev("a1", { interestScore: 90, organizer: "Acme" }),
      ev("a2", { interestScore: 89, organizer: "Acme" }),
      ev("a3", { interestScore: 88, organizer: "Acme" }),
      ev("b1", { interestScore: 70, organizer: "Beta" }),
    ];
    const out = run(items, { weights: { quality: 5 } });
    const order = out.items.map((e) => e.id);
    expect(order[0]).toBe("a1");
    // Beta's single event climbs above Acme's third despite a lower quality score...
    expect(order.indexOf("b1")).toBeLessThan(order.indexOf("a3"));
    // ...and Acme's third is still on the page, not dropped.
    expect(order).toContain("a3");
  });

  it("demotes what this viewer has already been shown", () => {
    const out = run([ev("seen", { interestScore: 90 }), ev("fresh", { interestScore: 70 })], {
      weights: { quality: 5 },
      timesShown: new Map([["seen", 5]]),
    });
    expect(out.items.map((e) => e.id)).toEqual(["fresh", "seen"]);
    // And the logged vector records WHY, so the training row is self-explaining.
    expect(out.features.get("seen")!.novelty).toBeLessThan(out.features.get("fresh")!.novelty);
  });

  it("uses viewer affinity, not just global quality", () => {
    const out = run(
      [ev("generic", { interestScore: 90, categories: ["cooking"] }), ev("mine", { interestScore: 40, categories: ["ai"] })],
      {
        viewer: viewer({ tagAffinity: new Map([["ai", 1]]) }),
        weights: { quality: 1, tagAffinity: 6 },
      },
    );
    expect(out.items.map((e) => e.id)).toEqual(["mine", "generic"]);
  });
});

describe("rerank: exploration", () => {
  const many = Array.from({ length: 20 }, (_, i) => ev(`e${i}`, { interestScore: 100 - i }));

  it("is off unless the surface opted in", () => {
    let explored = false;
    for (let i = 0; i < 200; i++) {
      if (run(many, { viewerId: `u${i}` }).explored) explored = true;
    }
    expect(explored).toBe(false);
  });

  it("fires on a fraction of requests when enabled", () => {
    let n = 0;
    const trials = 400;
    for (let i = 0; i < trials; i++) {
      if (run(many, { explore: true, viewerId: `u${i}` }).explored) n++;
    }
    expect(n / trials).toBeGreaterThan(0.03);
    expect(n / trials).toBeLessThan(0.2);
  });

  it("never loses or duplicates a candidate when it fires", () => {
    for (let i = 0; i < 60; i++) {
      const out = run(many, { explore: true, epsilon: 1, viewerId: `u${i}` });
      expect(out.items).toHaveLength(many.length);
      expect(new Set(out.items.map((e) => e.id)).size).toBe(many.length);
    }
  });

  it("is stable across a page refresh — the same viewer and day get the same feed", () => {
    const a = run(many, { explore: true, epsilon: 0.5, viewerId: "ann" });
    const b = run(many, { explore: true, epsilon: 0.5, viewerId: "ann" });
    expect(a.items.map((e) => e.id)).toEqual(b.items.map((e) => e.id));
    expect(a.explored).toBe(b.explored);
  });

  it("still reports the features it scored, whether or not it shuffled", () => {
    const out = run(many, { explore: true, epsilon: 1, viewerId: "ann", weights: { quality: 3 } });
    expect(out.explored).toBe(true);
    expect(out.features.size).toBe(many.length);
    for (const e of many) expect(out.features.has(e.id)).toBe(true);
  });
});
