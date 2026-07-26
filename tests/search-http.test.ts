import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTestApp, call, type TestApp } from "./helpers/app";
import { D1Repo } from "../src/storage/d1/d1-repo";
import { SearchRepo } from "../src/storage/d1/search-repo";
import type { CanonicalEvent } from "../src/core/models/event";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TOKEN = "test-ingest-token";

function mkEvent(id: string, over: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    id,
    fingerprint: `fp-${id}`,
    title: `Event ${id}`,
    description: null,
    startUtc: new Date(Date.now() + 3 * 86400_000).toISOString(),
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

let t: TestApp;

async function seed(app: TestApp) {
  const repo = new D1Repo(app.d1);
  await repo.upsertEvents([
    mkEvent("s1", {
      title: "Hardware Hackathon",
      description: "build robots, soldering irons provided, founders welcome",
      isFree: true,
      interestScore: 80,
      startUtc: new Date(Date.now() + 2 * 86400_000).toISOString(),
    }),
    mkEvent("s2", {
      title: "Founder Dinner",
      description: "a paid dinner about hardware supply chains",
      isFree: false,
      priceText: "$95",
      interestScore: 50,
      city: "oakland",
      startUtc: new Date(Date.now() + 5 * 86400_000).toISOString(),
      sources: [{ sourceId: "cerebral-valley", sourceType: "html", url: "https://x/s2" }],
    }),
    mkEvent("s3", {
      title: "Rust Systems Workshop",
      description: "free workshop on systems programming",
      isFree: true,
      interestScore: 60,
      startUtc: new Date(Date.now() + 20 * 86400_000).toISOString(),
    }),
  ]);
}

function stubModel(reply: string) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(async () => {
  t = makeTestApp({ INGEST_TOKEN: TOKEN });
  await seed(t);
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /api/search — degrades in layers, never fails", () => {
  it("works with NO OPENROUTER_API_KEY and NO VECTORIZE — today's production config", async () => {
    expect(t.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(t.env.VECTORIZE).toBeUndefined();

    const r = await call(t, "/api/search", { method: "POST", body: { q: "hardware" } });
    expect(r.status).toBe(200);
    expect(r.json.query.source).toBe("deterministic");
    expect(r.json.used).toEqual({ fts: true, vector: false });
    expect(r.json.events.map((e: any) => e.id)).toContain("s1");
    expect(r.json.total).toBeGreaterThan(0);
  });

  it("browses with no query at all", async () => {
    const r = await call(t, "/api/search", { method: "POST", body: {} });
    expect(r.status).toBe(200);
    expect(r.json.used.fts).toBe(false);
    expect(r.json.total).toBe(3);
    expect(r.json.query.intent).toBe("browse");
  });

  it("weights the title: the event CALLED Hardware beats the one that mentions it", async () => {
    const r = await call(t, "/api/search", { method: "POST", body: { q: "hardware" } });
    expect(r.json.events[0].id).toBe("s1");
  });

  it("reads the flagship natural-language query without a model", async () => {
    const r = await call(t, "/api/search", {
      method: "POST",
      body: { q: "free hardware hackathons next week where I'll meet actual robotics people" },
    });
    expect(r.json.query.source).toBe("deterministic");
    expect(r.json.query.intent).toBe("meet");
    expect(r.json.query.filters.free).toBe(true);
    expect(r.json.query.filters.tags).toEqual(expect.arrayContaining(["topic:hardware", "format:hackathon"]));
    expect(r.json.query.filters.window).toBe("7d");
    // the 7d window excludes the workshop 20 days out
    expect(r.json.events.map((e: any) => e.id)).not.toContain("s3");
  });

  it("returns tag facets built from the tag_vocab table, with labels", async () => {
    await new SearchRepo(t.d1).applyEnrichment([
      { id: "s1", tags: [{ tagId: "topic:hardware", confidence: 0.9, source: "keyword" }] },
    ]);
    const r = await call(t, "/api/search", { method: "POST", body: {} });
    const hw = r.json.facets.tags.find((x: any) => x.value === "topic:hardware");
    expect(hw).toMatchObject({ facet: "topic", label: "Hardware", count: 1 });
    expect(r.json.facets.cities.map((c: any) => c.value).sort()).toEqual(["oakland", "san-francisco"]);
    expect(r.json.facets.sources.map((s: any) => s.value).sort()).toEqual(["cerebral-valley", "luma-yc"]);
  });

  it("honours explicit filters over inferred ones — the visible chip wins", async () => {
    const r = await call(t, "/api/search", {
      method: "POST",
      body: { q: "free hardware", filters: { free: false, cities: ["oakland"] } },
    });
    expect(r.json.events.map((e: any) => e.id)).toEqual(["s2"]);
  });

  it("relaxes an INFERRED tag that matches nothing rather than showing an empty page", async () => {
    // Nothing is tagged yet, so the inferred topic:hardware filter would strand
    // the user on a query the words alone answer perfectly well.
    const r = await call(t, "/api/search", { method: "POST", body: { q: "hardware" } });
    expect(r.json.query.filters.tags).toContain("topic:hardware"); // still reported
    expect(r.json.query.applied.tags).toEqual([]); // …but dropped
    expect(r.json.query.relaxed).toBe(true);
    expect(r.json.total).toBeGreaterThan(0);
  });

  it("never relaxes a filter the USER chose — an empty page is the honest answer", async () => {
    const r = await call(t, "/api/search", { method: "POST", body: { filters: { tags: ["topic:hardware"] } } });
    expect(r.json.query.relaxed).toBe(false);
    expect(r.json.total).toBe(0);
  });

  it("keeps an inferred tag that DOES match once the catalog is enriched", async () => {
    await new SearchRepo(t.d1).applyEnrichment([
      { id: "s1", tags: [{ tagId: "topic:hardware", confidence: 0.9, source: "keyword" }] },
    ]);
    const r = await call(t, "/api/search", { method: "POST", body: { q: "hardware" } });
    expect(r.json.query.relaxed).toBe(false);
    expect(r.json.query.applied.tags).toEqual(["topic:hardware"]);
    expect(r.json.events.map((e: any) => e.id)).toEqual(["s1"]);
  });

  it("pages", async () => {
    const p1 = await call(t, "/api/search", { method: "POST", body: { limit: 2 } });
    const p2 = await call(t, "/api/search", { method: "POST", body: { limit: 2, offset: 2 } });
    expect(p1.json.events).toHaveLength(2);
    expect(p1.json.nextOffset).toBe(2);
    expect(p2.json.events).toHaveLength(1);
    expect(p2.json.nextOffset).toBeNull();
  });

  it("sorts explicitly when asked", async () => {
    const r = await call(t, "/api/search", { method: "POST", body: { sort: "soonest" } });
    expect(r.json.events.map((e: any) => e.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("rejects a malformed body instead of guessing", async () => {
    const r = await call(t, "/api/search", { method: "POST", body: { limit: 99999, q: 12 } });
    expect(r.status).toBe(400);
  });

  it("survives FTS operator soup in the query", async () => {
    for (const q of ['" OR 1=1 --', "NEAR/3 ^*(", "AND OR NOT"]) {
      const r = await call(t, "/api/search", { method: "POST", body: { q } });
      expect(r.status).toBe(200);
    }
  });
});

describe("POST /api/search — with a model configured", () => {
  beforeEach(async () => {
    t = makeTestApp({ INGEST_TOKEN: TOKEN, OPENROUTER_API_KEY: "sk-test", OPENROUTER_MODEL_FAST: "test/fast" });
    await seed(t);
  });

  it("uses the model's reading and still refuses a tag it invented", async () => {
    stubModel(
      JSON.stringify({
        tags: ["audience:founders", "topic:atlantis", "format:dinner"],
        free: false,
        near: "Oakland",
        window: null,
        semanticQuery: "supply chain people",
        intent: "meet",
      }),
    );
    const r = await call(t, "/api/search", { method: "POST", body: { q: "dinners with supply chain people" } });
    expect(r.json.query.source).toBe("llm");
    expect(r.json.query.filters.tags).toEqual(expect.arrayContaining(["audience:founders", "format:dinner"]));
    expect(r.json.query.filters.tags).not.toContain("topic:atlantis");
    expect(r.json.query.filters.near).toBe("oakland");
  });

  it("falls back to the deterministic parser when the model 500s", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const r = await call(t, "/api/search", { method: "POST", body: { q: "free hardware" } });
    expect(r.status).toBe(200);
    expect(r.json.query.source).toBe("deterministic");
    expect(r.json.query.filters.free).toBe(true);
  });

  it("understand:false skips the model entirely (cheap path for typeahead)", async () => {
    const fn = stubModel('{"tags":[]}');
    const r = await call(t, "/api/search", { method: "POST", body: { q: "hardware", understand: false } });
    expect(r.json.query.source).toBe("deterministic");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("GET /api/search — the same search, curl-able", () => {
  it("mirrors the POST body through query params", async () => {
    const r = await call(t, "/api/search?q=hardware&free=1&limit=5&understand=0");
    expect(r.status).toBe(200);
    expect(r.json.events.map((e: any) => e.id)).toEqual(["s1"]);
    expect(r.json.limit).toBe(5);
  });

  it("accepts comma lists for tags/cities/sources", async () => {
    const r = await call(t, "/api/search?city=oakland,san-francisco&source=cerebral-valley");
    expect(r.json.events.map((e: any) => e.id)).toEqual(["s2"]);
  });

  it("400s on a nonsense limit rather than silently clamping to something huge", async () => {
    expect((await call(t, "/api/search?limit=100000")).status).toBe(400);
  });
});

describe("GET /api/search/tags + /status — the taxonomy is data", () => {
  it("serves the live vocabulary grouped by facet", async () => {
    const r = await call(t, "/api/search/tags");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.facets).sort()).toEqual(["audience", "cost", "format", "perk", "stage", "topic"]);
    expect(r.json.tags.find((x: any) => x.id === "topic:hardware").keywords).toContain("robotics");
  });

  it("reports index health", async () => {
    const r = await call(t, "/api/search/status");
    expect(r.json).toEqual({ events: 3, indexed: 3, tagged: 0, embedded: 0 });
  });
});

describe("admin jobs — bearer-gated, bounded, resumable", () => {
  const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

  it("refuses every admin route without the ingest token", async () => {
    for (const p of ["/api/admin/enrich", "/api/admin/reindex", "/api/admin/tags"]) {
      expect((await call(t, p, { method: "POST" })).status).toBe(401);
      expect((await call(t, p, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    }
  });

  it("enriches a bounded slice, writes through to events.categories, and returns a cursor", async () => {
    const r = await call(t, "/api/admin/enrich?limit=2", { method: "POST", ...auth });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, scanned: 2, enriched: 2, embedded: 0, nextCursor: "s2" });
    expect(r.json.tags).toBeGreaterThan(0);

    const e1 = await new D1Repo(t.d1).getEventById("s1");
    expect(e1!.categories).toContain("hardware"); // legacy column stayed correct
    expect(e1!.tagSource).toBe("keyword");
    expect(e1!.taggedHash).toBe("hash-s1");

    const tags = (await new SearchRepo(t.d1).tagsFor(["s1"])).get("s1")!.map((x) => x.tagId);
    expect(tags).toEqual(expect.arrayContaining(["topic:hardware", "format:hackathon", "cost:free", "audience:founders"]));
  });

  it("resumes from the cursor and reports 0 when the catalog is caught up", async () => {
    const p1 = await call(t, "/api/admin/enrich?limit=2", { method: "POST", ...auth });
    const p2 = await call(t, `/api/admin/enrich?limit=2&cursor=${p1.json.nextCursor}`, { method: "POST", ...auth });
    expect(p2.json.scanned).toBe(1);
    const p3 = await call(t, "/api/admin/enrich?limit=50", { method: "POST", ...auth });
    expect(p3.json).toMatchObject({ scanned: 0, nextCursor: null });
  });

  it("the enriched catalog is immediately searchable by its new facets", async () => {
    await call(t, "/api/admin/enrich?limit=50", { method: "POST", ...auth });
    const r = await call(t, "/api/search", { method: "POST", body: { filters: { tags: ["format:hackathon"] } } });
    expect(r.json.events.map((e: any) => e.id)).toEqual(["s1"]);
    // cost came from the ticket data, not from the word "free" in s3's description
    const paid = await call(t, "/api/search", { method: "POST", body: { filters: { tags: ["cost:paid"] } } });
    expect(paid.json.events.map((e: any) => e.id)).toEqual(["s2"]);
  });

  it("reindex repairs a lost FTS row and reports health", async () => {
    t.raw.prepare("DELETE FROM events_fts WHERE event_id = ?").run("s2");
    // "supply chains" appears only in s2's description, so this isolates the lost row.
    expect((await call(t, "/api/search", { method: "POST", body: { q: "supply chains" } })).json.total).toBe(0);

    const r = await call(t, "/api/admin/reindex?limit=100", { method: "POST", ...auth });
    expect(r.json).toMatchObject({ ok: true, indexed: 1 });
    expect(r.json.health).toMatchObject({ events: 3, indexed: 3 });
    expect((await call(t, "/api/search", { method: "POST", body: { q: "supply chains" } })).json.total).toBe(1);
  });

  it("adds a vocabulary tag without a redeploy, and rejects a malformed one", async () => {
    const bad = await call(t, "/api/admin/tags", { method: "POST", ...auth, body: { tags: [{ id: "NoFacet", facet: "x", label: "X" }] } });
    expect(bad.status).toBe(400);

    const ok = await call(t, "/api/admin/tags", {
      method: "POST",
      ...auth,
      body: { tags: [{ id: "topic:biotech", facet: "topic", label: "Biotech", keywords: ["biotech", "crispr"], emoji: "🧬" }] },
    });
    expect(ok.json).toMatchObject({ ok: true, upserted: 1 });
    expect((await call(t, "/api/search/tags")).json.tags.map((x: any) => x.id)).toContain("topic:biotech");

    // …and the new tag is immediately usable by the deterministic query parser
    const r = await call(t, "/api/search", { method: "POST", body: { q: "crispr" } });
    expect(r.json.query.filters.tags).toContain("topic:biotech");
  });
});
