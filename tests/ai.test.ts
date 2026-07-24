import { describe, it, expect } from "vitest";
import { buildResearchBrief } from "../src/ai/research";
import { suggestNetworkActions } from "../src/ai/agent";

describe("event deep-research", () => {
  const base = {
    event: { title: "AI Infra Founders Dinner", startUtc: "2026-09-01T01:00:00Z", venueName: "Shack15", categories: ["ai", "infra"] },
    goals: ["Find a technical co-founder for my AI infra startup"],
    interests: ["kubernetes", "compilers"],
  };

  it("ranks who to meet by goal/interest overlap and flags VIPs, skipping existing friends", () => {
    const brief = buildResearchBrief({
      ...base,
      attendees: [
        { id: "u1", displayName: "Ivy Infra", handle: "ivy", bio: "Founder building AI infra & compilers. ex-kernel eng.", mutuals: 2 },
        { id: "u2", displayName: "Randy Random", handle: "randy", bio: "I like gardening and jazz." },
        { id: "u3", displayName: "Frank Friend", handle: "frank", bio: "Investor, ex-founder, into compilers", isFriend: true },
      ],
    });
    // Ivy is the top pick (overlap + VIP + mutuals); Frank excluded (already a friend); Randy scores 0
    expect(brief.whoToMeet[0]?.handle).toBe("ivy");
    expect(brief.whoToMeet.map((w) => w.handle)).not.toContain("frank");
    expect(brief.whoToMeet.map((w) => w.handle)).not.toContain("randy");
    // VIPs still surface founder/investor signals even for friends
    expect(brief.vips.some((v) => v.handle === "ivy")).toBe(true);
    expect(brief.fitScore).toBeGreaterThan(0);
    expect(brief.talkingPoints.length).toBeGreaterThan(0);
    expect(brief.summary).toContain("Ivy Infra");
  });

  it("gives a light-fit, low score when nobody matches", () => {
    const brief = buildResearchBrief({
      ...base,
      attendees: [{ id: "z", displayName: "Zoe", handle: "zoe", bio: "poet and baker" }],
    });
    expect(brief.whoToMeet.length).toBe(0);
    expect(brief.fitScore).toBeLessThan(60);
    expect(brief.headline).toMatch(/Optional|Worth/);
  });
});

describe("AI networking agent", () => {
  it("ranks candidates and picks warm intros when mutuals exist, else direct connects", () => {
    const suggestions = suggestNetworkActions({
      goals: ["scale my AI infra startup"],
      interests: ["compilers"],
      candidates: [
        { id: "a", displayName: "Ann", handle: "ann", bio: "AI infra founder, compilers", mutuals: 3, sharedEvents: 2 },
        { id: "b", displayName: "Bob", handle: "bob", bio: "compilers researcher", mutuals: 0, sharedEvents: 1 },
        { id: "c", displayName: "Cid", handle: "cid", bio: "totally unrelated" },
      ],
    });
    expect(suggestions[0]?.handle).toBe("ann"); // highest score
    expect(suggestions[0]?.action).toBe("intro"); // has mutuals → warm path
    expect(suggestions.find((s) => s.handle === "bob")?.action).toBe("connect"); // no mutuals → direct
    expect(suggestions.map((s) => s.handle)).not.toContain("cid"); // zero signal excluded
  });

  it("respects the limit", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({ id: `u${i}`, displayName: `U${i}`, handle: `u${i}`, bio: "compilers", sharedEvents: 1 }));
    expect(suggestNetworkActions({ interests: ["compilers"], candidates }, 3).length).toBe(3);
  });
});

describe("AI edge cases", () => {
  it("research on an empty room returns fitScore 0 and a clear-ask headline without crashing", () => {
    const brief = buildResearchBrief({ event: { title: "Empty Room", startUtc: "2026-09-01T01:00:00Z" }, attendees: [], goals: ["raise a seed"], interests: [] });
    expect(brief.fitScore).toBe(0);
    expect(brief.whoToMeet).toEqual([]);
    expect(brief.headline).toMatch(/Optional/);
    expect(brief.summary).toContain("clear ask");
  });

  it("a room of only existing friends yields no intro suggestions", () => {
    const brief = buildResearchBrief({
      event: { title: "Friends Only", startUtc: "2026-09-01T01:00:00Z" },
      attendees: [{ id: "f1", displayName: "Fran", handle: "fran", bio: "AI founder compilers", isFriend: true }],
      goals: ["AI compilers"], interests: ["compilers"],
    });
    expect(brief.whoToMeet).toEqual([]); // friend excluded despite strong overlap
  });

  it("suggestNetworkActions preserves input order on score ties (stable) and gates intro vs connect at mutuals 0", () => {
    const tie = suggestNetworkActions({
      interests: ["compilers"],
      candidates: [
        { id: "x", displayName: "X", handle: "x", bio: "compilers", sharedEvents: 1 }, // score 10+6=16, mutuals 0 → connect
        { id: "y", displayName: "Y", handle: "y", bio: "compilers", sharedEvents: 1 }, // identical score
      ],
    });
    expect(tie.map((s) => s.handle)).toEqual(["x", "y"]); // stable order
    expect(tie[0]!.action).toBe("connect"); // mutuals 0
    const warm = suggestNetworkActions({ interests: ["compilers"], candidates: [{ id: "z", displayName: "Z", handle: "z", bio: "compilers", mutuals: 1 }] });
    expect(warm[0]!.action).toBe("intro"); // mutuals ≥1 → warm path
  });
});

import { buildOpenRouterRequest, chatComplete } from "../src/ai/llm";

describe("bring-your-own LLM (OpenRouter)", () => {
  it("builds an OpenRouter request with the user's key + model", () => {
    const { url, init } = buildOpenRouterRequest([{ role: "user", content: "hi" }], { openrouterKey: "sk-abc", model: "anthropic/claude-3.5-sonnet" });
    expect(url).toContain("openrouter.ai");
    expect((init.headers as any).authorization).toBe("Bearer sk-abc");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("anthropic/claude-3.5-sonnet");
    expect(body.messages[0].content).toBe("hi");
  });

  it("returns null when neither a key nor Workers AI is available (caller uses deterministic output)", async () => {
    expect(await chatComplete([{ role: "user", content: "x" }], {})).toBeNull();
  });
});
