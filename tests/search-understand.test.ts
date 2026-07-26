import { describe, it, expect, afterEach, vi } from "vitest";
import { buildMessages, mergeModelOutput, understandQuery, UnderstandSchema } from "../src/core/search/understand";
import { parseQuery } from "../src/core/search/parse";
import type { TagVocabEntry } from "../src/core/search/vocab";

const VOCAB: TagVocabEntry[] = [
  { id: "topic:hardware", facet: "topic", label: "Hardware", keywords: ["hardware", "robotics"] },
  { id: "topic:software", facet: "topic", label: "Software", keywords: ["software", "ai"] },
  { id: "format:meetup", facet: "format", label: "Meetup", keywords: ["meetup", "meetups"] },
  { id: "format:dinner", facet: "format", label: "Dinner", keywords: ["dinner", "dinners"] },
  { id: "audience:founders", facet: "audience", label: "Founders", keywords: ["founder", "founders"] },
  { id: "cost:free", facet: "cost", label: "Free", keywords: ["free"] },
  { id: "topic:gone", facet: "topic", label: "Gone", keywords: ["gone"], status: "retired" },
];

const NOW = Date.parse("2026-07-24T20:00:00Z");
const CFG = { openrouterKey: "sk-test", model: "test/fast" };

/** Stub OpenRouter with a canned assistant message. */
function stubModel(reply: string, ok = true) {
  const fn = vi.fn(async () =>
    ok
      ? new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : new Response("nope", { status: 500 }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

describe("buildMessages — the LIVE vocabulary is injected, not a bundled copy", () => {
  it("lists every active tag id with its label, grouped by facet", () => {
    const [system, user] = buildMessages("Free HARDWARE   meetups", VOCAB);
    expect(system!.content).toContain("topic: topic:hardware (Hardware)");
    expect(system!.content).toContain("format: format:meetup (Meetup), format:dinner (Dinner)");
    expect(system!.content).not.toContain("topic:gone"); // retired tags are not offered
    // The user turn is normalized, so casing/whitespace variants share a cache entry.
    expect(user!.content).toBe("free hardware meetups");
  });

  it("tells the model in the system prompt that inventing an id is forbidden", () => {
    expect(buildMessages("x", VOCAB)[0]!.content).toMatch(/never invent an id/i);
  });
});

describe("UnderstandSchema — cheap models omit and null fields at random", () => {
  it("accepts a sparse object", () => {
    expect(UnderstandSchema.safeParse({}).success).toBe(true);
    expect(UnderstandSchema.safeParse({ free: null, near: null, window: null, tags: null }).success).toBe(true);
  });
  it("rejects a window it made up", () => {
    expect(UnderstandSchema.safeParse({ window: "next fortnight" }).success).toBe(false);
  });
});

describe("mergeModelOutput — the deterministic parse is the floor, never the ceiling", () => {
  const fallback = parseQuery("free hardware meetups in soma next week", VOCAB, NOW);

  it("returns the fallback untouched when the model produced nothing", () => {
    expect(mergeModelOutput(null, fallback, VOCAB)).toEqual(fallback);
  });

  it("drops every tag the model invented, keeping the ones that exist", () => {
    const out = mergeModelOutput({ tags: ["topic:teleportation", "audience:founders", "format:seance"] }, fallback, VOCAB);
    expect(out.filters.tags).toContain("audience:founders");
    expect(out.filters.tags).not.toContain("topic:teleportation");
    expect(out.filters.tags).not.toContain("format:seance");
  });

  it("unions tags, so a tag the regexes found survives a model that missed it", () => {
    const out = mergeModelOutput({ tags: [] }, fallback, VOCAB);
    expect(out.filters.tags).toEqual(expect.arrayContaining(fallback.filters.tags));
  });

  it("lets the model win on the place, the window, the residual and the intent", () => {
    const out = mergeModelOutput(
      { near: "South of Market", window: "weekend", semanticQuery: "people actually building robots", intent: "meet" },
      fallback,
      VOCAB,
    );
    expect(out.filters.near).toBe("south of market");
    expect(out.filters.window).toBe("weekend");
    expect(out.semanticQuery).toBe("people actually building robots");
    expect(out.intent).toBe("meet");
  });

  it("sanitises `near` — it reaches a LIKE clause, so it may only be place-shaped", () => {
    expect(mergeModelOutput({ near: "  SoMa%'; DROP--  " }, fallback, VOCAB).filters.near).toBe("soma drop");
    expect(mergeModelOutput({ near: "x" }, fallback, VOCAB).filters.near).toBe(fallback.filters.near); // too short
    expect(mergeModelOutput({ near: "a".repeat(200) }, fallback, VOCAB).filters.near).toBe(fallback.filters.near);
    expect(mergeModelOutput({ near: 42 as any }, fallback, VOCAB).filters.near).toBe(fallback.filters.near);
  });

  it("never turns a deterministic `free` off", () => {
    expect(mergeModelOutput({ free: false }, fallback, VOCAB).filters.free).toBe(true);
    const plain = parseQuery("hardware", VOCAB, NOW);
    expect(mergeModelOutput({ free: false }, plain, VOCAB).filters.free).toBeUndefined();
    expect(mergeModelOutput({ free: true }, plain, VOCAB).filters.free).toBe(true);
  });

  it("keeps the fallback residual when the model returns an empty one", () => {
    expect(mergeModelOutput({ semanticQuery: "   " }, fallback, VOCAB).semanticQuery).toBe(fallback.semanticQuery);
  });
});

describe("understandQuery — the model is an optimisation, never a dependency", () => {
  it("does not even build a prompt without a key or a Workers AI binding", async () => {
    const fn = stubModel('{"tags":["topic:software"]}');
    const out = await understandQuery("free hardware meetups", VOCAB, { model: {}, now: NOW });
    expect(out.source).toBe("deterministic");
    expect(fn).not.toHaveBeenCalled();
    expect(out.filters.free).toBe(true);
  });

  it("falls back deterministically on an HTTP error", async () => {
    stubModel("", false);
    const out = await understandQuery("free hardware meetups", VOCAB, { model: CFG, now: NOW });
    expect(out.source).toBe("deterministic");
    expect(out.filters.tags).toContain("topic:hardware");
  });

  it("falls back deterministically on unparseable output", async () => {
    stubModel("I'm afraid I can't do that, Dave.");
    expect((await understandQuery("hardware", VOCAB, { model: CFG, now: NOW })).source).toBe("deterministic");
  });

  it("falls back deterministically when the shape doesn't fit the schema", async () => {
    stubModel('{"window":"next fortnight"}');
    expect((await understandQuery("hardware", VOCAB, { model: CFG, now: NOW })).source).toBe("deterministic");
  });

  it("uses the model when it works, and still refuses its invented tags", async () => {
    stubModel(
      JSON.stringify({
        tags: ["audience:founders", "topic:unicorns"],
        free: true,
        near: "SoMa",
        window: "7d",
        semanticQuery: "people actually building robots",
        intent: "meet",
      }),
    );
    const out = await understandQuery("free hardware meetups in soma next week where i'll meet robotics people", VOCAB, {
      model: CFG,
      now: NOW,
    });
    expect(out.source).toBe("llm");
    expect(out.filters.tags).toContain("audience:founders");
    expect(out.filters.tags).toContain("topic:hardware"); // union with the deterministic parse
    expect(out.filters.tags).not.toContain("topic:unicorns");
    expect(out.filters.near).toBe("soma");
    expect(out.filters.window).toBe("7d");
    expect(out.intent).toBe("meet");
  });

  it("an empty query short-circuits to 'browse' without calling anything", async () => {
    const fn = stubModel("{}");
    const out = await understandQuery("   ", VOCAB, { model: CFG, now: NOW });
    expect(out).toMatchObject({ source: "deterministic", intent: "browse", semanticQuery: "" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("serves a repeated phrasing from the KV cache instead of the model", async () => {
    const map = new Map<string, string>();
    const cache = { async get(k: string) { return map.get(k) ?? null; }, async put(k: string, v: string) { map.set(k, v); } };
    const fn = stubModel('{"tags":["audience:founders"],"intent":"find"}');

    await understandQuery("Founder dinners", VOCAB, { model: CFG, cache, now: NOW });
    expect(fn).toHaveBeenCalledTimes(1);
    // different casing/whitespace — same normalized query, so the same cache entry
    const again = await understandQuery("  founder   DINNERS ", VOCAB, { model: CFG, cache, now: NOW });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(again.source).toBe("llm");
  });

  it("stops calling the model once the daily ceiling is hit", async () => {
    const map = new Map<string, string>([["llm:spend:2026-07-26", "100"]]);
    const kv = { async get(k: string) { return map.get(k) ?? null; }, async put(k: string, v: string) { map.set(k, v); } };
    const fn = stubModel('{"tags":["audience:founders"]}');
    const out = await understandQuery("founder dinners", VOCAB, {
      model: CFG,
      budget: { kv, dailyUsd: 1, costPerCallUsd: 1, today: "2026-07-26" },
      now: NOW,
    });
    expect(out.source).toBe("deterministic");
    expect(fn).not.toHaveBeenCalled();
  });

  it("survives a model that throws mid-flight", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    expect((await understandQuery("hardware", VOCAB, { model: CFG, now: NOW })).source).toBe("deterministic");
  });
});
