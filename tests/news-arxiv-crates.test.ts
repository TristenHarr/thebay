/**
 * arXiv and crates.io adapters. Fixtures mirror the real payload shapes, which
 * were captured from the live APIs before either adapter was written — the last
 * few sources taught me that a plausible-looking fixture proves nothing.
 */
import { describe, it, expect } from "vitest";
import { parseArxiv, arxivId, searchUrl as arxivUrl, ARXIV_CATEGORIES } from "../src/news/ingest/arxiv";
import {
  parseSummary,
  collapseWatched,
  WATCHED,
  MIN_DOWNLOADS,
  SUMMARY_URL,
} from "../src/news/ingest/crates";

const entry = (over: Partial<Record<string, string>> = {}) => `
  <entry>
    <id>http://arxiv.org/abs/${over.id ?? "2507.12345v1"}</id>
    <updated>2026-07-25T00:00:00Z</updated>
    <published>${over.published ?? "2026-07-24T00:00:00Z"}</published>
    <title>${over.title ?? "Expanding Flow Maps"}</title>
    <summary>An abstract that runs on for a while.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <arxiv:primary_category term="${over.cat ?? "cs.LG"}" />
    <category term="${over.cat ?? "cs.LG"}" />
  </entry>`;

const feed = (entries: string) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`;

describe("arXiv", () => {
  it("uses https — the http endpoint 301s with an empty body and looks dead", () => {
    expect(arxivUrl("cs.LG")).toMatch(/^https:\/\/export\.arxiv\.org/);
  });

  it("parses a paper into a research story with a real byline", () => {
    const [s] = parseArxiv(feed(entry()));
    expect(s!.origin).toBe("research");
    expect(s!.title).toBe("Expanding Flow Maps");
    expect(s!.url).toBe("https://arxiv.org/abs/2507.12345");
    expect(s!.author).toBe("Ada Lovelace et al.");
    expect(s!.topics).toEqual(["software"]);
  });

  it("strips the version so a revised paper updates rather than duplicates", () => {
    expect(arxivId("http://arxiv.org/abs/2507.12345v3")).toBe("2507.12345");
    const v1 = parseArxiv(feed(entry({ id: "2507.99999v1" })))[0]!;
    const v2 = parseArxiv(feed(entry({ id: "2507.99999v2" })))[0]!;
    expect(v2.externalId).toBe(v1.externalId);
    expect(v2.url).toBe(v1.url);
  });

  it("tags by the category the paper was FILED under, not the one we queried", () => {
    // A cross-listed paper found under cs.LG but filed as math.NT is maths.
    const [s] = parseArxiv(feed(entry({ cat: "math.NT" })), "software");
    expect(s!.topics).toEqual(["math"]);
  });

  it("covers every category the feed config used to carry", () => {
    const cats = ARXIV_CATEGORIES.map((c) => c.cat);
    for (const had of ["cs.AI", "cs.LG", "cs.DC", "cs.CR", "cs.PL", "math.CO", "math.NT", "math.AG",
                       "math.DS", "math.OC", "math.PR", "eess.SP", "cond-mat.mes-hall"]) {
      expect(cats, `${had} stopped being ingested by the swap`).toContain(had);
    }
  });

  it("skips entries it can't identify instead of failing the batch", () => {
    expect(parseArxiv(feed(`<entry><title>No id here</title></entry>` + entry()))).toHaveLength(1);
  });
});

describe("crates.io", () => {
  const summary = {
    just_updated: [
      { name: "codama-nodes-derive", newest_version: "0.10.0", description: "Derive macros for Codama nodes", downloads: 48914, updated_at: "2026-07-26T00:00:00Z" },
      { name: "tiny-nobody-crate", newest_version: "0.1.1", description: "A thing", downloads: 3, updated_at: "2026-07-26T00:00:00Z" },
      { name: "no-description", newest_version: "2.0.0", description: "", downloads: 900_000, updated_at: "2026-07-26T00:00:00Z" },
    ],
    new_crates: [
      { name: "sill-adapter", newest_version: "0.1.0", description: "The Sill adapter format: where a credential lives and how to reach it", downloads: 0, created_at: "2026-07-26T00:00:00Z" },
      { name: "stub", newest_version: "0.1.0", description: "wip", downloads: 0, created_at: "2026-07-26T00:00:00Z" },
    ],
    most_recently_downloaded: [
      { name: "syn", newest_version: "3.0.3", description: "Parser for Rust source code", downloads: 2_002_471_604, updated_at: "2026-07-26T00:00:00Z" },
    ],
  };

  it("keeps a real project's release and drops the long tail", () => {
    const names = parseSummary(summary).map((s) => s.title.split(" ")[0]);
    expect(names).toContain("codama-nodes-derive");
    expect(names).not.toContain("tiny-nobody-crate"); // below the downloads bar
    expect(names).not.toContain("no-description");
  });

  it("judges brand-new crates on description, since they cannot have downloads", () => {
    const names = parseSummary(summary).map((s) => s.title.split(" ")[0]);
    expect(names).toContain("sill-adapter");
    expect(names).not.toContain("stub");
  });

  it("never reports the same giants every run", () => {
    // most_downloaded would return syn and hashbrown forever. Popular ≠ news.
    expect(parseSummary(summary).map((s) => s.title)).not.toContain(expect.stringContaining("syn v"));
    expect(parseSummary(summary).some((s) => s.title.startsWith("syn "))).toBe(false);
  });

  it("does NOT feed download counts into ranking", () => {
    // Billions of downloads, sqrt-weighted, would outscore anything a human wrote.
    expect(parseSummary(summary).every((s) => s.points === null)).toBe(true);
  });

  it("gives each release its own permalink, or every version would merge into one story", () => {
    const s = parseSummary(summary).find((x) => x.title.startsWith("codama-nodes-derive"))!;
    expect(s.url).toBe("https://crates.io/crates/codama-nodes-derive/0.10.0");
    expect(s.externalId).toBe("crates:codama-nodes-derive@0.10.0");
  });

  it("fetches the summary endpoint, not the download charts", () => {
    expect(SUMMARY_URL).toBe("https://crates.io/api/v1/summary");
  });

  describe("watched projects", () => {
    // Logicaffeine really does publish 15 crates that all move together.
    const crates = {
      crates: Array.from({ length: 15 }, (_, i) => ({
        name: `logicaffeine-${["base","cli","compile","data","forge","jit","kernel","language","lexicon","lsp","parse","runtime","std","test","types"][i]}`,
        newest_version: "0.10.1",
        description: i === 0 ? "Tier-0 foundation for logicaffeine: arena, ids, diagnostics" : "",
        updated_at: "2026-07-11T00:00:00Z",
      })),
    };
    const w = WATCHED[0]!;

    it("collapses one release into ONE story instead of fifteen", () => {
      const out = collapseWatched(crates, w);
      expect(out).toHaveLength(1);
      expect(out[0]!.title).toContain("15 crates published");
      expect(out[0]!.topics).toEqual(w.topics);
    });

    it("still gives the collapsed story a version-unique link", () => {
      const out = collapseWatched(crates, w);
      // Shortest name = closest thing to a root package.
      expect(out[0]!.url).toBe("https://crates.io/crates/logicaffeine-cli/0.10.1");
      expect(out[0]!.externalId).toBe("crates-project:logicaffeine@0.10.1");
    });

    it("groups by version, so a half-finished rollout doesn't overclaim", () => {
      const mixed = { crates: [
        { name: "logicaffeine-base", newest_version: "0.11.0", description: "x", updated_at: "2026-07-20T00:00:00Z" },
        { name: "logicaffeine-cli", newest_version: "0.10.1", description: "y", updated_at: "2026-07-11T00:00:00Z" },
        { name: "logicaffeine-jit", newest_version: "0.10.1", description: "z", updated_at: "2026-07-11T00:00:00Z" },
      ] };
      const out = collapseWatched(mixed, w);
      expect(out[0]!.title).toContain("v0.11.0");
      expect(out[0]!.title).not.toContain("3 crates");
      expect(out.find((s) => s.title.includes("v0.10.1"))!.title).toContain("2 crates");
    });

    it("ignores crates that merely mention the project", () => {
      const out = collapseWatched({ crates: [{ name: "not-logicaffeine-related", newest_version: "1.0.0", description: "d", updated_at: "2026-07-11T00:00:00Z" }] }, w);
      expect(out).toHaveLength(0);
    });

    it("won't backfill a whole release history on first harvest", () => {
      const many = { crates: Array.from({ length: 9 }, (_, i) => ({
        name: "logicaffeine-base", newest_version: `0.${i}.0`, description: "d",
        updated_at: `2026-0${(i % 9) + 1}-01T00:00:00Z`,
      })) };
      expect(collapseWatched(many, w).length).toBeLessThanOrEqual(2);
    });
  });

  it("the downloads bar is a real bar", () => {
    expect(MIN_DOWNLOADS).toBeGreaterThan(0);
  });
});
