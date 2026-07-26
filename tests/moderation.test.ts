import { describe, it, expect } from "vitest";
import { screenText, buildModerationRequest, parseModerationVerdict, moderateText } from "../src/ai/moderation";

/** A fake Workers-AI binding that returns a canned classifier reply. */
const fakeAI = (response: string) => ({ AI: { run: async () => ({ response }) } });

describe("screenText — deterministic hard-screen", () => {
  it("allows candid / profane / negative founder talk", () => {
    for (const t of [
      "anyone at the AI infra dinner?",
      "this pitch is going to kill me lol",
      "honestly this VC's thesis is dogshit",
      "our launch bombed, feeling rough",
      "",
    ]) {
      expect(screenText(t).allow).toBe(true);
    }
  });

  it("blocks unambiguous threats and self-harm encouragement", () => {
    for (const t of ["kys", "just go kill yourself", "kill urself", "I will kill you at the meetup", "hang yourself"]) {
      expect(screenText(t).allow).toBe(false);
    }
  });
});

describe("buildModerationRequest — prompt shape", () => {
  it("is a system+user pair that whitelists edgy talk and truncates long input", () => {
    const msgs = buildModerationRequest("x".repeat(5000));
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content.toLowerCase()).toContain("allow profanity");
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content.length).toBe(1000); // truncated
  });
});

describe("parseModerationVerdict — robust parse", () => {
  it("reads a clean JSON verdict", () => {
    expect(parseModerationVerdict('{"allow": false, "reason": "hate"}')).toEqual({ allow: false, reason: "hate" });
    expect(parseModerationVerdict('{"allow": true, "reason": ""}')).toEqual({ allow: true, reason: "" });
  });
  it("extracts JSON wrapped in code fences / prose", () => {
    expect(parseModerationVerdict('Sure!\n```json\n{"allow": false, "reason": "threat"}\n```').allow).toBe(false);
  });
  it("falls back to a keyword scan, then to allow", () => {
    expect(parseModerationVerdict("This violates the policy.").allow).toBe(false);
    expect(parseModerationVerdict("looks fine to me").allow).toBe(true);
    expect(parseModerationVerdict(null).allow).toBe(true);
  });
});

describe("moderateText — full pipeline", () => {
  it("hard-screen blocks before any model call (works with no LLM)", async () => {
    const v = await moderateText("kys");
    expect(v.allow).toBe(false);
    expect(v.reason).toContain("self-harm");
  });

  it("allows when no model is configured and the hard-screen passed", async () => {
    expect((await moderateText("gm bay, who's hiring?")).allow).toBe(true);
  });

  it("uses the LLM verdict for the nuanced tail", async () => {
    const blocked = await moderateText("<targeted hate here>", { env: fakeAI('{"allow": false, "reason": "targeted hate"}') });
    expect(blocked).toEqual({ allow: false, reason: "targeted hate" });
    const allowed = await moderateText("great meeting everyone tonight", { env: fakeAI('{"allow": true, "reason": ""}') });
    expect(allowed.allow).toBe(true);
  });
});
