/**
 * Moderation policy, encoded as tests.
 *
 * The governing rule is *let people speak*, so the most important assertions here
 * are NEGATIVE ones: that no amount of flagging hides anything, and that the
 * noise scorer never refuses a submission. Those are the properties that would be
 * easy to erode later by "just adding a threshold", and they're the ones a young
 * site most needs protected.
 */
import { describe, it, expect } from "vitest";
import { scoreSubmission, needsReview, REVIEW_SCORE } from "../src/news/spam";
import { rateVerdict, waitMessage, LIMITS } from "../src/news/ratelimit";

describe("noise scoring never blocks", () => {
  it("exposes no blocking API at all", () => {
    const v: any = scoreSubmission({ title: "Buy now cheap viagra casino", url: "https://bit.ly/x" });
    // If a `block` field ever reappears, this site has quietly changed its rules.
    expect(v.block).toBeUndefined();
    expect(Object.keys(v).sort()).toEqual(["score", "signals"]);
  });

  it("scores obvious commercial spam high enough to review", () => {
    const v = scoreSubmission({
      title: "Make $5000 per day from home", url: "https://bit.ly/abc", body: "buy now cheap",
    });
    expect(needsReview(v)).toBe(true);
    expect(v.signals.map((s) => s.code)).toContain("url_shortener");
    expect(v.signals.map((s) => s.code)).toContain("spam_phrase");
  });

  it("does NOT penalise enthusiasm, caps, punctuation, or newness", () => {
    // The exact submission a heavier filter would have refused.
    const v = scoreSubmission({
      title: "WE SHIPPED IT!!! our MEMS resonator finally hit 12k Q",
      url: "https://example.com/build-log",
    });
    expect(v.score).toBe(0);
    expect(needsReview(v)).toBe(false);
  });

  it("does not penalise a short title or a first-ever post", () => {
    expect(scoreSubmission({ title: "Fab notes", url: "https://ex.com/a" }).score).toBe(0);
  });

  it("flags an operator's blocked domain for review without refusing it", () => {
    const v = scoreSubmission({
      title: "A normal looking title", url: "https://spam.example/x",
      blockedDomains: ["spam.example"],
    });
    expect(needsReview(v)).toBe(true);
    expect((v as any).block).toBeUndefined(); // still not refused
  });

  it("notices one author flooding one domain, but not a second post", () => {
    const twice = scoreSubmission({ title: "t", url: "https://mysite.com/2", recentDomains: ["mysite.com", "mysite.com"] });
    expect(needsReview(twice)).toBe(false); // two posts is not flooding
    const many = scoreSubmission({ title: "t", url: "https://mysite.com/4", recentDomains: Array(4).fill("mysite.com") });
    expect(many.signals.map((s) => s.code)).toContain("domain_flooding");
  });

  it("notices a link farm body", () => {
    const body = Array.from({ length: 6 }, (_, i) => `https://x${i}.com`).join(" ");
    expect(scoreSubmission({ title: "Resources", body }).signals.map((s) => s.code)).toContain("link_farm");
  });

  it("REVIEW_SCORE only orders a queue — it is not an enforcement threshold", () => {
    expect(REVIEW_SCORE).toBeGreaterThan(0);
    expect(needsReview({ score: REVIEW_SCORE, signals: [] })).toBe(true);
    expect(needsReview({ score: REVIEW_SCORE - 1, signals: [] })).toBe(false);
  });
});

describe("cooldowns are the actual enforcement", () => {
  it("refuses a burst and says exactly how long to wait", () => {
    const v = rateVerdict({ inWindow: 1, limit: LIMITS.submit, sinceLastSeconds: 15 });
    expect(v.ok).toBe(false);
    expect(v.retryAfterSeconds).toBe(45); // 60s cooldown, 15s elapsed
  });

  it("permits the action once the cooldown has passed", () => {
    expect(rateVerdict({ inWindow: 1, limit: LIMITS.submit, sinceLastSeconds: 61 }).ok).toBe(true);
  });

  it("permits a first-ever action", () => {
    expect(rateVerdict({ inWindow: 0, limit: LIMITS.submit }).ok).toBe(true);
  });

  it("still enforces the hourly cap once the cooldown is satisfied", () => {
    const v = rateVerdict({ inWindow: LIMITS.submit.max, limit: LIMITS.submit, sinceLastSeconds: 9999 });
    expect(v.ok).toBe(false);
    expect(v.retryAfterSeconds).toBe(LIMITS.submit.windowSeconds);
  });

  it("prefers the cooldown message when both would refuse", () => {
    // "try again in 45s" is actionable; "hourly limit" is not.
    const v = rateVerdict({ inWindow: LIMITS.submit.max, limit: LIMITS.submit, sinceLastSeconds: 15 });
    expect(v.retryAfterSeconds).toBe(45);
  });

  it("leaves voting free of cooldowns so reading never feels broken", () => {
    expect((LIMITS.vote as any).cooldownSeconds).toBeUndefined();
    expect(rateVerdict({ inWindow: 3, limit: LIMITS.vote, sinceLastSeconds: 0 }).ok).toBe(true);
  });

  it("is stricter on submitting than commenting — conversation gets room", () => {
    expect(LIMITS.submit.cooldownSeconds).toBeGreaterThan(LIMITS.comment.cooldownSeconds);
    expect(LIMITS.submit.max).toBeLessThan(LIMITS.comment.max);
  });

  it("renders a human wait", () => {
    expect(waitMessage(45)).toBe("45s");
    expect(waitMessage(90)).toBe("2 min");
    expect(waitMessage(3600)).toBe("1h");
    expect(waitMessage(0)).toBe("");
  });
});
