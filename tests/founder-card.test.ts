/**
 * The card, and the badge namespace that keeps it honest.
 *
 * Rarity comes from `power` — activity and reputation — never from type. A VC must not be
 * rarer than an engineer, or the card becomes an argument for lying about what you are.
 */
import { describe, it, expect } from "vitest";
import { buildCard, RARITY_LABEL, type CardInput } from "../src/core/xp/card";
import type { FounderSnapshot } from "../src/core/xp/stats";
import { badgeKind, parseBadgeKind, isCanonicalKind, checkBadge, badgeSlug, BADGE_CHECK_MESSAGE, MAX_BADGE_LABEL } from "../src/core/gym/badge";
import { TROPHIES } from "../src/core/trophies/catalog";
import { FOUNDER_TYPES } from "../src/core/types/chart";

const EMPTY: FounderSnapshot = {
  technical: false,
  interests: [],
  mentorTopics: [],
  friends: 0,
  introsMade: 0,
  points: 0,
  level: 1,
  streakBest: 0,
  reviewAvg: null,
  reviewCount: 0,
  shadows: 0,
  checkins: 0,
};

const card = (over: Partial<CardInput> = {}) =>
  buildCard({
    userId: "u1",
    handle: "ann",
    displayName: "Ann",
    snapshot: EMPTY,
    xpTotal: 0,
    typeIds: [],
    ...over,
  });

describe("the founder card", () => {
  it("renders for a brand-new account without throwing", () => {
    const c = card();
    expect(c.level.level).toBe(1);
    expect(c.types).toEqual([]);
    expect(c.badges).toEqual([]);
    expect(c.tagline.trim()).not.toBe("");
    expect(RARITY_LABEL[c.rarity]).toBeTruthy();
  });

  it("draws the level bar from the XP TOTAL, not from the snapshot's level field", () => {
    // `snapshot.level` is a level (it feeds the `reach` axis); the bar needs the raw total.
    // Conflating them is why this takes both.
    expect(card({ xpTotal: 900 }).level.level).toBe(4);
    expect(card({ xpTotal: 900, snapshot: { ...EMPTY, level: 1 } }).level.level).toBe(4);
  });

  it("resolves declared types into chips with emoji and colour", () => {
    const c = card({ typeIds: ["founder", "engineer"], vouches: { founder: 3 } });
    expect(c.types.map((t) => t.id)).toEqual(["founder", "engineer"]);
    expect(c.types[0]!.emoji).toBe("🚀");
    expect(c.types[0]!.vouches).toBe(3);
    expect(c.types[1]!.vouches).toBe(0);
  });

  it("caps at two types — Pokémon's rule, and the limit at which a card stays readable", () => {
    expect(card({ typeIds: ["founder", "engineer", "vc", "angel"] }).types).toHaveLength(2);
  });

  it("degrades an unknown type to a generic chip rather than throwing", () => {
    // The vocabulary is a table; a client may be a deploy behind.
    const c = card({ typeIds: ["timelord"] });
    expect(c.types[0]!.label).toBe("timelord");
    expect(c.types[0]!.emoji).toBe("❓");
  });

  it("derives RARITY from activity, never from type", () => {
    // A VC must not out-rank an engineer for being a VC.
    const busy: FounderSnapshot = { ...EMPTY, friends: 60, introsMade: 12, points: 900, level: 8, streakBest: 9, checkins: 40, shadows: 30 };
    const asVc = card({ typeIds: ["vc"], snapshot: busy, xpTotal: 5000 });
    const asEngineer = card({ typeIds: ["engineer"], snapshot: busy, xpTotal: 5000 });
    expect(asVc.rarity).toBe(asEngineer.rarity);
    expect(asVc.stats.power).toBe(asEngineer.stats.power);
    // …and an inactive VC is commoner than an active engineer.
    expect(card({ typeIds: ["vc"] }).stats.power).toBeLessThan(asEngineer.stats.power);
  });

  it("writes a tagline from the record, not from a bio", () => {
    const connector = card({ typeIds: ["founder"], snapshot: { ...EMPTY, friends: 80, introsMade: 20 } });
    expect(connector.tagline).toContain("Founder");
    expect(connector.tagline).toContain("connector");
    expect(card().tagline).toMatch(/new around here/i);
  });

  it("carries badges with their provenance intact", () => {
    // "awarded by @handle at ‹event›" is the real defence against a badge posing as a system
    // trophy, so the card must never drop it.
    const c = card({
      badges: [{ id: "b1", label: "Best Demo", emoji: "🏅", color: "#fff", awardedBy: "sam", eventTitle: "Founders Night", awardedAt: "2026-07-01T00:00:00Z" }],
    });
    expect(c.badges[0]!.awardedBy).toBe("sam");
    expect(c.badges[0]!.eventTitle).toBe("Founders Night");
  });
});

describe("badge namespacing", () => {
  it("round-trips a badge kind", () => {
    expect(parseBadgeKind(badgeKind("01HABC"))).toBe("01HABC");
    expect(badgeKind("01HABC")).toContain(":");
  });

  it("tells a host badge from a canonical trophy, both ways", () => {
    expect(isCanonicalKind("local_legend")).toBe(true);
    expect(isCanonicalKind(badgeKind("01H"))).toBe(false);
    expect(parseBadgeKind("local_legend")).toBeNull();
    expect(parseBadgeKind("gym:")).toBeNull();
  });

  it("can never collide with a real trophy id", () => {
    // The whole guarantee: no trophy id contains a colon, every badge kind does.
    for (const t of TROPHIES) {
      expect(isCanonicalKind(t.id), t.id).toBe(true);
      expect(parseBadgeKind(t.id), t.id).toBeNull();
    }
  });
});

describe("checkBadge — impersonation is a LABEL problem", () => {
  it("accepts an ordinary badge", () => {
    expect(checkBadge({ label: "Best Demo", emoji: "🏅" })).toBe("ok");
  });

  it("REFUSES a system trophy's name, however it's disguised", () => {
    // Namespacing stops collision but not counterfeiting — nothing else prevents a host
    // minting "Local Legend" with the same emoji.
    for (const label of ["Local Legend", "local legend", "local  legend", "L0cal-Legend!", "LOCAL_LEGEND", "l0ca1 1egend"]) {
      expect(checkBadge({ label, emoji: "🏅" }), label).toBe("reserved");
    }
  });

  it("refuses a badge with no icon — an unrenderable badge is not a badge", () => {
    expect(checkBadge({ label: "Best Demo", emoji: "" })).toBe("no_emoji");
    expect(checkBadge({ label: "Best Demo", emoji: "   " })).toBe("no_emoji");
  });

  it("refuses blank and overlong names", () => {
    expect(checkBadge({ label: "   ", emoji: "🏅" })).toBe("blank");
    expect(checkBadge({ label: "x".repeat(MAX_BADGE_LABEL + 1), emoji: "🏅" })).toBe("too_long");
  });

  it("has copy for every refusal, so a host knows what to change", () => {
    for (const [k, msg] of Object.entries(BADGE_CHECK_MESSAGE)) {
      if (k !== "ok") expect(msg.trim(), k).not.toBe("");
    }
  });

  it("does not reserve a founder type's name — those are a different vocabulary", () => {
    // "Founder" is a type, not a trophy. A host may absolutely mint a badge called that.
    for (const t of FOUNDER_TYPES) expect(checkBadge({ label: t.label, emoji: "🏅" }), t.label).toBe("ok");
  });
});

describe("badgeSlug", () => {
  it("makes a stable, URL-safe key", () => {
    expect(badgeSlug("Best Demo!")).toBe("best_demo");
    expect(badgeSlug("  Stayed Till The End  ")).toBe("stayed_till_the_end");
  });

  it("is total — returns empty rather than throwing on unusable input", () => {
    expect(badgeSlug("!!!")).toBe("");
    expect(badgeSlug("")).toBe("");
  });
});
