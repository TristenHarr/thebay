import { describe, it, expect } from "vitest";
import {
  canIParkHere,
  formatDuration,
  parkingDifficulty,
  rankParking,
  nextSweeping,
  type ParkingAttrs,
} from "../src/core/places/parking";

/**
 * Parking is the headline pain point and the only place kind whose legality is a
 * function of *time*. Everything here is wall-clock in America/Los_Angeles, so
 * the two things that break naive implementations get explicit tests: DST
 * boundaries (a "9 hours away" sweep is really 8 or 10 real hours) and week
 * wraparound (it's Saturday, sweeping is Monday, and the month rolls over).
 */

const street = (attrs: ParkingAttrs = {}) => ({ attrs: { type: "street" as const, ...attrs } });

describe("canIParkHere — street, no posted restriction", () => {
  it("is legal forever when nothing is posted", () => {
    const r = canIParkHere(street(), "2026-07-26T20:00:00.000Z");
    expect(r.legal).toBe(true);
    expect(r.until).toBeNull();
    expect(r.reason).toMatch(/no posted restriction/i);
  });
});

describe("canIParkHere — street sweeping", () => {
  const sweep: ParkingAttrs = { sweepDay: "Tue", sweepWindow: "08:00-10:00" };

  it("is ILLEGAL inside the window and says when it lifts", () => {
    // Tue 2026-07-07, 09:00 PDT = 16:00Z — mid-sweep.
    const r = canIParkHere(street(sweep), "2026-07-07T16:00:00.000Z");
    expect(r.legal).toBe(false);
    expect(r.until).toBe("2026-07-07T17:00:00.000Z"); // 10:00 PDT
    expect(r.reason).toMatch(/street sweeping/i);
  });

  it("is legal before the window, and says exactly how long for", () => {
    // Tue 2026-07-07, 05:45 PDT = 12:45Z → 2h 15m until the 08:00 sweep.
    const r = canIParkHere(street(sweep), "2026-07-07T12:45:00.000Z");
    expect(r.legal).toBe(true);
    expect(r.until).toBe("2026-07-07T15:00:00.000Z");
    expect(r.reason).toBe("Legal for 2h 15m, then street sweeping");
  });

  it("wraps around the week — Saturday now, Monday sweep", () => {
    // Sat 2026-07-25 14:00 PDT = 21:00Z; next Monday sweep starts 2026-07-27 08:00 PDT.
    const r = canIParkHere(street({ sweepDay: "Monday", sweepWindow: "08:00-10:00" }), "2026-07-25T21:00:00.000Z");
    expect(r.legal).toBe(true);
    expect(r.until).toBe("2026-07-27T15:00:00.000Z");
    expect(r.reason).toMatch(/^Legal for 1d 18h/);
  });

  it("honours week-of-month schedules (1st & 3rd Tuesday only)", () => {
    const first3rd: ParkingAttrs = { sweepDay: "Tues", sweepWindow: "08:00-10:00", sweepWeeks: [1, 3] };
    // Tue 2026-07-14 is the 2nd Tuesday — no sweeping today at all.
    const r = canIParkHere(street(first3rd), "2026-07-14T16:00:00.000Z"); // 09:00 PDT, would be mid-window
    expect(r.legal).toBe(true);
    expect(r.until).toBe("2026-07-21T15:00:00.000Z"); // the 3rd Tuesday
    // ...and the 1st Tuesday IS swept.
    const r1 = canIParkHere(street(first3rd), "2026-07-07T16:00:00.000Z");
    expect(r1.legal).toBe(false);
  });

  it("crosses the spring-forward boundary in REAL hours, not wall-clock hours", () => {
    // Sat 2026-03-07 23:00 PST → Sun 2026-03-08 08:00 PDT. Wall clock says 9h;
    // the clock springs forward at 02:00, so it is really 8h away.
    const r = canIParkHere(street({ sweepDay: "Sun", sweepWindow: "08:00-10:00" }), "2026-03-08T07:00:00.000Z");
    expect(r.legal).toBe(true);
    expect(r.until).toBe("2026-03-08T15:00:00.000Z");
    expect(r.reason).toBe("Legal for 8h, then street sweeping");
  });

  it("crosses the fall-back boundary the same way (10 real hours, 9 on the wall)", () => {
    // Sat 2026-10-31 23:00 PDT → Sun 2026-11-01 08:00 PST.
    const r = canIParkHere(street({ sweepDay: "Sun", sweepWindow: "08:00-10:00" }), "2026-11-01T06:00:00.000Z");
    expect(r.legal).toBe(true);
    expect(r.until).toBe("2026-11-01T16:00:00.000Z");
    expect(r.reason).toBe("Legal for 10h, then street sweeping");
  });

  it("nextSweeping returns null when the schedule is unusable", () => {
    expect(nextSweeping({ sweepDay: "Tue" }, new Date())).toBeNull(); // no window
    expect(nextSweeping({ sweepWindow: "08:00-10:00" }, new Date())).toBeNull(); // no day
    expect(nextSweeping({ sweepDay: "Blursday", sweepWindow: "08:00-10:00" }, new Date())).toBeNull();
    expect(nextSweeping({ sweepDay: "Tue", sweepWindow: "nonsense" }, new Date())).toBeNull();
  });
});

describe("canIParkHere — residential permit (RPP) zones", () => {
  it("caps a non-permit stay at 2h and names the zone", () => {
    const r = canIParkHere(street({ rppZone: "C" }), "2026-07-26T20:00:00.000Z");
    expect(r.legal).toBe(true);
    expect(r.until).toBe("2026-07-26T22:00:00.000Z");
    expect(r.reason).toMatch(/permit zone C/i);
  });

  it("yields to street sweeping when the sweep comes first", () => {
    // 07:00 PDT Tuesday = 14:00Z, sweep at 08:00 → 1h, sooner than the 2h RPP cap.
    const r = canIParkHere(street({ rppZone: "C", sweepDay: "Tue", sweepWindow: "08:00-10:00" }), "2026-07-07T14:00:00.000Z");
    expect(r.until).toBe("2026-07-07T15:00:00.000Z");
    expect(r.reason).toMatch(/street sweeping/i);
  });

  it("does not apply outside the posted permit hours", () => {
    // RPP 08:00-18:00; it's 20:00 PDT → unrestricted overnight.
    const r = canIParkHere(street({ rppZone: "C", rppHours: "08:00-18:00" }), "2026-07-27T03:00:00.000Z");
    expect(r.until).toBeNull();
    expect(r.reason).toMatch(/no posted restriction|overnight/i);
  });
});

describe("canIParkHere — meters, garages and lots", () => {
  it("notes the meter without calling a metered space illegal", () => {
    const r = canIParkHere(street({ meterHours: "09:00-18:00", priceHint: "$3.50/hr" }), "2026-07-27T19:00:00.000Z"); // 12:00 PDT
    expect(r.legal).toBe(true);
    expect(r.reason).toMatch(/meter/i);
    expect(r.reason).toMatch(/\$3\.50\/hr/);
  });

  it("says the meter is off outside its hours", () => {
    const r = canIParkHere(street({ meterHours: "09:00-18:00" }), "2026-07-27T05:00:00.000Z"); // 22:00 PDT
    expect(r.legal).toBe(true);
    expect(r.reason).toMatch(/free|no posted restriction/i);
  });

  it("closes a garage outside its opening hours and says when it opens", () => {
    const garage = { attrs: { type: "garage" as const, hours: "05:00-20:00" } };
    const shut = canIParkHere(garage, "2026-07-27T09:00:00.000Z"); // 02:00 PDT
    expect(shut.legal).toBe(false);
    expect(shut.until).toBe("2026-07-27T12:00:00.000Z"); // 05:00 PDT
    expect(shut.reason).toMatch(/closed/i);

    const open = canIParkHere(garage, "2026-07-27T19:00:00.000Z"); // 12:00 PDT
    expect(open.legal).toBe(true);
    expect(open.until).toBe("2026-07-28T03:00:00.000Z"); // 20:00 PDT
    expect(open.reason).toMatch(/open until/i);
  });

  it("a 24h garage is simply open", () => {
    const r = canIParkHere({ attrs: { type: "lot", priceHint: "$25/day" } }, "2026-07-27T09:00:00.000Z");
    expect(r.legal).toBe(true);
    expect(r.until).toBeNull();
    expect(r.reason).toMatch(/\$25\/day/);
  });

  it("never throws or returns NaN-ish output on garbage attributes", () => {
    const junk = [
      {},
      { attrs: null as unknown as ParkingAttrs },
      { attrs: { sweepDay: 5 as unknown as string, sweepWindow: {} as unknown as string } },
      { attrs: { type: "street" as const, rppLimitMinutes: NaN } },
    ];
    for (const p of junk) {
      const r = canIParkHere(p as { attrs?: ParkingAttrs }, "2026-07-26T20:00:00.000Z");
      expect(typeof r.legal).toBe("boolean");
      expect(typeof r.reason).toBe("string");
      expect(r.reason.length).toBeGreaterThan(0);
      if (r.until !== null) expect(Number.isNaN(Date.parse(r.until))).toBe(false);
    }
  });
});

describe("formatDuration", () => {
  it("reads the way a person would say it", () => {
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(135)).toBe("2h 15m");
    expect(formatDuration(120)).toBe("2h");
    expect(formatDuration(2520)).toBe("1d 18h");
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(-5)).toBe("0m");
  });
});

describe("parkingDifficulty — the live block-level heat signal", () => {
  const at = "2026-07-26T20:00:00.000Z";
  const tip = (hoursAgo: number, difficulty: number, minutesToFind?: number) => ({
    createdAt: new Date(Date.parse(at) - hoursAgo * 3600_000).toISOString(),
    attrs: { difficulty, ...(minutesToFind === undefined ? {} : { minutesToFind }) },
  });

  it("returns null with no tips rather than pretending to know", () => {
    expect(parkingDifficulty([], at)).toEqual({ difficulty: null, minutesToFind: null, samples: 0 });
  });

  it("averages difficulty, weighting recent tips far above old ones", () => {
    const fresh = parkingDifficulty([tip(0.1, 5), tip(72, 1)], at);
    expect(fresh.difficulty).toBeGreaterThan(4); // the 3-day-old '1' barely counts
    const old = parkingDifficulty([tip(72, 5), tip(0.1, 1)], at);
    expect(old.difficulty).toBeLessThan(2);
  });

  it("averages minutesToFind only over the tips that reported it", () => {
    const r = parkingDifficulty([tip(0.1, 4, 12), tip(0.1, 4)], at);
    expect(r.minutesToFind).toBeCloseTo(12, 5);
    expect(r.samples).toBe(2);
  });

  it("ignores out-of-range and non-numeric difficulties", () => {
    const r = parkingDifficulty(
      [tip(0.1, 9), tip(0.1, 0), { createdAt: at, attrs: { difficulty: "hard" as unknown as number } }, tip(0.1, 3)],
      at,
    );
    expect(r.difficulty).toBeCloseTo(3, 5);
    expect(r.samples).toBe(1);
  });
});

describe("rankParking — parking near a venue at the event's start time", () => {
  const at = "2026-07-07T12:45:00.000Z"; // Tue 05:45 PDT
  const VENUE = { lat: 37.7749, lng: -122.4194 };
  const mk = (id: string, dLat: number, over: Record<string, unknown> = {}) => ({
    id,
    lat: VENUE.lat + dLat,
    lng: VENUE.lng,
    attrs: { type: "street" } as ParkingAttrs,
    confirms: 2,
    disputes: 0,
    createdAt: at,
    lastConfirmedAt: null,
    halfLifeHours: 6,
    ...over,
  });

  it("prefers the closer of two equally trusted spots", () => {
    const ranked = rankParking([mk("far", 0.008), mk("near", 0.001)], { lat: VENUE.lat, lng: VENUE.lng, at });
    expect(ranked.map((r) => r.id)).toEqual(["near", "far"]);
    expect(ranked[0]!.km).toBeLessThan(ranked[1]!.km);
  });

  it("prefers the more trusted of two equidistant spots", () => {
    const ranked = rankParking([mk("shaky", 0.001, { confirms: 1, disputes: 2 }), mk("solid", 0.001, { confirms: 6 })], {
      lat: VENUE.lat, lng: VENUE.lng, at,
    });
    expect(ranked[0]!.id).toBe("solid");
  });

  it("sinks a spot that is illegal at the event's start time below a legal one further away", () => {
    const illegalClose = mk("swept", 0.0005, { attrs: { type: "street", sweepDay: "Tue", sweepWindow: "05:00-07:00" } });
    const ranked = rankParking([illegalClose, mk("ok", 0.006)], { lat: VENUE.lat, lng: VENUE.lng, at });
    expect(ranked[0]!.id).toBe("ok");
    expect(ranked.find((r) => r.id === "swept")!.legal).toBe(false);
  });

  it("drops anything beyond the radius and caps the result set", () => {
    const ranked = rankParking([mk("here", 0.001), mk("miles-away", 0.5)], { lat: VENUE.lat, lng: VENUE.lng, at, radiusKm: 1 });
    expect(ranked.map((r) => r.id)).toEqual(["here"]);
    const many = Array.from({ length: 40 }, (_, i) => mk(`p${i}`, 0.0001 * (i + 1)));
    expect(rankParking(many, { lat: VENUE.lat, lng: VENUE.lng, at, limit: 5 }).length).toBe(5);
  });

  it("carries the legality sentence through — the single most useful string on the map", () => {
    const ranked = rankParking([mk("a", 0.001)], { lat: VENUE.lat, lng: VENUE.lng, at });
    expect(ranked[0]!.reason).toMatch(/no posted restriction/i);
    expect(ranked[0]!.trust).toBeGreaterThan(0);
  });
});
