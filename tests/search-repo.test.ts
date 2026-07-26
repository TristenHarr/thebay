import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/d1";
import { D1Repo } from "../src/storage/d1/d1-repo";
import { SearchRepo } from "../src/storage/d1/search-repo";
import type { CanonicalEvent } from "../src/core/models/event";

/* eslint-disable @typescript-eslint/no-explicit-any */

let d1: any;
let raw: any;
let repo: D1Repo;
let search: SearchRepo;

const NOW = new Date("2026-07-26T00:00:00Z");

function mkEvent(id: string, over: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    id,
    fingerprint: `fp-${id}`,
    title: `Event ${id}`,
    description: null,
    startUtc: "2026-08-01T18:00:00Z",
    endUtc: null,
    timezone: "America/Los_Angeles",
    venueName: null,
    address: null,
    city: "san-francisco",
    url: `https://example.com/${id}`,
    organizer: null,
    isFree: null,
    priceText: null,
    imageUrl: null,
    categories: [],
    interestScore: null,
    interestReason: null,
    tagSource: null,
    contentHash: `hash-${id}`,
    taggedHash: null,
    sources: [{ sourceId: "luma-yc", sourceType: "luma", url: `https://example.com/${id}` }],
    firstSeenAt: "2026-07-01T00:00:00Z",
    lastSeenAt: "2026-07-01T00:00:00Z",
    starred: false,
    hidden: false,
    ...over,
  };
}

beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  repo = new D1Repo(d1);
  search = new SearchRepo(d1);
});

describe("migration 0014 — the tag model is enforced by the schema, not by handlers", () => {
  it("seeds a vocabulary across all six facets, topic:* mirroring config/categories.json", async () => {
    const vocab = await search.listVocab();
    const facets = new Set(vocab.map((t) => t.facet));
    expect([...facets].sort()).toEqual(["audience", "cost", "format", "perk", "stage", "topic"]);
    const hardware = vocab.find((t) => t.id === "topic:hardware")!;
    expect(hardware.label).toBe("Hardware");
    expect(hardware.keywords).toContain("robotics");
    expect(vocab.map((t) => t.id)).toEqual(expect.arrayContaining(["format:hackathon", "cost:free", "perk:open-bar", "stage:seed", "audience:founders"]));
  });

  it("rejects a confidence outside [0,1] and an unknown source (CHECK constraints)", async () => {
    await repo.upsertEvents([mkEvent("e1")]);
    const ins = (conf: number, src: string) =>
      raw.prepare("INSERT INTO event_tags (event_id, tag_id, confidence, source, created_at) VALUES (?,?,?,?,?)")
        .run("e1", "topic:hardware", conf, src, "2026-07-26T00:00:00Z");
    expect(() => ins(1.5, "keyword")).toThrow(/CHECK/i);
    expect(() => ins(-0.1, "keyword")).toThrow(/CHECK/i);
    expect(() => ins(0.5, "aliens")).toThrow(/CHECK/i);
    expect(() => ins(0.5, "keyword")).not.toThrow();
  });

  it("refuses a tag id that isn't in the vocabulary (FK), and cascades on event delete", async () => {
    await repo.upsertEvents([mkEvent("e1")]);
    expect(() =>
      raw.prepare("INSERT INTO event_tags (event_id, tag_id, confidence, source, created_at) VALUES (?,?,?,?,?)")
        .run("e1", "topic:teleportation", 1, "llm", "2026-07-26T00:00:00Z"),
    ).toThrow(/FOREIGN KEY/i);

    await search.applyEnrichment([{ id: "e1", tags: [{ tagId: "topic:hardware", confidence: 0.9, source: "keyword" }] }]);
    expect(raw.prepare("SELECT COUNT(*) n FROM event_tags").get().n).toBe(1);
    raw.prepare("DELETE FROM events WHERE id = ?").run("e1");
    expect(raw.prepare("SELECT COUNT(*) n FROM event_tags").get().n).toBe(0);
  });

  it("only accepts the three tag statuses", async () => {
    expect(() =>
      raw.prepare("INSERT INTO tag_vocab (id, facet, label, keywords_json, status, created_at) VALUES (?,?,?,?,?,?)")
        .run("topic:x", "topic", "X", "[]", "maybe", "2026-07-26T00:00:00Z"),
    ).toThrow(/CHECK/i);
  });
});

describe("events_fts — kept in sync by SQL, not by application discipline", () => {
  it("indexes an event the moment it is inserted, through the normal repo path", async () => {
    await repo.upsertEvents([mkEvent("e1", { title: "Robotics Night", description: "soldering irons provided" })]);
    const row = raw.prepare("SELECT * FROM events_fts WHERE event_id = ?").get("e1");
    expect(row.title).toBe("Robotics Night");
    expect(row.body).toContain("soldering");
  });

  it("re-indexes on a title/description change and drops the row on delete", async () => {
    await repo.upsertEvents([mkEvent("e1", { title: "Old Title" })]);
    raw.prepare("UPDATE events SET title = ? WHERE id = ?").run("Quantum Photonics Salon", "e1");
    expect(raw.prepare("SELECT title FROM events_fts WHERE event_id = ?").get("e1").title).toBe("Quantum Photonics Salon");
    raw.prepare("DELETE FROM events WHERE id = ?").run("e1");
    expect(raw.prepare("SELECT COUNT(*) n FROM events_fts").get().n).toBe(0);
  });

  it("folds tag LABELS into the body, so a tag makes an event findable by its words", async () => {
    await repo.upsertEvents([mkEvent("e1", { title: "YC W26 Kickoff", description: "come see the batch" })]);
    expect((await search.search({ text: "demo day", now: NOW })).events).toHaveLength(0);
    await search.applyEnrichment([{ id: "e1", tags: [{ tagId: "format:demo-day", confidence: 0.8, source: "llm" }] }]);
    const hit = await search.search({ text: "demo day", now: NOW });
    expect(hit.events.map((e) => e.id)).toEqual(["e1"]);
  });

  it("reindex() repairs a row that was lost, and is bounded + resumable", async () => {
    await repo.upsertEvents([mkEvent("a1"), mkEvent("a2"), mkEvent("a3")]);
    raw.prepare("DELETE FROM events_fts WHERE event_id = ?").run("a2");
    expect(raw.prepare("SELECT COUNT(*) n FROM events_fts").get().n).toBe(2);

    const r = await search.reindex({ limit: 100 });
    expect(r.indexed).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) n FROM events_fts").get().n).toBe(3);
    // nothing left to do the second time
    expect((await search.reindex({ limit: 100 })).indexed).toBe(0);

    // force + cursor walks the table a page at a time
    const p1 = await search.reindex({ limit: 2, force: true });
    expect(p1.indexed).toBe(2);
    expect(p1.nextCursor).toBe("a2");
    expect((await search.reindex({ limit: 2, force: true, cursor: p1.nextCursor! })).indexed).toBe(1);
  });

  it("indexHealth reports the drift an operator needs to see", async () => {
    await repo.upsertEvents([mkEvent("a1"), mkEvent("a2")]);
    await search.applyEnrichment([{ id: "a1", tags: [{ tagId: "topic:software", confidence: 0.7, source: "keyword" }] }]);
    expect(await search.indexHealth()).toEqual({ events: 2, indexed: 2, tagged: 1, embedded: 0 });
  });
});

describe("write-through — events.categories stays correct for every legacy reader", () => {
  it("rebuilds the legacy JSON column from the topic facet, stripped of its prefix", async () => {
    await repo.upsertEvents([mkEvent("e1")]);
    await search.applyEnrichment([
      {
        id: "e1",
        tags: [
          { tagId: "topic:hardware", confidence: 0.9, source: "keyword" },
          { tagId: "topic:software", confidence: 0.6, source: "llm" },
          { tagId: "format:hackathon", confidence: 0.8, source: "keyword" }, // NOT a category
        ],
        interestScore: 71,
        interestReason: "keyword match",
        tagSource: "keyword",
        contentHash: "hash-e1",
      },
    ]);
    const e = (await repo.getEventById("e1"))!;
    expect([...e.categories].sort()).toEqual(["hardware", "software"]);
    expect(e.interestScore).toBe(71);
    expect(e.tagSource).toBe("keyword");
    expect(e.taggedHash).toBe("hash-e1"); // no longer a re-enrichment candidate
  });

  it("an event with no topic tags gets '[]' rather than stale categories", async () => {
    await repo.upsertEvents([mkEvent("e1", { categories: ["hardware"] })]);
    await search.applyEnrichment([{ id: "e1", tags: [{ tagId: "format:mixer", confidence: 0.5, source: "keyword" }] }]);
    expect((await repo.getEventById("e1"))!.categories).toEqual([]);
  });

  it("re-enriching REPLACES machine tags but never touches a host's or the crowd's", async () => {
    await repo.upsertEvents([mkEvent("e1")]);
    await search.applyEnrichment([{ id: "e1", tags: [{ tagId: "topic:math", confidence: 0.9, source: "keyword" }] }]);
    await search.addTags("e1", [{ tagId: "perk:open-bar", confidence: 1, source: "host" }]);

    // the tagger changes its mind: math → software
    await search.applyEnrichment([{ id: "e1", tags: [{ tagId: "topic:software", confidence: 0.9, source: "keyword" }] }]);

    const tags = (await search.tagsFor(["e1"])).get("e1")!;
    const ids = tags.map((t) => t.tagId).sort();
    expect(ids).toEqual(["perk:open-bar", "topic:software"]); // math gone, host tag intact
    expect((await repo.getEventById("e1"))!.categories).toEqual(["software"]);
  });

  it("collapses duplicate assignments instead of throwing on the composite PK", async () => {
    await repo.upsertEvents([mkEvent("e1")]);
    await search.applyEnrichment([
      {
        id: "e1",
        tags: [
          { tagId: "topic:vc", confidence: 0.4, source: "keyword" },
          { tagId: "topic:vc", confidence: 0.9, source: "llm" },
        ],
      },
    ]);
    const tags = (await search.tagsFor(["e1"])).get("e1")!;
    expect(tags).toHaveLength(1);
    expect(tags[0]!.confidence).toBeCloseTo(0.9);
  });

  it("clamps an out-of-range confidence rather than letting the CHECK 500 a request", async () => {
    await repo.upsertEvents([mkEvent("e1")]);
    await search.applyEnrichment([{ id: "e1", tags: [{ tagId: "topic:tech", confidence: 42, source: "llm" }] }]);
    expect((await search.tagsFor(["e1"])).get("e1")![0]!.confidence).toBe(1);
  });
});

describe("search — filters, ranking, facets", () => {
  beforeEach(async () => {
    await repo.upsertEvents([
      mkEvent("h1", {
        title: "Hardware Hackathon",
        description: "build robots all weekend",
        isFree: true,
        city: "san-francisco",
        interestScore: 80,
        startUtc: "2026-08-05T18:00:00Z",
      }),
      mkEvent("h2", {
        title: "Founder Dinner",
        description: "a quiet dinner about hardware supply chains",
        isFree: false,
        city: "oakland",
        interestScore: 40,
        startUtc: "2026-08-02T18:00:00Z",
        sources: [{ sourceId: "cerebral-valley", sourceType: "html", url: "https://x/h2" }],
      }),
      mkEvent("h3", {
        title: "Rust Workshop",
        description: "systems programming",
        isFree: true,
        city: "san-francisco",
        interestScore: 60,
        startUtc: "2026-08-10T18:00:00Z",
      }),
    ]);
    await search.applyEnrichment([
      { id: "h1", tags: [{ tagId: "topic:hardware", confidence: 0.9, source: "keyword" }, { tagId: "format:hackathon", confidence: 0.9, source: "keyword" }, { tagId: "cost:free", confidence: 1, source: "keyword" }] },
      { id: "h2", tags: [{ tagId: "topic:hardware", confidence: 0.5, source: "keyword" }, { tagId: "format:dinner", confidence: 0.9, source: "keyword" }] },
      { id: "h3", tags: [{ tagId: "topic:software", confidence: 0.9, source: "keyword" }, { tagId: "format:workshop", confidence: 0.9, source: "keyword" }, { tagId: "cost:free", confidence: 1, source: "keyword" }] },
    ]);
  });

  it("weights the title 8x: the event CALLED Hardware beats the one that mentions it", async () => {
    const r = await search.search({ text: "hardware", now: NOW });
    expect(r.used.fts).toBe(true);
    expect(r.events[0]!.id).toBe("h1");
    expect(r.events.map((e) => e.id)).toContain("h2");
  });

  it("with no text it browses on recency+quality, and the FTS leg is skipped entirely", async () => {
    const r = await search.search({ now: NOW });
    expect(r.used.fts).toBe(false);
    expect(r.total).toBe(3);
    // h1 is both soon (Aug 5) and the best-scored (80): agreement between the two
    // remaining retrievers wins over h2 being marginally sooner.
    expect(r.events[0]!.id).toBe("h1");
  });

  it("honours an explicit sort exactly — a date-sorted list must be in date order", async () => {
    const soon = await search.search({ sort: "soonest", now: NOW });
    expect(soon.events.map((e) => e.id)).toEqual(["h2", "h1", "h3"]);
    const best = await search.search({ sort: "interesting", now: NOW });
    expect(best.events.map((e) => e.id)).toEqual(["h1", "h3", "h2"]);
    // …and still respects the text query's candidate set
    const soonHardware = await search.search({ text: "hardware", sort: "soonest", now: NOW });
    expect(soonHardware.events.map((e) => e.id)).toEqual(["h2", "h1"]);
  });

  it("filters free events through the indexed column", async () => {
    const r = await search.search({ filters: { free: true }, now: NOW });
    expect(r.events.map((e) => e.id).sort()).toEqual(["h1", "h3"]);
    expect(r.total).toBe(2);
  });

  it("ORs tags within a facet and ANDs across facets", async () => {
    const or = await search.search({ filters: { tags: ["topic:hardware", "topic:software"] }, now: NOW });
    expect(or.total).toBe(3);
    const and = await search.search({ filters: { tags: ["topic:hardware", "format:hackathon"] }, now: NOW });
    expect(and.events.map((e) => e.id)).toEqual(["h1"]);
    const none = await search.search({ filters: { tags: ["topic:software", "format:dinner"] }, now: NOW });
    expect(none.total).toBe(0);
  });

  it("filters by city, by source, and by a fuzzy 'near'", async () => {
    expect((await search.search({ filters: { cities: ["oakland"] }, now: NOW })).events.map((e) => e.id)).toEqual(["h2"]);
    expect((await search.search({ filters: { sources: ["cerebral-valley"] }, now: NOW })).events.map((e) => e.id)).toEqual(["h2"]);
    expect((await search.search({ filters: { near: "oak" }, now: NOW })).events.map((e) => e.id)).toEqual(["h2"]);
  });

  it("bounds the window with from/to", async () => {
    const r = await search.search({ filters: { from: "2026-08-03T00:00:00Z", to: "2026-08-08T00:00:00Z" }, now: NOW });
    expect(r.events.map((e) => e.id)).toEqual(["h1"]);
  });

  it("hides hidden events unless asked", async () => {
    raw.prepare("UPDATE events SET hidden = 1 WHERE id = ?").run("h1");
    expect((await search.search({ now: NOW })).total).toBe(2);
    expect((await search.search({ filters: { includeHidden: true }, now: NOW })).total).toBe(3);
  });

  it("returns facet counts that IGNORE the user's own tag selection, so they can back out", async () => {
    const r = await search.search({ filters: { tags: ["topic:hardware"] }, now: NOW });
    expect(r.events.map((e) => e.id).sort()).toEqual(["h1", "h2"]);
    const byId = Object.fromEntries(r.facets.tags.map((t) => [t.value, t.count]));
    expect(byId["topic:hardware"]).toBe(2);
    expect(byId["topic:software"]).toBe(1); // still offered — counts are over the unfiltered scope
    const tag = r.facets.tags.find((t) => t.value === "topic:hardware")!;
    expect(tag.label).toBe("Hardware");
    expect(tag.facet).toBe("topic");
  });

  it("counts cities and sources over the same scope", async () => {
    const r = await search.search({ now: NOW });
    expect(Object.fromEntries(r.facets.cities.map((c) => [c.value, c.count]))).toEqual({ "san-francisco": 2, oakland: 1 });
    expect(Object.fromEntries(r.facets.sources.map((c) => [c.value, c.count]))).toEqual({ "luma-yc": 2, "cerebral-valley": 1 });
  });

  it("pages without reshuffling, and total counts the whole match not the page", async () => {
    const p1 = await search.search({ limit: 2, now: NOW });
    const p2 = await search.search({ limit: 2, offset: 2, now: NOW });
    expect(p1.events).toHaveLength(2);
    expect(p2.events).toHaveLength(1);
    expect(p1.total).toBe(3);
    expect(new Set([...p1.events, ...p2.events].map((e) => e.id)).size).toBe(3);
  });

  it("lets a vector list re-order results but never widen them", async () => {
    const noVec = await search.search({ text: "hardware", now: NOW });
    expect(noVec.used.vector).toBe(false);
    // h3 is not in the 'hardware' candidate set; the vector index cannot smuggle it in.
    const withVec = await search.search({ text: "hardware", vectorIds: ["h3", "h2"], now: NOW });
    expect(withVec.used.vector).toBe(true);
    expect(withVec.events.map((e) => e.id)).not.toContain("h3");
    expect(withVec.events.map((e) => e.id)).toContain("h2");
  });

  it("a nonsense query returns nothing rather than everything", async () => {
    expect((await search.search({ text: "zzzzqqq", now: NOW })).total).toBe(0);
  });

  it("survives FTS operator characters in the query", async () => {
    for (const q of ['" OR 1=1 --', "NEAR/2", "^*(", "hardware AND"]) {
      await expect(search.search({ text: q, now: NOW })).resolves.toBeTruthy();
    }
  });

  it("stays under D1's 100-bound-parameter ceiling with a maximal filter set", async () => {
    const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    await expect(
      search.search({
        text: "hardware software robotics founders demo day mixer dinner workshop panel talk",
        filters: {
          tags: ["topic:hardware", "topic:software", "format:hackathon", "cost:free", "audience:founders", "stage:seed", "perk:food"],
          cities: many("city-", 30),
          sources: many("src-", 30),
          near: "soma",
          from: "2026-01-01T00:00:00Z",
          to: "2027-01-01T00:00:00Z",
          minScore: 10,
        },
        now: NOW,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("bounded work queues (this is what replaces the unbounded retagAll)", () => {
  it("returns only stale events, walks by an id cursor, and stops when done", async () => {
    await repo.upsertEvents([mkEvent("b1"), mkEvent("b2"), mkEvent("b3")]);
    const page1 = await search.eventsNeedingEnrichment(2);
    expect(page1.map((e) => e.id)).toEqual(["b1", "b2"]);
    const page2 = await search.eventsNeedingEnrichment(2, "b2");
    expect(page2.map((e) => e.id)).toEqual(["b3"]);

    for (const e of [...page1, ...page2]) {
      await search.applyEnrichment([
        { id: e.id, tags: [{ tagId: "topic:tech", confidence: 0.5, source: "keyword" }], tagSource: "keyword", contentHash: e.contentHash },
      ]);
    }
    expect(await search.eventsNeedingEnrichment(50)).toEqual([]);
  });

  it("an event whose content changed becomes a candidate again", async () => {
    await repo.upsertEvents([mkEvent("b1")]);
    await search.applyEnrichment([
      { id: "b1", tags: [{ tagId: "topic:tech", confidence: 0.5, source: "keyword" }], tagSource: "keyword", contentHash: "hash-b1" },
    ]);
    expect(await search.eventsNeedingEnrichment(50)).toEqual([]);
    raw.prepare("UPDATE events SET content_hash = ? WHERE id = ?").run("hash-b1-v2", "b1");
    expect((await search.eventsNeedingEnrichment(50)).map((e) => e.id)).toEqual(["b1"]);
  });

  it("force re-enriches an already-current event", async () => {
    await repo.upsertEvents([mkEvent("b1")]);
    await search.applyEnrichment([
      { id: "b1", tags: [{ tagId: "topic:tech", confidence: 0.5, source: "keyword" }], tagSource: "keyword", contentHash: "hash-b1" },
    ]);
    expect((await search.eventsNeedingEnrichment(50, "", true)).map((e) => e.id)).toEqual(["b1"]);
  });

  it("tracks embedding staleness with embedded_hash, mirroring tagged_hash", async () => {
    await repo.upsertEvents([mkEvent("b1"), mkEvent("b2")]);
    expect((await search.eventsNeedingEmbedding(50)).map((e) => e.id)).toEqual(["b1", "b2"]);
    await search.markEmbedded([{ id: "b1", hash: "hash-b1" }]);
    expect((await search.eventsNeedingEmbedding(50)).map((e) => e.id)).toEqual(["b2"]);
    raw.prepare("UPDATE events SET content_hash = ? WHERE id = ?").run("changed", "b1");
    expect((await search.eventsNeedingEmbedding(50)).map((e) => e.id).sort()).toEqual(["b1", "b2"]);
  });

  it("hidden events are never enrichment or embedding candidates", async () => {
    await repo.upsertEvents([mkEvent("b1", { hidden: true })]);
    expect(await search.eventsNeedingEnrichment(50)).toEqual([]);
    expect(await search.eventsNeedingEmbedding(50)).toEqual([]);
  });
});

describe("renormalize — a dedup merge must not eat human tags", () => {
  it("moves event_tags onto the canonical row instead of letting CASCADE delete them", async () => {
    // Same title + day + timezone, different stored city ⇒ after re-resolution both
    // fingerprints collide and the newer row is merged into the older one.
    await repo.upsertEvents([
      mkEvent("m1", { title: "Robotics Night", city: "unknown", firstSeenAt: "2026-07-01T00:00:00Z" }),
      mkEvent("m2", { title: "Robotics Night", city: "san-francisco", firstSeenAt: "2026-07-02T00:00:00Z" }),
    ]);
    await search.applyEnrichment([{ id: "m2", tags: [{ tagId: "topic:hardware", confidence: 0.9, source: "keyword" }] }]);
    await search.addTags("m2", [{ tagId: "perk:open-bar", confidence: 1, source: "host" }]);

    const out = await repo.renormalizeCities(() => "san-francisco");
    expect(out.merged).toBe(1);
    expect(await repo.getEventById("m2")).toBeNull();

    const tags = (await search.tagsFor(["m1"])).get("m1")!.map((t) => t.tagId).sort();
    expect(tags).toEqual(["perk:open-bar", "topic:hardware"]); // the host's label survived
  });
});

describe("upsertVocab — a new tag is a row, not a redeploy", () => {
  it("adds a tag that search can immediately filter on", async () => {
    await repo.upsertEvents([mkEvent("e1")]);
    await search.upsertVocab([{ id: "topic:biotech", facet: "topic", label: "Biotech", keywords: ["biotech", "crispr"], emoji: "🧬", color: "#22aa88" }]);
    await search.addTags("e1", [{ tagId: "topic:biotech", confidence: 1, source: "host" }]);
    const r = await search.search({ filters: { tags: ["topic:biotech"] }, now: NOW });
    expect(r.events.map((e) => e.id)).toEqual(["e1"]);
    expect((await repo.getEventById("e1"))!.categories).toEqual(["biotech"]);
  });

  it("re-upserting updates in place and can retire a tag out of search", async () => {
    await repo.upsertEvents([mkEvent("e1")]);
    await search.applyEnrichment([{ id: "e1", tags: [{ tagId: "topic:math", confidence: 0.9, source: "keyword" }] }]);
    expect((await search.search({ now: NOW })).facets.tags.map((t) => t.value)).toContain("topic:math");
    await search.upsertVocab([{ id: "topic:math", facet: "topic", label: "Mathematics", keywords: [], status: "retired" }]);
    expect((await search.listVocab()).map((t) => t.id)).not.toContain("topic:math");
    expect((await search.search({ now: NOW })).facets.tags.map((t) => t.value)).not.toContain("topic:math");
  });
});
