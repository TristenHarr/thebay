/**
 * The type chart, and the firewall around it.
 *
 * Two jobs. The first is ordinary: the chart is derived from real catalog data, so it must
 * stay reconciled with the archetypes it was lifted from.
 *
 * The second is the one that matters. **A founder type must never multiply XP.** The moment a
 * type pays, everybody becomes whichever type pays — and the most damaging lie available on
 * this platform is "I'm an investor", a claim nobody can check from a profile. The last block
 * greps the gym and XP code to prove no such path exists. It is the assertion most likely to
 * be quietly deleted by a future PR, so it has a loud name.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  FOUNDER_TYPES,
  ARCHETYPE_CROWD,
  ARCHETYPES,
  founderType,
  affinity,
  affinityBand,
  bestAffinity,
  underrepresented,
} from "../src/core/types/chart";

describe("the type chart", () => {
  it("gives every type a card's worth of identity", () => {
    // `place_kinds`' rule: a kind with no icon is unpinnable, and a type with no colour has
    // no card.
    for (const t of FOUNDER_TYPES) {
      expect(t.id, "ids are stable keys, so lowercase and bare").toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.label.trim()).not.toBe("");
      expect(t.emoji.trim()).not.toBe("");
      expect(t.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.blurb.trim()).not.toBe("");
    }
  });

  it("has unique ids, labels and sort positions", () => {
    for (const key of ["id", "label", "sort"] as const) {
      const vals = FOUNDER_TYPES.map((t) => t[key]);
      expect(new Set(vals).size, `duplicate ${key}`).toBe(vals.length);
    }
  });

  it("covers the vocabulary the catalog actually uses", () => {
    // These are `tag_vocab`'s audience facet plus `operators`, which every archetype's crowd
    // mix in src/core/vibe.ts uses. If a type maps to a bucket nothing measures, its affinity
    // is silently always zero.
    const buckets = new Set(FOUNDER_TYPES.map((t) => t.crowd));
    for (const required of ["founders", "investors", "engineers", "students", "operators"]) {
      expect(buckets, `no type maps to ${required}`).toContain(required);
    }
    // VC and Angel are the split of `audience:investors`.
    expect(FOUNDER_TYPES.filter((t) => t.crowd === "investors").map((t) => t.id).sort()).toEqual(["angel", "vc"]);
  });

  it("stays reconciled with the archetypes it was lifted from", () => {
    // The chart is a COPY of vibe.ts's crowd mixes, deliberately, so the vibe predictor can be
    // retuned without silently changing who is "at home" where. This test is what makes that
    // copy safe: add an archetype there and this fails until it's decided here.
    const vibeSrc = readFileSync(resolve(process.cwd(), "src/core/vibe.ts"), "utf8");
    const declared = [...vibeSrc.matchAll(/^\s{4}id:\s*"([a-z-]+)",\s*$/gm)].map((m) => m[1]!);
    expect(declared.length, "failed to parse archetypes out of vibe.ts").toBeGreaterThan(5);
    for (const id of declared) {
      expect(ARCHETYPE_CROWD[id], `vibe.ts has archetype "${id}" but the type chart doesn't`).toBeTruthy();
    }
  });

  it("keeps every crowd share positive and every archetype non-empty", () => {
    for (const [id, mix] of Object.entries(ARCHETYPE_CROWD)) {
      const vals = Object.values(mix);
      expect(vals.length, id).toBeGreaterThan(0);
      for (const v of vals) expect(v, id).toBeGreaterThan(0);
    }
  });
});

describe("affinity", () => {
  it("puts an engineer at home in a hackathon and an investor out of place", () => {
    // Straight from the data: hackathon crowd is {engineers 60, founders 25, students 15}.
    expect(affinity("engineer", "hackathon")).toBe(1);
    expect(affinity("vc", "hackathon")).toBe(0);
    expect(affinity("founder", "hackathon")).toBeGreaterThan(0);
    expect(affinity("founder", "hackathon")).toBeLessThan(1);
  });

  it("puts a founder at home at dinner, where the room is half founders", () => {
    expect(affinity("founder", "dinner")).toBe(1);
    expect(affinity("vc", "dinner")).toBeGreaterThan(0.4);
    expect(affinity("student", "dinner"), "no students in the dinner mix").toBe(0);
  });

  it("treats VC and Angel identically — they share the investors bucket", () => {
    for (const a of ARCHETYPES) expect(affinity("vc", a), a).toBe(affinity("angel", a));
  });

  it("shrugs rather than guessing for an unknown type or archetype", () => {
    expect(affinity("wizard", "hackathon")).toBe(0.5);
    expect(affinity("founder", "underwater-basket-weaving")).toBe(0.5);
  });

  it("is always a finite 0..1 for every type × archetype pair", () => {
    for (const t of FOUNDER_TYPES) {
      for (const a of ARCHETYPES) {
        const s = affinity(t.id, a);
        expect(Number.isFinite(s), `${t.id}@${a}`).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    }
  });

  it("bands a score into words the UI can use without inventing thresholds", () => {
    expect(affinityBand(1)).toBe("home");
    expect(affinityBand(0.5)).toBe("welcome");
    expect(affinityBand(0.2)).toBe("neutral");
    expect(affinityBand(0)).toBe("stretch");
    expect(affinityBand(NaN)).toBe("neutral");
  });
});

describe("bestAffinity", () => {
  it("takes the BEST of two types, never the average", () => {
    // A founder/engineer is at home at a hackathon because of the engineer half. Averaging
    // would demote them to "welcome", so a second type would sometimes make you fit LESS —
    // which is the opposite of what declaring one should do.
    const both = bestAffinity(["founder", "engineer"], "hackathon");
    expect(both.score).toBe(1);
    expect(both.band).toBe("home");
    expect(both.score).toBeGreaterThan(bestAffinity(["founder"], "hackathon").score);
  });

  it("never lets a second type make you fit less", () => {
    for (const a of ARCHETYPES) {
      for (const t of FOUNDER_TYPES) {
        for (const t2 of FOUNDER_TYPES) {
          expect(bestAffinity([t.id, t2.id], a).score, `${t.id}+${t2.id}@${a}`).toBeGreaterThanOrEqual(bestAffinity([t.id], a).score);
        }
      }
    }
  });

  it("shrugs for somebody who hasn't declared a type", () => {
    expect(bestAffinity([], "hackathon").score).toBe(0.5);
  });

  it("always returns copy for the band", () => {
    for (const a of ARCHETYPES) expect(bestAffinity(["founder"], a).label.trim()).not.toBe("");
  });
});

describe("underrepresented", () => {
  it("names who a room is short of — the useful half of a crowd mix", () => {
    // "60% engineers" describes the room; "almost no investors here" is what a founder
    // deciding how to spend the evening actually needs.
    const missing = underrepresented("hackathon").map((t) => t.id);
    expect(missing).toContain("vc");
    expect(missing).not.toContain("engineer");
  });

  it("is bounded and total", () => {
    expect(underrepresented("hackathon", 2).length).toBeLessThanOrEqual(2);
    expect(underrepresented("nope")).toEqual([]);
  });
});

describe("FIREWALL: a founder type must never be worth XP", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const filesIn = (dir: string) =>
    readdirSync(resolve(process.cwd(), dir))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `${dir}/${f}`);

  /**
   * A real import, not a mention.
   *
   * The first version of this matched the bare substring `core/types/chart`, which flagged a
   * DOC COMMENT in `vibe.ts` naming the file — the same false-positive class that had
   * `lock-schema` reporting a broken build because the English word "catches" appeared in a
   * comment. Match the import statement.
   */
  const importsChart = (src: string) => /^\s*import[^;]*from\s+["'][^"']*types\/chart["']/m.test(src);

  it("is not imported by any module that decides an XP AMOUNT", () => {
    // The scope is deliberately "what computes money", not "what lives in a folder called xp".
    // `src/core/xp/card.ts` legitimately imports the chart — a card RENDERS your types — and
    // sweeping it in here would force the firewall to be relaxed for a presentation module,
    // which is how a guard rail quietly stops guarding.
    const economy = [
      ...filesIn("src/core/gym"),
      "src/core/xp/levels.ts",
      "src/core/xp/stats.ts",
      "src/storage/d1/gym-repo.ts",
      "src/storage/d1/xp-repo.ts",
      "src/storage/d1/trophy-repo.ts",
      "src/worker/routes/gym.ts",
      "src/worker/routes/xp.ts",
      "src/core/trophies/catalog.ts",
      "src/core/trophies/evaluate.ts",
    ];
    for (const f of economy) {
      const src = read(f);
      expect(importsChart(src), `${f} imports the type chart — nothing that prices XP may see a type`).toBe(false);
      expect(/\bFOUNDER_TYPES\b|\baffinity\(|\bbestAffinity\(/.test(src), `${f} references the type chart`).toBe(false);
    }
  });

  it("lets the CARD import it — rendering a type is not pricing one", () => {
    // Stated positively so the boundary is documented rather than implied: presentation may
    // read the chart, pricing may not.
    expect(importsChart(read("src/core/xp/card.ts"))).toBe(true);
  });

  it("exports no multiplier, bonus or XP value of any kind", () => {
    const src = read("src/core/types/chart.ts");
    for (const forbidden of ["xp", "multiplier", "bonus", "reward"]) {
      const re = new RegExp(`export\\s+(?:const|function)\\s+\\w*${forbidden}`, "i");
      expect(re.test(src), `chart.ts exports something called "${forbidden}"`).toBe(false);
    }
  });

  it("NEVER derives a type from interests, keywords or stats", () => {
    // The load-bearing rule. `config/categories.json` has a topic slug `vc` covering ~530
    // events, and a founder type is also called `vc` — a harmless overlap while they stay in
    // different tables (`event_tags` stores the facet-qualified `topic:vc`; identity lives in
    // `founder_identity.type_id`). It stops being harmless the instant something INFERS the
    // person from the topic.
    //
    // That inference is tempting and always wrong: `founderStats.capital` is a word-boundary
    // regex over a free-text field, so deriving identity from it produces confident errors
    // that the person it describes cannot correct.
    const chart = read("src/core/types/chart.ts");
    expect(chart.includes("interests"), "chart.ts must not read interests").toBe(false);
    expect(chart.includes("founderStats") || chart.includes("core/xp/stats"), "chart.ts must not read stats").toBe(false);

    // And nothing that owns a keyword list may map it onto a type id. `vibe.ts` NAMES the
    // chart in a doc comment (it is where the crowd mixes were lifted from) — a mention is
    // fine, an import is not.
    for (const f of ["src/core/xp/stats.ts", "src/core/vibe.ts"]) {
      expect(importsChart(read(f)), `${f} must not import the type chart`).toBe(false);
    }
  });

  it("keeps type ids distinct from the FACET-QUALIFIED tag vocabulary", () => {
    // `tag_vocab` ids are namespaced (`topic:vc`, `audience:investors`), which is exactly what
    // keeps the overlap above safe. A bare `vc` type id can never be mistaken for a tag id.
    for (const t of FOUNDER_TYPES) expect(t.id.includes(":"), `${t.id} must stay un-namespaced`).toBe(false);
  });
});
