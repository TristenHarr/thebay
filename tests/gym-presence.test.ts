/**
 * The hardened door, policy half. Every test in this file is an attack we expect to fail.
 *
 * Structured after tests/net-invite.test.ts, because this is the same threat model: a
 * code on a screen that is worth photographing. The difference is what it buys — an
 * invite buys network membership, this buys the VERIFIED PRESENCE that host-awarded XP
 * is minted against, so it has to be at least as hard.
 */
import { describe, it, expect } from "vitest";
import {
  DOOR_TTL_MS,
  DOOR_ROTATE_MS,
  DOOR_MAX_USES,
  DOOR_RADIUS_M,
  doorWindow,
  checkPresence,
  type DoorFacts,
  type PresenceCheck,
} from "../src/core/gym/presence";
import { inBay } from "../src/core/geo";
import { haversineKm } from "../src/core/geofence";

const distanceM = (aLat: number, aLng: number, bLat: number, bLng: number) => haversineKm(aLat, aLng, bLat, bLng) * 1000;

/** Where the host is standing: a real SF address. */
const DOOR_AT = { lat: 37.7825, lng: -122.4058 };
const EV = { startUtc: "2026-07-01T18:00:00Z", endUtc: "2026-07-01T21:00:00Z" };
const START = Date.parse(EV.startUtc);

const door = (over: Partial<DoorFacts> = {}): DoorFacts => ({
  hostId: "host",
  lat: DOOR_AT.lat,
  lng: DOOR_AT.lng,
  expiresAt: new Date(START + DOOR_TTL_MS).toISOString(),
  revokedAt: null,
  uses: 0,
  maxUses: DOOR_MAX_USES,
  ...over,
});

const scanner = (over: Partial<{ id: string; lat: number; lng: number }> = {}) => ({
  id: "attendee",
  lat: DOOR_AT.lat,
  lng: DOOR_AT.lng,
  ...over,
});

const check = (d: Partial<DoorFacts>, s: Parameters<typeof scanner>[0], atMs = START): PresenceCheck =>
  checkPresence(door(d), scanner(s), EV, atMs, inBay, distanceM);

describe("door constants", () => {
  it("keeps the window short and rotates inside it", () => {
    expect(DOOR_TTL_MS).toBeLessThanOrEqual(120_000);
    expect(DOOR_ROTATE_MS).toBeLessThan(DOOR_TTL_MS);
    expect(DOOR_RADIUS_M).toBeLessThanOrEqual(250);
    expect(DOOR_MAX_USES).toBeGreaterThan(1);
  });
});

describe("checkPresence — the attacks", () => {
  it("admits somebody standing at the door during the event", () => {
    expect(check({}, {})).toBe("ok");
  });

  it("KILLS THE FORWARDED LINK: a valid code claimed from New York is out of region", () => {
    // This is the exact flaw in the shipped `?token=` check-in URL, asserted dead. The
    // secret being correct is not enough; you have to be here.
    expect(check({}, { lat: 40.7128, lng: -74.006 })).toBe("out_of_region");
  });

  it("refuses a scan from across town, even inside the Bay", () => {
    // Palo Alto, while the door is in San Francisco.
    expect(check({}, { lat: 37.4419, lng: -122.143 })).toBe("too_far");
    // ~400 m up the street: still too far for "I am in this room".
    expect(check({}, { lat: DOOR_AT.lat + 0.0036, lng: DOOR_AT.lng })).toBe("too_far");
    // ~50 m: fine.
    expect(check({}, { lat: DOOR_AT.lat + 0.00045, lng: DOOR_AT.lng })).toBe("ok");
  });

  it("KILLS PRE-MINTING: a code for an event three weeks out is too early tonight", () => {
    expect(check({ expiresAt: new Date(START - 20 * 86400_000 + DOOR_TTL_MS).toISOString() }, {}, START - 20 * 86400_000)).toBe("too_early");
  });

  it("shuts the door hours after the event ended, even for a freshly-minted code", () => {
    // A LIVE code (minted just now, unexpired) claimed a month after the event. This is
    // the case that catches a host who left the door screen running, or who reopens it
    // later to backfill favours — the event window shuts independently of the TTL.
    const late = START + 30 * 86400_000;
    expect(check({ expiresAt: new Date(late + DOOR_TTL_MS).toISOString() }, {}, late)).toBe("too_late");
  });

  it("refuses a host generating their own attendance", () => {
    // The mint cannot print its own monetary base.
    expect(check({}, { id: "host" })).toBe("self");
  });

  it("refuses a revoked code — rotation means the previous frame is dead", () => {
    expect(check({ revokedAt: new Date(START).toISOString() }, {})).toBe("revoked");
  });

  it("refuses an exhausted code", () => {
    expect(check({ uses: DOOR_MAX_USES, maxUses: DOOR_MAX_USES }, {})).toBe("exhausted");
  });

  it("refuses an expired code", () => {
    expect(check({}, {}, START + DOOR_TTL_MS + 1)).toBe("expired");
  });

  it("checks identity and liveness BEFORE geography", () => {
    // An honest attendee in the wrong place should be told about the place. Someone
    // holding a spent code should be told it's spent, not sent walking around a lobby.
    expect(check({ revokedAt: "2026-07-01T18:00:00Z" }, { lat: 40.7128, lng: -74.006 })).toBe("revoked");
    expect(check({ uses: 99 }, { lat: 40.7128, lng: -74.006 })).toBe("exhausted");
    expect(check({}, { id: "host", lat: 40.7128, lng: -74.006 })).toBe("self");
  });

  it("is total — garbage timestamps never throw and never accidentally pass", () => {
    expect(check({ expiresAt: "nonsense" }, {})).toBe("expired");
    expect(check({ expiresAt: "" }, {})).toBe("expired");
    // An unparseable event window fails CLOSED.
    expect(checkPresence(door(), scanner(), { startUtc: "nope", endUtc: null }, START, inBay, distanceM)).toBe("too_late");
  });
});

describe("doorWindow", () => {
  it("opens before doors and closes after the end", () => {
    const w = doorWindow(EV);
    expect(w.fromMs).toBeLessThan(START);
    expect(w.toMs).toBeGreaterThan(Date.parse(EV.endUtc));
  });

  it("assumes a duration for an event with no end — most of the catalog has none", () => {
    const w = doorWindow({ startUtc: EV.startUtc, endUtc: null });
    expect(Number.isFinite(w.fromMs)).toBe(true);
    expect(w.toMs).toBeGreaterThan(START);
  });
});
