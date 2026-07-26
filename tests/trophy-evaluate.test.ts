/**
 * The evaluator is PURE, and that is the whole point: the same function decides what
 * the Worker grants and what the browser draws in the trophy case, so a locked
 * trophy's progress bar can never disagree with the award that eventually fires.
 * Mirrors the discipline in src/core/xp/levels.ts.
 */
import { describe, it, expect } from "vitest";
import { evaluate, emptyMetrics, type TrophyMetrics } from "../src/core/trophies/evaluate";
import { TROPHIES, trophyById } from "../src/core/trophies/catalog";

const m = (over: Partial<TrophyMetrics> = {}): TrophyMetrics => ({ ...emptyMetrics(), ...over });

describe("evaluate — trophies from a metric snapshot", () => {
  it("earns nothing from a blank slate", () => {
    const r = evaluate(m());
    expect(r.earned).toEqual([]);
    // …but still reports every trophy as progress, so the case renders locked rungs.
    expect(r.progress.length).toBe(TROPHIES.length);
    for (const p of r.progress) expect(p.earned).toBe(false);
  });

  it("earns exactly AT the threshold, not one past it", () => {
    const t = trophyById("first_checkin")!;
    expect(t.threshold).toBe(1);
    expect(evaluate(m({ checkins: 0 })).earned).not.toContain("first_checkin");
    expect(evaluate(m({ checkins: 1 })).earned).toContain("first_checkin");
  });

  it("earns every lower rung when a high metric arrives at once", () => {
    // A backfill (or a busy month) can jump a user straight past three tiers; the
    // ladder must not need to be climbed one grant at a time.
    const earned = evaluate(m({ checkins: 500 })).earned;
    const showedUp = TROPHIES.filter((x) => x.metric === "checkins" && x.threshold <= 500);
    for (const t of showedUp) expect(earned, `${t.id} at 500 check-ins`).toContain(t.id);
  });

  it("is monotonic in every metric — more can never take a trophy away", () => {
    for (const metric of new Set(TROPHIES.map((t) => t.metric))) {
      const low = new Set(evaluate(m({ [metric]: 3 } as Partial<TrophyMetrics>)).earned);
      const high = evaluate(m({ [metric]: 3000 } as Partial<TrophyMetrics>)).earned;
      for (const id of low) expect(high, `${metric}: ${id} lost at a higher value`).toContain(id);
    }
  });

  it("clamps progress to 0..1 and never reports negative remaining", () => {
    const r = evaluate(m({ checkins: 9999, reviews: -5 as number }));
    for (const p of r.progress) {
      expect(p.pct, p.id).toBeGreaterThanOrEqual(0);
      expect(p.pct, p.id).toBeLessThanOrEqual(1);
      expect(p.remaining, p.id).toBeGreaterThanOrEqual(0);
    }
  });

  it("is total: garbage in a metric does not throw and does not earn", () => {
    const bad = m({ checkins: NaN, reviews: Infinity, shadows: -1 });
    const r = evaluate(bad);
    expect(r.earned).not.toContain("first_checkin"); // NaN is not ≥ 1
    expect(r.earned).toContain("first_review"); // Infinity legitimately clears it
    for (const p of r.progress) expect(Number.isFinite(p.pct), p.id).toBe(true);
  });

  it("suggests the closest unearned trophies, nearest first", () => {
    // 8 check-ins: tier 1 (1) earned, tier 2 (10) is 80% there and should lead.
    const r = evaluate(m({ checkins: 8 }));
    expect(r.nextUp.length).toBeGreaterThan(0);
    expect(r.nextUp.length).toBeLessThanOrEqual(3);
    for (const n of r.nextUp) expect(n.earned).toBe(false);
    for (let i = 1; i < r.nextUp.length; i++) {
      expect(r.nextUp[i]!.pct).toBeLessThanOrEqual(r.nextUp[i - 1]!.pct);
    }
    expect(r.nextUp[0]!.pct).toBeGreaterThan(0);
  });

  it("never suggests a secret trophy — that would spoil it", () => {
    const r = evaluate(m({ checkins: 150, shadows: 150, intros: 90 }));
    for (const n of r.nextUp) expect(trophyById(n.id)!.secret, `${n.id} leaked`).toBeFalsy();
  });

  it("still EARNS secret trophies when the threshold is met", () => {
    const secret = TROPHIES.find((t) => t.secret)!;
    const r = evaluate(m({ [secret.metric]: secret.threshold } as Partial<TrophyMetrics>));
    expect(r.earned).toContain(secret.id);
  });

  it("totals the XP a set of trophies is worth", () => {
    const r = evaluate(m({ checkins: 1 }));
    expect(r.xp).toBe(trophyById("first_checkin")!.xp);
  });
});
