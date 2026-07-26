import { describe, it, expect } from "vitest";
import { parseQuery, normalizeQuery, queryHash } from "../src/core/search/parse";
import { intersectTags, facetOf, slugOf, groupByFacet, activeTags, type TagVocabEntry } from "../src/core/search/vocab";

/** A miniature stand-in for the seeded tag_vocab (see migrations/0014_search.sql). */
const VOCAB: TagVocabEntry[] = [
  { id: "topic:hardware", facet: "topic", label: "Hardware", keywords: ["hardware", "robotics", "robot", "pcb", "soldering"] },
  { id: "topic:software", facet: "topic", label: "Software", keywords: ["software", "ai", "llm", "rust", "hackathon"] },
  { id: "topic:vc", facet: "topic", label: "VC / Early-stage", keywords: ["vc", "venture capital", "investor", "investors"] },
  { id: "format:meetup", facet: "format", label: "Meetup", keywords: ["meetup", "meetups"] },
  { id: "format:hackathon", facet: "format", label: "Hackathon", keywords: ["hackathon", "hackathons", "hack night"] },
  { id: "format:demo-day", facet: "format", label: "Demo Day", keywords: ["demo day", "demo days"] },
  { id: "audience:founders", facet: "audience", label: "Founders", keywords: ["founder", "founders"] },
  { id: "cost:free", facet: "cost", label: "Free", keywords: ["free", "no cost"] },
  { id: "perk:open-bar", facet: "perk", label: "Open Bar", keywords: ["open bar"] },
  { id: "stage:seed", facet: "stage", label: "Seed", keywords: ["seed stage", "seed round"] },
  { id: "topic:retired-thing", facet: "topic", label: "Retired Thing", keywords: ["retiredthing"], status: "retired" },
];

// Fri 2026-07-24T20:00:00Z = Fri 13:00 in SF.
const NOW = Date.parse("2026-07-24T20:00:00Z");

describe("vocab helpers", () => {
  it("splits a tag id into facet + slug", () => {
    expect(facetOf("topic:hardware")).toBe("topic");
    expect(slugOf("topic:hardware")).toBe("hardware");
    expect(facetOf("nonsense")).toBe("");
  });

  it("activeTags drops retired/proposed entries", () => {
    expect(activeTags(VOCAB).map((t) => t.id)).not.toContain("topic:retired-thing");
    expect(activeTags(VOCAB).length).toBe(VOCAB.length - 1);
  });

  it("groups tag ids by facet (OR within a facet, AND across facets)", () => {
    const g = groupByFacet(["topic:hardware", "topic:software", "format:meetup"]);
    expect([...g.keys()].sort()).toEqual(["format", "topic"]);
    expect(g.get("topic")).toEqual(["topic:hardware", "topic:software"]);
  });
});

describe("intersectTags — the model may NEVER invent a tag id", () => {
  it("keeps only ids that exist in the live vocabulary", () => {
    expect(intersectTags(["topic:hardware", "topic:teleportation", "format:seance"], VOCAB)).toEqual(["topic:hardware"]);
  });

  it("drops retired vocabulary even though the row still exists", () => {
    expect(intersectTags(["topic:retired-thing"], VOCAB)).toEqual([]);
  });

  it("is case-insensitive and de-duplicates", () => {
    expect(intersectTags(["TOPIC:Hardware", "topic:hardware"], VOCAB)).toEqual(["topic:hardware"]);
  });

  it("resolves an unambiguous bare slug, but never guesses an ambiguous one", () => {
    expect(intersectTags(["hardware"], VOCAB)).toEqual(["topic:hardware"]);
    // "hackathon" exists as BOTH topic:software's keyword space and format:hackathon's
    // slug — only the exact slug match counts, and it must be unique.
    expect(intersectTags(["hackathon"], VOCAB)).toEqual(["format:hackathon"]);
    expect(intersectTags(["nope"], VOCAB)).toEqual([]);
  });

  it("survives garbage input shapes without throwing (the model is untrusted)", () => {
    expect(intersectTags(null, VOCAB)).toEqual([]);
    expect(intersectTags("topic:hardware", VOCAB)).toEqual([]);
    expect(intersectTags([1, {}, null, "topic:hardware"], VOCAB)).toEqual(["topic:hardware"]);
  });

  it("caps the number of tags so a runaway model can't build a 500-clause query", () => {
    const many = Array.from({ length: 200 }, () => "topic:hardware");
    expect(intersectTags(many, VOCAB).length).toBe(1);
    expect(intersectTags(activeTags(VOCAB).map((t) => t.id), VOCAB, 3).length).toBe(3);
  });
});

describe("normalizeQuery / queryHash — the KV cache key", () => {
  it("collapses case and whitespace so phrasings share a cache entry", () => {
    expect(normalizeQuery("  Free   HARDWARE meetups \n")).toBe("free hardware meetups");
    expect(queryHash("Free hardware")).toBe(queryHash("free   hardware"));
  });

  it("different queries get different hashes", () => {
    expect(queryHash("free hardware")).not.toBe(queryHash("paid hardware"));
  });
});

describe("parseQuery — the deterministic fallback parser", () => {
  it("handles the flagship example end to end", () => {
    const p = parseQuery("free hardware meetups in SoMa next week where I'll meet actual robotics people", VOCAB, NOW);
    expect(p.filters.free).toBe(true);
    expect(p.filters.tags).toEqual(expect.arrayContaining(["topic:hardware", "format:meetup"]));
    expect(p.filters.near).toBe("soma");
    expect(p.filters.window).toBe("7d");
    // The residual is what a semantic retriever should actually embed — the part
    // no filter captured.
    expect(p.semanticQuery).toContain("meet");
    expect(p.semanticQuery).toContain("people");
    expect(p.semanticQuery).not.toContain("free");
    expect(p.semanticQuery).not.toContain("next week");
    expect(p.intent).toBe("meet");
  });

  it("detects 'free' as a filter and as the cost:free tag", () => {
    const p = parseQuery("free talks", VOCAB, NOW);
    expect(p.filters.free).toBe(true);
    expect(p.filters.tags).toContain("cost:free");
  });

  it("does not read 'free' out of an unrelated word", () => {
    // word boundaries, not substrings — the house rule that stops ai⊂email
    expect(parseQuery("freelance designers", VOCAB, NOW).filters.free).toBeUndefined();
  });

  describe("time windows", () => {
    const w = (q: string) => parseQuery(q, VOCAB, NOW).filters.window;
    it("maps 'tonight' / 'today'", () => {
      expect(w("ai tonight")).toBe("tonight");
      expect(w("anything today")).toBe("today");
    });
    it("maps 'this weekend' and a bare 'weekend'", () => {
      expect(w("hackathons this weekend")).toBe("weekend");
      expect(w("weekend plans")).toBe("weekend");
    });
    it("maps 'next week' / 'this week' to a 7-day window", () => {
      expect(w("demo day next week")).toBe("7d");
      expect(w("demo day this week")).toBe("7d");
    });
    it("maps 'this month' / 'next month' to 30 days", () => {
      expect(w("vc dinners this month")).toBe("30d");
    });
    it("leaves the window unset when the query says nothing about time", () => {
      expect(w("robotics")).toBeUndefined();
    });
    it("prefers the most specific window when several match", () => {
      expect(w("tonight or next week")).toBe("tonight");
    });
  });

  describe("locations", () => {
    const near = (q: string) => parseQuery(q, VOCAB, NOW).filters.near;
    it("reads 'near <place>', 'in <place>' and 'around <place>'", () => {
      expect(near("coffee near Mission Bay")).toBe("mission bay");
      expect(near("meetups in Palo Alto")).toBe("palo alto");
      expect(near("dinners around Oakland")).toBe("oakland");
    });
    it("stops the place name at a following time phrase", () => {
      expect(near("meetups in SoMa next week")).toBe("soma");
      expect(near("meetups in SoMa tonight")).toBe("soma");
    });
    it("stops at punctuation and at a relative clause", () => {
      expect(near("hackathons in Berkeley, with free food")).toBe("berkeley");
      expect(near("talks in Menlo Park where founders hang out")).toBe("menlo park");
    });
    it("does not invent a location out of a bare preposition", () => {
      expect(near("in")).toBeUndefined();
      expect(near("robotics")).toBeUndefined();
    });
    it("never captures a time word as a place", () => {
      expect(near("anything in the next week")).toBeUndefined();
    });
    it("never captures a vocabulary term as a place ('interested in ai')", () => {
      expect(near("interested in ai")).toBeUndefined();
      expect(near("coffee near Mission Bay hackathon")).toBe("mission bay");
    });
  });

  describe("literal tag-label matching", () => {
    it("matches labels as well as keywords, on word boundaries", () => {
      expect(parseQuery("open bar mixers", VOCAB, NOW).filters.tags).toContain("perk:open-bar");
      expect(parseQuery("Demo Day", VOCAB, NOW).filters.tags).toContain("format:demo-day");
    });
    it("does not match a keyword hiding inside another word", () => {
      // "ai" ⊄ "email", "vc" ⊄ "service" — the classic tagger bug
      expect(parseQuery("email service", VOCAB, NOW).filters.tags ?? []).toEqual([]);
    });
    it("never returns a retired tag", () => {
      expect(parseQuery("retiredthing", VOCAB, NOW).filters.tags ?? []).toEqual([]);
    });
  });

  describe("intent", () => {
    const i = (q: string) => parseQuery(q, VOCAB, NOW).intent;
    it("'browse' for an empty query", () => {
      expect(i("")).toBe("browse");
      expect(i("   ")).toBe("browse");
    });
    it("'meet' when the query is about people", () => {
      expect(i("where can I meet robotics people")).toBe("meet");
      expect(i("events to network with investors")).toBe("meet");
    });
    it("'find' otherwise", () => {
      expect(i("rust workshop")).toBe("find");
    });
  });

  it("is total — never throws on hostile input", () => {
    for (const q of ["", "   ", "((((", "a".repeat(5000), "🔥🔥🔥", 'near "'] ) {
      expect(() => parseQuery(q, VOCAB, NOW)).not.toThrow();
    }
  });

  it("is pure: same input, same output, and it does not mutate the vocabulary", () => {
    const before = JSON.stringify(VOCAB);
    const a = parseQuery("free hardware meetups in soma next week", VOCAB, NOW);
    const b = parseQuery("free hardware meetups in soma next week", VOCAB, NOW);
    expect(a).toEqual(b);
    expect(JSON.stringify(VOCAB)).toBe(before);
  });
});
