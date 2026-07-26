/**
 * THE ECONOMY. This is the most important test file in the gym feature.
 *
 * A gym leader is a mint. Letting a host hand out XP at will is an inflation hole and
 * a collusion hole: two people who call themselves hosts could mint unbounded XP for
 * each other, and any host could pad their friends. Three bounds close it, and each
 * one closes a different attack:
 *
 *   1. per-event budget from VERIFIED attendance  → kills the staged 2-person meetup
 *   2. per-host 30-day window cap                 → kills gym-spam
 *   3. per-recipient halving, across all events    → kills mutual collusion
 *
 * The third is the interesting one, and the last test in the first block is the whole
 * argument: the halving series converges, so the TOTAL XP one host can ever mint to one
 * person is bounded by a number — and that number is level 4.
 */
import { describe, it, expect } from "vitest";
import {
  GYM_BASE_XP,
  XP_PER_ATTENDEE,
  GYM_MIN_ATTENDEES,
  PER_RECIPIENT_CAP,
  HOST_WINDOW_CAP,
  gymBudget,
  standingMultiplier,
  recipientCap,
  type HostStanding,
} from "../src/core/gym/budget";
import { levelForXp } from "../src/core/xp/levels";

const standing = (over: Partial<HostStanding> = {}): HostStanding => ({
  settledGyms: 10,
  nps: null,
  reviewCount: 0,
  mintedInWindow: 0,
  quarantined: false,
  ...over,
});

describe("recipientCap — the collusion ceiling", () => {
  it("halves every time the same host pays the same person", () => {
    expect(recipientCap(0)).toBe(PER_RECIPIENT_CAP);
    expect(recipientCap(1)).toBe(Math.floor(PER_RECIPIENT_CAP / 2));
    expect(recipientCap(2)).toBe(Math.floor(PER_RECIPIENT_CAP / 4));
  });

  it("decays to zero and stays there, so the series terminates", () => {
    expect(recipientCap(20)).toBe(0);
    expect(recipientCap(1000)).toBe(0);
  });

  it("is total — a negative or NaN prior count falls back to the full cap", () => {
    expect(recipientCap(-1)).toBe(PER_RECIPIENT_CAP);
    expect(recipientCap(NaN)).toBe(PER_RECIPIENT_CAP);
  });

  it("BOUNDS TOTAL COLLUSION: one host can never mint more than 994 XP to one person", () => {
    // Sum the entire infinite series. Two people alternating as host, staging events
    // forever, converge on this — and no further.
    let total = 0;
    for (let n = 0; n < 200; n++) total += recipientCap(n);
    expect(total).toBe(994);
    // 994 XP is level 4 on the curve (100·(n-1)²). That is the ENTIRE payoff of a
    // perfect two-person collusion ring, and it costs them a real physical meeting
    // per award. If this assertion ever changes, the economy changed.
    expect(levelForXp(994)).toBe(4);
  });
});

describe("standingMultiplier", () => {
  it("is zero for a quarantined host, whatever else is true of them", () => {
    expect(standingMultiplier(standing({ quarantined: true, settledGyms: 500, nps: 100, reviewCount: 99 }))).toBe(0);
  });

  it("starts a brand-new host below full rate", () => {
    const m = standingMultiplier(standing({ settledGyms: 0 }));
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(1);
  });

  it("rewards a well-reviewed host but never past the ceiling", () => {
    const great = standingMultiplier(standing({ nps: 100, reviewCount: 20 }));
    const poor = standingMultiplier(standing({ nps: -100, reviewCount: 20 }));
    expect(great).toBeGreaterThan(poor);
    expect(great).toBeLessThanOrEqual(1.5);
    expect(poor).toBeGreaterThanOrEqual(0);
  });

  it("ignores NPS until there are enough reviews to mean anything", () => {
    expect(standingMultiplier(standing({ nps: 100, reviewCount: 1 }))).toBe(standingMultiplier(standing({ nps: null, reviewCount: 0 })));
  });

  it("is total and clamped for every hostile input", () => {
    for (const s of [
      standing({ nps: NaN }),
      standing({ nps: 1e9, reviewCount: 1e9 }),
      standing({ nps: -1e9, reviewCount: 1e9 }),
      standing({ settledGyms: -5 }),
      standing({ settledGyms: NaN }),
      standing({ reviewCount: NaN, nps: 50 }),
    ]) {
      const m = standingMultiplier(s);
      expect(Number.isFinite(m), JSON.stringify(s)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1.5);
    }
  });
});

describe("gymBudget", () => {
  it("gives a gym with too few verified attendees exactly nothing", () => {
    // The staged meetup: two accounts, one 'event', unbounded XP. Dead at the floor.
    for (let n = 0; n < GYM_MIN_ATTENDEES; n++) {
      const b = gymBudget(n, standing());
      expect(b.budget, `${n} attendees`).toBe(0);
      expect(b.reasons.length, "a host must always be told why they got nothing").toBeGreaterThan(0);
    }
    expect(gymBudget(GYM_MIN_ATTENDEES, standing()).budget).toBeGreaterThan(0);
  });

  it("scales with verified attendance and never decreases", () => {
    let prev = -1;
    for (let n = 0; n <= 50; n++) {
      const b = gymBudget(n, standing());
      expect(b.budget, `${n} attendees`).toBeGreaterThanOrEqual(prev);
      prev = b.budget;
    }
  });

  it("prices a full-standing gym off the base plus per-attendee rate", () => {
    const s = standing({ settledGyms: 10 }); // experienced, unreviewed ⇒ multiplier 1
    const b = gymBudget(10, s);
    expect(b.budget).toBe(Math.floor((GYM_BASE_XP + XP_PER_ATTENDEE * 10) * standingMultiplier(s)));
  });

  it("binds on the rolling window cap — gym-spam mints nothing extra", () => {
    expect(gymBudget(40, standing({ mintedInWindow: HOST_WINDOW_CAP })).budget).toBe(0);
    expect(gymBudget(40, standing({ mintedInWindow: HOST_WINDOW_CAP - 50 })).budget).toBe(50);
    expect(gymBudget(40, standing({ mintedInWindow: HOST_WINDOW_CAP + 9999 })).budget).toBe(0);
  });

  it("reports a reason whenever the budget is zero", () => {
    for (const b of [
      gymBudget(0, standing()),
      gymBudget(40, standing({ quarantined: true })),
      gymBudget(40, standing({ mintedInWindow: HOST_WINDOW_CAP })),
    ]) {
      expect(b.budget).toBe(0);
      expect(b.reasons.join(" ").trim()).not.toBe("");
    }
  });

  it("never returns a fractional or negative budget, for any input", () => {
    for (const n of [-5, 0, 3, 7.5, 1e6, NaN, Infinity]) {
      for (const s of [standing(), standing({ nps: NaN }), standing({ mintedInWindow: NaN })]) {
        const b = gymBudget(n, s);
        expect(Number.isInteger(b.budget), `${n}`).toBe(true);
        expect(b.budget).toBeGreaterThanOrEqual(0);
        expect(b.recipientCap).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
