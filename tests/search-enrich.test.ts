import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildTagMessages,
  costTags,
  embed,
  embedAndUpsert,
  embedText,
  enrichDeterministic,
  enrichEvents,
  topicCategoryDefs,
  vectorCandidates,
  EMBED_DIMS,
  EMBED_MODEL,
  type EnrichEnv,
  type EnrichEvent,
} from "../src/ai/enrich";
import type { TagVocabEntry } from "../src/core/search/vocab";

const VOCAB: TagVocabEntry[] = [
  { id: "topic:hardware", facet: "topic", label: "Hardware", keywords: ["hardware", "robotics", "soldering"], color: "#e07a5f" },
  { id: "topic:software", facet: "topic", label: "Software", keywords: ["software", "rust", "ai"], color: "#f2cc8f" },
  { id: "topic:tech", facet: "topic", label: "Tech (general)", keywords: [], color: "#8d99ae" },
  { id: "format:hackathon", facet: "format", label: "Hackathon", keywords: ["hackathon", "hackathons"] },
  { id: "format:dinner", facet: "format", label: "Dinner", keywords: ["dinner", "dinners"] },
  { id: "audience:founders", facet: "audience", label: "Founders", keywords: ["founder", "founders"] },
  { id: "cost:free", facet: "cost", label: "Free", keywords: ["free", "free food"] },
  { id: "cost:paid", facet: "cost", label: "Paid", keywords: ["ticketed"] },
  { id: "cost:under-25", facet: "cost", label: "Under $25", keywords: ["$10"] },
  { id: "perk:food", facet: "perk", label: "Food", keywords: ["free food", "catered"] },
  { id: "topic:gone", facet: "topic", label: "Gone", keywords: ["gone"], status: "retired" },
];

function ev(over: Partial<EnrichEvent> = {}): EnrichEvent {
  return {
    id: "e1",
    title: "Untitled",
    description: null,
    organizer: null,
    venueName: null,
    city: "san-francisco",
    startUtc: "2026-08-01T18:00:00Z",
    isFree: null,
    priceText: null,
    contentHash: "h1",
    ...over,
  };
}

function stubModel(reply: string, ok = true) {
  const fn = vi.fn(async () =>
    ok
      ? new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : new Response("bad", { status: 500 }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe("topicCategoryDefs — the interest score keeps using the existing tagger", () => {
  it("reconstructs config/categories.json's shape from the topic facet only", () => {
    const defs = topicCategoryDefs(VOCAB);
    expect(defs.map((d) => d.id).sort()).toEqual(["hardware", "software", "tech"]);
    expect(defs.find((d) => d.id === "hardware")!.keywords).toContain("robotics");
    expect(defs.map((d) => d.id)).not.toContain("gone"); // retired
  });
});

describe("costTags — cost comes from ticket DATA, never from wording", () => {
  it("is_free wins", () => {
    expect(costTags(true, "$40")).toEqual([{ tagId: "cost:free", confidence: 1, source: "keyword" }]);
  });
  it("reads a price and marks cheap events as under-25 too", () => {
    expect(costTags(false, "$12.50 general admission").map((t) => t.tagId).sort()).toEqual(["cost:paid", "cost:under-25"]);
    expect(costTags(false, "$40").map((t) => t.tagId)).toEqual(["cost:paid"]);
  });
  it("treats a price line that says free as free", () => {
    expect(costTags(null, "Free").map((t) => t.tagId)).toEqual(["cost:free"]);
  });
  it("says nothing when there is nothing to know", () => {
    expect(costTags(null, null)).toEqual([]);
  });
});

describe("enrichDeterministic — the floor every other path falls back to", () => {
  it("tags across every facet on word boundaries", async () => {
    const [out] = await enrichDeterministic(
      [ev({ title: "Hardware Hackathon", description: "founders welcome, soldering irons provided" })],
      VOCAB,
    );
    const ids = out!.tags.map((t) => t.tagId).sort();
    expect(ids).toEqual(["audience:founders", "format:hackathon", "topic:hardware"]);
    expect(out!.tagSource).toBe("keyword");
    expect(out!.categories).toEqual(["hardware"]);
    expect(out!.interestScore).toBeGreaterThan(10);
  });

  it("refuses to let 'free food' in a description make a paid event free", async () => {
    const [out] = await enrichDeterministic(
      [ev({ title: "Founder Dinner", description: "free food and drinks", isFree: false, priceText: "$40" })],
      VOCAB,
    );
    const ids = out!.tags.map((t) => t.tagId);
    expect(ids).toContain("perk:food"); // the perk IS real
    expect(ids).toContain("cost:paid");
    expect(ids).not.toContain("cost:free"); // the price is not
  });

  it("always assigns a topic, so the legacy categories column is never blanked", async () => {
    const [out] = await enrichDeterministic([ev({ title: "Some Gathering" })], VOCAB);
    expect(out!.categories).toEqual(["tech"]);
    expect(out!.tags.find((t) => t.tagId === "topic:tech")).toBeTruthy();
  });

  it("never assigns a retired tag", async () => {
    const [out] = await enrichDeterministic([ev({ title: "Gone gone gone" })], VOCAB);
    expect(out!.tags.map((t) => t.tagId)).not.toContain("topic:gone");
  });

  it("gives more-matched tags a higher confidence, all inside [0,1]", async () => {
    const [out] = await enrichDeterministic(
      [ev({ title: "Robotics + Hardware + Soldering", description: "hardware hardware" })],
      VOCAB,
    );
    const hw = out!.tags.find((t) => t.tagId === "topic:hardware")!;
    expect(hw.confidence).toBeGreaterThan(0.5);
    expect(hw.confidence).toBeLessThanOrEqual(1);
  });

  it("is total on an empty batch", async () => {
    expect(await enrichDeterministic([], VOCAB)).toEqual([]);
  });

  it("never emits a tag the vocabulary no longer contains — the FK would 500 the batch", async () => {
    // An operator retires cost:free and topic:tech; enrichment must degrade, not throw.
    const thin = VOCAB.filter((t) => !["cost:free", "topic:tech"].includes(t.id));
    const [free] = await enrichDeterministic([ev({ title: "Some Gathering", isFree: true })], thin);
    expect(free!.tags.map((t) => t.tagId)).toEqual([]);
    expect(free!.categories).toEqual([]);
    const [paid] = await enrichDeterministic([ev({ title: "Robotics Night", isFree: false, priceText: "$40" })], thin);
    expect(paid!.tags.map((t) => t.tagId).sort()).toEqual(["cost:paid", "topic:hardware"]);
  });
});

describe("enrichEvents — the model adds tags it cannot invent, and is never required", () => {
  const CFG = { openrouterKey: "sk-test", model: "test/fast" };
  const events = [ev({ id: "e1", title: "Hardware Hackathon", description: "come build" })];
  /** What the keyword pass alone produces for `events` — the floor the model builds on. */
  const BASELINE = ["format:hackathon", "topic:hardware"];

  it("skips the model entirely with no key and no AI binding", async () => {
    const fn = stubModel('{"events":[]}');
    const [out] = await enrichEvents(events, VOCAB, { model: {} });
    expect(out!.tagSource).toBe("keyword");
    expect(fn).not.toHaveBeenCalled();
  });

  it("honours useLlm:false even when a key is configured", async () => {
    const fn = stubModel('{"events":[]}');
    await enrichEvents(events, VOCAB, { model: CFG, useLlm: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it("layers model tags on top of the keyword pass and flips tag_source to 'ai'", async () => {
    stubModel(JSON.stringify({ events: [{ id: "e1", tags: ["audience:founders", "format:hackathon"] }] }));
    const [out] = await enrichEvents(events, VOCAB, { model: CFG });
    const ids = out!.tags.map((t) => t.tagId).sort();
    expect(ids).toEqual(["audience:founders", "format:hackathon", "topic:hardware"]);
    expect(out!.tags.find((t) => t.tagId === "audience:founders")!.source).toBe("llm");
    expect(out!.tagSource).toBe("ai");
  });

  it("silently drops tags the model invented", async () => {
    stubModel(JSON.stringify({ events: [{ id: "e1", tags: ["topic:teleportation", "vibes:spicy", 7, null] }] }));
    const [out] = await enrichEvents(events, VOCAB, { model: CFG });
    expect(out!.tags.map((t) => t.tagId).sort()).toEqual(BASELINE);
    expect(out!.tagSource).toBe("keyword"); // it contributed nothing usable
  });

  it("does not let the model vote on cost — that comes from ticket data", async () => {
    stubModel(JSON.stringify({ events: [{ id: "e1", tags: ["cost:free"] }] }));
    const [out] = await enrichEvents([ev({ id: "e1", title: "Paid Summit", isFree: false, priceText: "$99" })], VOCAB, { model: CFG });
    const ids = out!.tags.map((t) => t.tagId);
    expect(ids).toContain("cost:paid");
    expect(ids).not.toContain("cost:free");
  });

  it("ignores an event id the model hallucinated back at us", async () => {
    stubModel(JSON.stringify({ events: [{ id: "not-a-real-id", tags: ["audience:founders"] }] }));
    const [out] = await enrichEvents(events, VOCAB, { model: CFG });
    expect(out!.tags.map((t) => t.tagId).sort()).toEqual(BASELINE);
  });

  it("returns the deterministic result when the model errors, times out or talks nonsense", async () => {
    for (const setup of [
      () => stubModel("", false),
      () => stubModel("sure thing!"),
      () => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("hang up"); })),
    ]) {
      setup();
      const [out] = await enrichEvents(events, VOCAB, { model: CFG });
      expect(out!.tags.map((t) => t.tagId).sort()).toEqual(BASELINE);
      expect(out!.tagSource).toBe("keyword");
      vi.unstubAllGlobals();
    }
  });

  it("keeps every event, in order, whatever the model says", async () => {
    stubModel(JSON.stringify({ events: [{ id: "b", tags: ["audience:founders"] }] }));
    const many = ["a", "b", "c"].map((id) => ev({ id, title: `Event ${id}` }));
    const out = await enrichEvents(many, VOCAB, { model: CFG });
    expect(out.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("puts the live vocabulary and every event id in the prompt", () => {
    const [system, user] = buildTagMessages(events, VOCAB);
    expect(system!.content).toContain("topic:hardware (Hardware)");
    expect(system!.content).toMatch(/never invent an id/i);
    expect(user!.content).toContain("id: e1");
    expect(user!.content).toContain("title: Hardware Hackathon");
  });
});

describe("embeddings — an entirely optional path", () => {
  const vec = (n: number) => Array.from({ length: EMBED_DIMS }, () => n);
  const events = [ev({ id: "e1", title: "Robotics Night", city: "oakland", isFree: true })];

  function fakeEnv(over: Partial<EnrichEnv> = {}): EnrichEnv {
    return {
      AI: { run: vi.fn(async (_m: string, input: any) => ({ data: input.text.map(() => vec(0.1)) })) },
      VECTORIZE: {
        upsert: vi.fn(async () => ({ mutationId: "m1" })),
        query: vi.fn(async () => ({ matches: [{ id: "e1", score: 0.9 }, { id: "e2", score: 0.8 }] })),
        deleteByIds: vi.fn(async () => ({})),
      },
      ...over,
    };
  }

  it("embeds through the Workers AI binding with the 768-dim bge model", async () => {
    const env = fakeEnv();
    const out = await embed(["hello"], env);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(EMBED_DIMS);
    expect((env.AI!.run as any).mock.calls[0][0]).toBe(EMBED_MODEL);
  });

  it("embedText leads with the title and bounds the length", () => {
    const t = embedText(ev({ title: "Robotics Night", description: "x".repeat(5000) }));
    expect(t.startsWith("Robotics Night")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(2000);
  });

  it("upserts with the metadata search filters on, and reports what was stored", async () => {
    const env = fakeEnv();
    const stored = await embedAndUpsert(events, env);
    expect(stored).toEqual([{ id: "e1", hash: "h1" }]);
    const arg = (env.VECTORIZE!.upsert as any).mock.calls[0][0][0];
    expect(arg.id).toBe("e1");
    expect(arg.values).toHaveLength(EMBED_DIMS);
    expect(arg.metadata).toEqual({ startUtc: "2026-08-01T18:00:00Z", city: "oakland", free: true });
  });

  it("is a clean no-op with VECTORIZE unbound — which is today's production default", async () => {
    expect(await embedAndUpsert(events, { AI: fakeEnv().AI })).toEqual([]);
    expect(await vectorCandidates("robots", { AI: fakeEnv().AI })).toEqual([]);
  });

  it("is a clean no-op with no Workers AI binding either", async () => {
    expect(await embed(["x"], {})).toEqual([]);
    expect(await embedAndUpsert(events, { VECTORIZE: fakeEnv().VECTORIZE })).toEqual([]);
    expect(await vectorCandidates("robots", {})).toEqual([]);
  });

  it("returns candidate ids best-first when both bindings exist", async () => {
    expect(await vectorCandidates("robots", fakeEnv())).toEqual(["e1", "e2"]);
  });

  it("swallows a throwing binding rather than failing the search", async () => {
    const boom = fakeEnv({
      VECTORIZE: {
        upsert: vi.fn(async () => { throw new Error("index missing"); }),
        query: vi.fn(async () => { throw new Error("index missing"); }),
        deleteByIds: vi.fn(async () => ({})),
      },
    });
    expect(await embedAndUpsert(events, boom)).toEqual([]);
    expect(await vectorCandidates("robots", boom)).toEqual([]);
    const badAi = fakeEnv({ AI: { run: vi.fn(async () => { throw new Error("no ai"); }) } });
    expect(await embed(["x"], badAi)).toEqual([]);
  });

  it("rejects vectors of the wrong dimensionality rather than poisoning the index", async () => {
    const wrong = fakeEnv({ AI: { run: vi.fn(async () => ({ data: [[1, 2, 3]] })) } });
    expect(await embed(["x"], wrong)).toEqual([]);
    expect(await embedAndUpsert(events, wrong)).toEqual([]);
  });

  it("does not embed an empty query", async () => {
    const env = fakeEnv();
    expect(await vectorCandidates("   ", env)).toEqual([]);
    expect(env.AI!.run).not.toHaveBeenCalled();
  });
});
