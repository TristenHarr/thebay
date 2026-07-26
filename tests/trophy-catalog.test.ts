/**
 * The trophy catalog is DATA, and these are the invariants that let the rest of the
 * system treat it as data:
 *
 *   · every id is a stable award `kind` written into `achievements`, so an id that
 *     changes silently orphans everybody's trophy;
 *   · no id contains a colon, because `gym:<ULID>` host badges rely on that being
 *     the reserved namespace (migrations/0028) — a canonical trophy called
 *     `gym:anything` would let a host badge impersonate a system award;
 *   · thresholds ascend within a series, or a tier-3 trophy could be earned before
 *     its tier-1 and the ladder renders out of order;
 *   · every legacy kind that has ALREADY been granted in production is still in the
 *     catalog, or existing users lose trophies they earned.
 */
import { describe, it, expect } from "vitest";
import { TROPHIES, TROPHY_LABELS, TROPHY_METRICS, trophyById, series, type Trophy } from "../src/core/trophies/catalog";

/** Kinds already written to `achievements` by shipped code. Losing one is a regression.
 *  Sources: platform-repo.ts (first_review/first_shadow/connector/local_legend),
 *  graph-repo.ts (intro_made), routes/vibes.ts (first_vibe), plus the three the web
 *  catalog promised but no server code ever granted. */
const LEGACY_KINDS = [
  "first_review",
  "first_shadow",
  "connector",
  "local_legend",
  "intro_made",
  "first_vibe",
  "first_checkin",
  "first_host",
  "super_connector",
];

describe("the trophy catalog", () => {
  it("is big enough to be a collection rather than a gesture", () => {
    expect(TROPHIES.length).toBeGreaterThanOrEqual(50);
  });

  it("has unique ids", () => {
    const ids = TROPHIES.map((t) => t.id);
    expect(new Set(ids).size, "duplicate trophy id").toBe(ids.length);
  });

  it("never puts a colon in an id — 'gym:' is the reserved host-badge namespace", () => {
    for (const t of TROPHIES) expect(t.id, `${t.id} must not contain ':'`).not.toContain(":");
  });

  it("gives every trophy a name, a flavor line and an icon", () => {
    for (const t of TROPHIES) {
      expect(t.name.trim(), t.id).not.toBe("");
      expect(t.flavor.trim(), t.id).not.toBe("");
      expect(t.icon.trim(), t.id).not.toBe("");
    }
  });

  it("only references metrics the snapshot actually provides", () => {
    for (const t of TROPHIES) expect(TROPHY_METRICS, t.id).toContain(t.metric);
  });

  it("prices every trophy with positive XP that rises with the tier", () => {
    for (const t of TROPHIES) expect(t.xp, t.id).toBeGreaterThan(0);
    for (const rungs of Object.values(series())) {
      for (let i = 1; i < rungs.length; i++) {
        expect(rungs[i]!.xp, `${rungs[i]!.id} should be worth more than ${rungs[i - 1]!.id}`).toBeGreaterThan(rungs[i - 1]!.xp);
      }
    }
  });

  it("ascends thresholds and tiers within every series, over one metric", () => {
    for (const [name, rungs] of Object.entries(series())) {
      expect(rungs.length, name).toBeGreaterThan(0);
      const metrics = new Set(rungs.map((r) => r.metric));
      expect(metrics.size, `series ${name} must measure ONE thing`).toBe(1);
      for (let i = 1; i < rungs.length; i++) {
        expect(rungs[i]!.threshold, `${name} tier ${i + 1}`).toBeGreaterThan(rungs[i - 1]!.threshold);
        expect(rungs[i]!.tier, `${name} tier numbering`).toBe(rungs[i - 1]!.tier + 1);
      }
      expect(rungs[0]!.tier, `series ${name} starts at tier 1`).toBe(1);
    }
  });

  it("keeps every legacy kind that production has already granted", () => {
    for (const kind of LEGACY_KINDS) expect(trophyById(kind), `legacy kind ${kind} vanished from the catalog`).toBeTruthy();
  });

  it("does NOT expose shadow_area — it is an internal counter, not a trophy", () => {
    // It lives in `achievements` for historical reasons and feeds the cartographer
    // series as a METRIC. Surfacing it would put a bare counter in the trophy case,
    // which is the bug Achievements.tsx currently works around with a filter.
    expect(trophyById("shadow_area")).toBeUndefined();
  });

  it("exposes normalised labels so host badges cannot impersonate a trophy", () => {
    expect(TROPHY_LABELS.length).toBe(new Set(TROPHY_LABELS).size);
    for (const l of TROPHY_LABELS) {
      expect(l, "labels must be pre-normalised: lowercase, no punctuation").toMatch(/^[a-z0-9 ]+$/);
    }
    // Every trophy's name must be represented, or a host could mint its twin.
    for (const t of TROPHIES) {
      const norm = t.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      expect(TROPHY_LABELS, `${t.name} is not reserved`).toContain(norm);
    }
  });

  it("marks only high-threshold trophies secret — a secret starter is just confusing", () => {
    const secrets = TROPHIES.filter((t: Trophy) => t.secret);
    expect(secrets.length).toBeGreaterThan(0);
    for (const s of secrets) expect(s.tier, `${s.id} is secret but low-tier`).toBeGreaterThan(1);
  });
});
