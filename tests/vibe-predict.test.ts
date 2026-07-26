import { describe, it, expect, afterEach, vi } from "vitest";
import { predictVibe, writeVibeProse, vibeLlm, VibePredictionSchema, VibeProseSchema } from "../src/ai/vibe-predict";
import { baselinePredict, templateHeadline, VIBE_AXES, type EventFacts } from "../src/core/vibe";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Stub OpenRouter with a fixed assistant reply. */
function stubModel(reply: string, ok = true) {
  const bodies: any[] = [];
  const fn = vi.fn(async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    if (!ok) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { bodies, fn };
}

const CFG = { openrouterKey: "sk-test", model: "test/model" };
const FACTS: EventFacts = {
  title: "Founders Happy Hour",
  description: "Come drink with 200 people. Sponsored by BigCorp. Recruiters welcome!",
  categories: ["networking"],
  city: "san-francisco",
  venueName: "Frontier Tower",
  isFree: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("predictVibe", () => {
  it("uses the model when it answers in shape", async () => {
    stubModel(JSON.stringify({ energy: 88, formality: 12, intimacy: 22, talkRatio: 5, signal: 44, approachability: 91, crowd: { founders: 60, recruiters: 40 }, bestFor: ["a loose night out"], expect: ["Loud"] }));
    const out = await predictVibe(FACTS, CFG, {});
    expect(out.model).toBe("test/model");
    expect(out.prediction.axes.energy).toBe(88);
    expect(out.prediction.crowd.founders).toBe(60);
    expect(out.prediction.bestFor).toEqual(["a loose night out"]);
  });

  it("falls back to the deterministic baseline when NO model is configured", async () => {
    const { fn } = stubModel("{}");
    const out = await predictVibe(FACTS, {}, {});
    expect(fn).not.toHaveBeenCalled();
    expect(out.model).toBeNull();
    expect(out.prediction).toEqual(baselinePredict(FACTS));
  });

  it("falls back when the model errors, times out, or answers garbage", async () => {
    for (const [reply, ok] of [["not json", true], ["", false], ['{"energy":"loud"}', true]] as const) {
      stubModel(reply, ok);
      const out = await predictVibe(FACTS, CFG, {});
      expect(out.model).toBeNull();
      expect(out.prediction).toEqual(baselinePredict(FACTS));
    }
  });

  it("clamps a model that returns out-of-range axes rather than trusting it", async () => {
    stubModel(JSON.stringify({ energy: 900, formality: -50, intimacy: 50, talkRatio: 50, signal: 50, approachability: 50 }));
    const out = await predictVibe(FACTS, CFG, {});
    expect(out.prediction.axes.energy).toBe(100);
    expect(out.prediction.axes.formality).toBe(0);
  });

  it("asks for JSON and gives the model the listing to read", async () => {
    const { bodies } = stubModel(JSON.stringify(Object.fromEntries(VIBE_AXES.map((a) => [a, 50]))));
    await predictVibe(FACTS, CFG, {});
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
    const prompt = bodies[0].messages.map((m: any) => m.content).join("\n");
    expect(prompt).toContain("Founders Happy Hour");
    expect(prompt).toContain("Recruiters welcome");
  });
});

describe("writeVibeProse", () => {
  const AXES = { energy: 88, formality: 15, intimacy: 25, talkRatio: 8, signal: 82, approachability: 85 };

  it("uses the model's headline and blurb when they're usable", async () => {
    stubModel(JSON.stringify({ headline: "Loud, hoodie-dense, deal-flow heavy.", blurb: "A packed room where nobody sits down. " .repeat(2) }));
    const out = await writeVibeProse(AXES, FACTS, ["a loose night out"], CFG, {});
    expect(out.headline).toBe("Loud, hoodie-dense, deal-flow heavy.");
    expect(out.model).toBe("test/model");
  });

  it("writes prose from the NUMBERS, never from the raw listing copy", async () => {
    const { bodies } = stubModel(JSON.stringify({ headline: "x.", blurb: "y" }));
    await writeVibeProse(AXES, FACTS, ["a loose night out"], CFG, {});
    const prompt = bodies[0].messages.map((m: any) => m.content).join("\n");
    // the axes and their band labels are in the prompt …
    expect(prompt).toContain("energy");
    expect(prompt).toContain("88");
    expect(prompt).toContain("Founders Happy Hour"); // structured fact: the title
    // … but the marketing copy is deliberately withheld so it can't free-associate
    expect(prompt).not.toContain("Recruiters welcome");
    expect(prompt).not.toContain("Sponsored by BigCorp");
  });

  it("falls back to the deterministic template with no model configured", async () => {
    const out = await writeVibeProse(AXES, FACTS, [], {}, {});
    expect(out.model).toBeNull();
    expect(out.headline).toBe(templateHeadline(AXES, FACTS));
    expect(out.blurb.length).toBeGreaterThan(40);
  });

  it("rejects a model headline that is an essay or empty, and templates instead", async () => {
    for (const headline of ["", "x".repeat(400)]) {
      stubModel(JSON.stringify({ headline, blurb: "fine blurb that is long enough to be a real sentence." }));
      const out = await writeVibeProse(AXES, FACTS, [], CFG, {});
      expect(out.headline).toBe(templateHeadline(AXES, FACTS));
      expect(out.model).toBeNull();
    }
  });
});

describe("vibeLlm — wiring the platform key + budget out of Env", () => {
  it("returns a null-key config when the platform has no key, so callers degrade", () => {
    expect(vibeLlm({}).cfg.openrouterKey ?? null).toBeNull();
  });

  it("prefers the quality model for vibes and carries the daily budget guard", () => {
    const kv = { async get() { return null; }, async put() {} };
    const { cfg, opts } = vibeLlm({ OPENROUTER_API_KEY: "sk", OPENROUTER_MODEL_QUALITY: "q", OPENROUTER_MODEL_FAST: "f", LLM_DAILY_BUDGET_USD: "5", SESSIONS: kv } as any);
    expect(cfg.model).toBe("q");
    expect(opts.budget?.dailyUsd).toBe(5);
    expect(opts.cache).toBe(kv);
  });

  it("omits the budget guard when no ceiling is configured", () => {
    expect(vibeLlm({ OPENROUTER_API_KEY: "sk" } as any).opts.budget).toBeNull();
  });
});

describe("the schemas keep a sloppy model honest", () => {
  it("requires all six axes", () => {
    expect(VibePredictionSchema.safeParse({ energy: 1 }).success).toBe(false);
  });
  it("requires a headline and a blurb", () => {
    expect(VibeProseSchema.safeParse({ headline: "hi." }).success).toBe(false);
  });
});
