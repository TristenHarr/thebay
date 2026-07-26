import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { completeJson, extractJson, cacheKey, type KvLike } from "../src/ai/json-llm";

/** Map-backed KV stub. Records puts so we can assert cache/budget writes. */
function memKv(): KvLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(k) { return map.get(k) ?? null; },
    async put(k, v) { map.set(k, v); },
  };
}

/** Stub OpenRouter. Returns `reply` as the assistant message; counts calls. */
function stubModel(reply: string | (() => string), ok = true) {
  const calls: any[] = [];
  const fn = vi.fn(async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    if (!ok) return new Response("nope", { status: 500 });
    const content = typeof reply === "function" ? reply() : reply;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

const Schema = z.object({ tags: z.array(z.string()), score: z.number() });
const MSGS = [{ role: "user" as const, content: "tag this" }];
const CFG = { openrouterKey: "sk-test", model: "test/model" };

afterEach(() => vi.unstubAllGlobals());

describe("extractJson", () => {
  it("parses clean JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips code fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers JSON buried in prose — cheap models add preamble even when told not to", () => {
    expect(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it("recovers a bare array", () => {
    expect(extractJson("Here: [1,2,3]")).toEqual([1, 2, 3]);
  });

  it("returns null rather than throwing on garbage", () => {
    expect(extractJson("no json at all")).toBeNull();
    expect(extractJson("")).toBeNull();
    expect(extractJson(null)).toBeNull();
  });

  it("returns null on a truncated object (max_tokens cut it off)", () => {
    expect(extractJson('{"a":1,"b":')).toBeNull();
  });
});

describe("cacheKey", () => {
  it("is stable for identical input", () => {
    expect(cacheKey("m", MSGS)).toBe(cacheKey("m", MSGS));
  });

  it("changes with the model — switching models must not serve output shaped by the old one", () => {
    expect(cacheKey("a", MSGS)).not.toBe(cacheKey("b", MSGS));
  });

  it("changes with the messages", () => {
    expect(cacheKey("m", MSGS)).not.toBe(cacheKey("m", [{ role: "user", content: "other" }]));
  });
});

describe("completeJson", () => {
  it("returns validated data on the happy path", async () => {
    stubModel('{"tags":["ai"],"score":80}');
    expect(await completeJson(MSGS, CFG, { schema: Schema })).toEqual({ tags: ["ai"], score: 80 });
  });

  it("requests JSON mode at temperature 0", async () => {
    const { calls } = stubModel('{"tags":[],"score":1}');
    await completeJson(MSGS, CFG, { schema: Schema });
    expect(calls[0].response_format).toEqual({ type: "json_object" });
    expect(calls[0].temperature).toBe(0);
  });

  it("returns null when the model's shape does not satisfy the schema", async () => {
    stubModel('{"tags":"not-an-array","score":80}');
    expect(await completeJson(MSGS, CFG, { schema: Schema })).toBeNull();
  });

  it("returns null when the model returns unparseable output", async () => {
    stubModel("I'm afraid I can't do that");
    expect(await completeJson(MSGS, CFG, { schema: Schema })).toBeNull();
  });

  it("returns null on an HTTP error", async () => {
    stubModel("", false);
    expect(await completeJson(MSGS, CFG, { schema: Schema })).toBeNull();
  });

  it("returns null when no model is configured at all", async () => {
    const { fn } = stubModel('{"tags":[],"score":1}');
    expect(await completeJson(MSGS, {}, { schema: Schema })).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("writes to the cache on a miss and serves the next call without touching the model", async () => {
    const cache = memKv();
    const { fn } = stubModel('{"tags":["ai"],"score":80}');

    const first = await completeJson(MSGS, CFG, { schema: Schema, cache });
    expect(first).toEqual({ tags: ["ai"], score: 80 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(cache.map.size).toBe(1);

    const second = await completeJson(MSGS, CFG, { schema: Schema, cache });
    expect(second).toEqual({ tags: ["ai"], score: 80 });
    expect(fn).toHaveBeenCalledTimes(1); // still 1 — served from cache
  });

  it("treats a cached value that no longer fits the schema as a miss, not as data", async () => {
    const cache = memKv();
    cache.map.set(cacheKey(CFG.model, MSGS), '{"tags":"stale-shape"}');
    stubModel('{"tags":["fresh"],"score":10}');

    // Schemas change across deploys; a stale shape must never resurface as live data.
    expect(await completeJson(MSGS, CFG, { schema: Schema, cache })).toEqual({ tags: ["fresh"], score: 10 });
  });

  it("refresh:true bypasses the cache read but still writes", async () => {
    const cache = memKv();
    cache.map.set(cacheKey(CFG.model, MSGS), '{"tags":["old"],"score":1}');
    const { fn } = stubModel('{"tags":["new"],"score":2}');

    expect(await completeJson(MSGS, CFG, { schema: Schema, cache, refresh: true })).toEqual({ tags: ["new"], score: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(cache.map.get(cacheKey(CFG.model, MSGS))!)).toEqual({ tags: ["new"], score: 2 });
  });

  it("counts a call against the daily budget", async () => {
    const kv = memKv();
    stubModel('{"tags":[],"score":1}');
    await completeJson(MSGS, CFG, {
      schema: Schema,
      budget: { kv, dailyUsd: 10, costPerCallUsd: 1, today: "2026-07-26" },
    });
    expect(kv.map.get("llm:spend:2026-07-26")).toBe("1");
  });

  it("refuses to call the model once the daily ceiling is reached", async () => {
    const kv = memKv();
    kv.map.set("llm:spend:2026-07-26", "10"); // 10 calls × $1 = the $10 ceiling
    const { fn } = stubModel('{"tags":[],"score":1}');

    const out = await completeJson(MSGS, CFG, {
      schema: Schema,
      budget: { kv, dailyUsd: 10, costPerCallUsd: 1, today: "2026-07-26" },
    });
    expect(out).toBeNull();
    expect(fn).not.toHaveBeenCalled(); // a runaway loop must cost nothing
  });

  it("rolls over to a fresh ceiling on a new day", async () => {
    const kv = memKv();
    kv.map.set("llm:spend:2026-07-26", "10");
    stubModel('{"tags":[],"score":1}');

    const out = await completeJson(MSGS, CFG, {
      schema: Schema,
      budget: { kv, dailyUsd: 10, costPerCallUsd: 1, today: "2026-07-27" },
    });
    expect(out).toEqual({ tags: [], score: 1 });
  });

  it("survives a KV that throws — the cache is an optimisation, not a dependency", async () => {
    const broken: KvLike = {
      async get() { throw new Error("kv down"); },
      async put() { throw new Error("kv down"); },
    };
    stubModel('{"tags":["ai"],"score":80}');
    expect(await completeJson(MSGS, CFG, { schema: Schema, cache: broken })).toEqual({ tags: ["ai"], score: 80 });
  });
});
