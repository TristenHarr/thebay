/**
 * The gym's rules and its state machine, pure.
 *
 * `parseBounties` is TOTAL on purpose, in the spirit of src/core/places/fields.ts:
 * "a bad proposal must not be able to break every reader of that kind." A gym with one
 * corrupt bounty must still render its other three, and an attendee's card must never
 * 500 because a host typed something odd into a form.
 *
 * `flatAllocation` prorates. That is a product decision with teeth: if a host promises
 * "50 XP to everyone" and 40 people show up against a 1,500 budget, paying the first 30
 * in full and nothing to the last 10 makes the host a liar to ten people. Everyone
 * getting 37 does not.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_BOUNTIES,
  parseBounties,
  serializeBounties,
  canArm,
  canAward,
  canSettle,
  autoSettleAtMs,
  flatAllocation,
  type GymFacts,
} from "../src/core/gym/policy";

const EV = { startUtc: "2026-07-01T18:00:00Z", endUtc: "2026-07-01T21:00:00Z" };
const START = Date.parse(EV.startUtc);
const END = Date.parse(EV.endUtc);

const gym = (over: Partial<GymFacts> = {}): GymFacts => ({
  mode: "flat",
  flatXp: 50,
  bounties: [],
  budget: 1000,
  spent: 0,
  status: "draft",
  ...over,
});

describe("parseBounties — total, never throws", () => {
  it("survives every shape of garbage", () => {
    for (const bad of [null, undefined, "", "{", "[", "not json", 42, {}, [1, 2, 3], [null], [{}], true]) {
      const out = parseBounties(bad as unknown);
      expect(Array.isArray(out), JSON.stringify(bad)).toBe(true);
    }
    expect(parseBounties("[]")).toEqual([]);
  });

  it("accepts a JSON string and an already-parsed array alike", () => {
    const one = [{ key: "best_demo", label: "Best demo", xp: 100 }];
    expect(parseBounties(JSON.stringify(one))).toHaveLength(1);
    expect(parseBounties(one)).toHaveLength(1);
  });

  it("clamps XP into the payable range instead of rejecting the row", () => {
    expect(parseBounties([{ key: "a", label: "A", xp: -5 }])[0]!.xp).toBe(1);
    expect(parseBounties([{ key: "b", label: "B", xp: 1e9 }])[0]!.xp).toBe(1000);
    expect(parseBounties([{ key: "c", label: "C", xp: "10" }])[0]!.xp).toBe(10);
    expect(parseBounties([{ key: "d", label: "D", xp: 12.7 }])[0]!.xp).toBe(13);
  });

  it("drops entries with no usable key or label rather than inventing one", () => {
    expect(parseBounties([{ key: "", label: "A", xp: 10 }])).toEqual([]);
    expect(parseBounties([{ key: "a", label: "   ", xp: 10 }])).toEqual([]);
    expect(parseBounties([{ key: "a", xp: 10 }])).toEqual([]);
    expect(parseBounties([{ key: "999", label: "A", xp: 10 }]), "a key must start with a letter").toEqual([]);
  });

  it("slugifies a key the host typed by hand", () => {
    expect(parseBounties([{ key: "Best Demo!", label: "Best demo", xp: 10 }])[0]!.key).toBe("best_demo");
  });

  it("keeps the first of a duplicated key", () => {
    const out = parseBounties([
      { key: "a", label: "First", xp: 10 },
      { key: "a", label: "Second", xp: 20 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("First");
  });

  it("caps the list so one gym cannot carry a hundred prices", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ key: `k${i}`, label: `L${i}`, xp: 5 }));
    expect(parseBounties(many)).toHaveLength(MAX_BOUNTIES);
  });

  it("round-trips through serialize", () => {
    const b = parseBounties([{ key: "best_demo", label: "Best demo", xp: 100, badgeSlug: "demo_king" }]);
    expect(parseBounties(serializeBounties(b))).toEqual(b);
  });
});

describe("the state machine", () => {
  it("arms only from draft", () => {
    expect(canArm(gym({ status: "draft" }), EV, START - 3600_000)).toBe("ok");
    expect(canArm(gym({ status: "armed" }), EV, START - 3600_000)).toBe("not_draft");
    expect(canArm(gym({ status: "settled" }), EV, START - 3600_000)).toBe("not_draft");
  });

  it("refuses to arm a policy that promises nothing it can pay", () => {
    expect(canArm(gym({ mode: "flat", flatXp: 0 }), EV, START)).toBe("empty_policy");
    expect(canArm(gym({ mode: "bounty", bounties: [] }), EV, START)).toBe("empty_policy");
    // 'none' is a legitimate public declaration — "I am not awarding XP" — so it arms.
    expect(canArm(gym({ mode: "none", flatXp: 0 }), EV, START)).toBe("ok");
  });

  it("refuses to arm long after the event is over", () => {
    expect(canArm(gym(), EV, END + 1000 * 3600 * 24 * 30)).toBe("too_late");
  });

  it("awards only into an armed gym, inside the window", () => {
    const armed = gym({ status: "armed" });
    expect(canAward(armed, EV, START + 1000)).toBe("ok");
    expect(canAward(armed, EV, START - 30 * 60_000), "half an hour before doors").toBe("ok");
    expect(canAward(gym({ status: "draft" }), EV, START)).toBe("not_armed");
    expect(canAward(gym({ status: "settled" }), EV, START)).toBe("already_settled");
    expect(canAward(armed, EV, START - 1000 * 3600 * 24)).toBe("too_early");
    expect(canAward(armed, EV, END + 1000 * 3600 * 24 * 7)).toBe("too_late");
  });

  it("refuses to award from a gym with no budget left", () => {
    expect(canAward(gym({ status: "armed", budget: 500, spent: 500 }), EV, START)).toBe("no_budget");
    expect(canAward(gym({ status: "armed", budget: 0, spent: 0 }), EV, START)).toBe("no_budget");
  });

  it("settles from armed, once", () => {
    expect(canSettle(gym({ status: "armed" }), EV, END)).toBe("ok");
    expect(canSettle(gym({ status: "settled" }), EV, END)).toBe("already_settled");
    expect(canSettle(gym({ status: "draft" }), EV, END)).toBe("not_armed");
  });

  it("is total — a garbage event window never throws and never silently opens the door", () => {
    const broken = { startUtc: "nonsense", endUtc: null };
    for (const fn of [canArm, canAward, canSettle]) {
      const v = fn(gym({ status: "armed" }), broken, Date.now());
      expect(typeof v).toBe("string");
    }
    expect(canAward(gym({ status: "armed" }), broken, Date.now())).toBe("too_late");
  });
});

describe("autoSettleAtMs", () => {
  it("settles 48h after the end", () => {
    expect(autoSettleAtMs(EV)).toBe(END + 48 * 3600_000);
  });

  it("assumes a duration when the event has no end — most scraped ones don't", () => {
    const noEnd = { startUtc: EV.startUtc, endUtc: null };
    expect(autoSettleAtMs(noEnd)).toBeGreaterThan(START);
    expect(Number.isFinite(autoSettleAtMs(noEnd))).toBe(true);
  });
});

describe("flatAllocation — prorates rather than paying the early arrivals", () => {
  it("pays the promised rate when the budget covers the room", () => {
    expect(flatAllocation(50, 10, 1000)).toEqual({ perAttendee: 50, total: 500, prorated: false });
  });

  it("cuts everyone equally when the room is bigger than the promise", () => {
    const a = flatAllocation(100, 50, 3000);
    expect(a).toEqual({ perAttendee: 60, total: 3000, prorated: true });
  });

  it("never overspends the budget after rounding", () => {
    for (const [xp, n, budget] of [
      [100, 7, 500],
      [50, 3, 100],
      [10, 999, 1000],
      [1, 1, 0],
    ] as const) {
      const a = flatAllocation(xp, n, budget);
      expect(a.total, `${xp}×${n} of ${budget}`).toBeLessThanOrEqual(budget);
      expect(a.perAttendee * n).toBe(a.total);
      expect(Number.isInteger(a.perAttendee)).toBe(true);
    }
  });

  it("is total for an empty room and hostile numbers", () => {
    expect(flatAllocation(50, 0, 1000)).toEqual({ perAttendee: 0, total: 0, prorated: false });
    expect(flatAllocation(NaN, 5, 1000).perAttendee).toBe(0);
    expect(flatAllocation(50, -3, 1000).perAttendee).toBe(0);
    expect(flatAllocation(50, 5, NaN).perAttendee).toBe(0);
  });
});
