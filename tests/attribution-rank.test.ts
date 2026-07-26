/**
 * The model's only job in identity resolution: reordering. These tests pin the
 * blast radius — the worst a bad or hostile ranking can do is put the right
 * person second.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildRankPrompt, rankCandidates, RankSchema } from "../src/core/attribution/rank";
import type { Candidate } from "../src/core/attribution/identity";
import * as llm from "../src/ai/llm";

const person = { name: "Ann Lee", role: "Executive Officer" };
const company = { id: "c1", name: "Acme Robotics, Inc." };
const candidates: Candidate[] = [
  { userId: "u-ann", handle: "annlee", displayName: "Ann Lee", score: 0.8, signals: ["name:exact", "domain:email"] },
  { userId: "u-ann2", handle: "alee", displayName: "A. Lee", score: 0.25, signals: ["name:initial"] },
];

function mockModel(reply: string | null) {
  return vi.spyOn(llm, "chatComplete").mockResolvedValue(reply);
}
afterEach(() => vi.restoreAllMocks());

describe("buildRankPrompt", () => {
  it("identifies candidates by ordinal, never by an id the model could invent", () => {
    const msgs = buildRankPrompt(person, company, candidates);
    const body = msgs.map((m) => m.content).join("\n");
    expect(body).toContain("1. Ann Lee");
    expect(body).toContain("2. A. Lee");
    expect(body).not.toContain("u-ann"); // no internal ids leave the process
    expect(body).not.toContain("@"); // no emails / handles either
    expect(msgs[0]!.content).toMatch(/human confirms every match/i);
  });

  it("accepts only an array of ordinals", () => {
    expect(RankSchema.safeParse({ order: [2, 1] }).success).toBe(true);
    expect(RankSchema.safeParse({ order: ["u-ann"] }).success).toBe(false);
    expect(RankSchema.safeParse({ winner: "u-ann" }).success).toBe(false);
  });
});

describe("rankCandidates", () => {
  it("reorders when the model answers sensibly", async () => {
    mockModel('{"order":[2,1]}');
    const out = await rankCandidates(person, company, candidates, { openrouterKey: "sk-x" });
    expect(out.map((c) => c.userId)).toEqual(["u-ann2", "u-ann"]);
  });

  it("falls back to the deterministic order when the model fails or is absent", async () => {
    mockModel(null);
    expect((await rankCandidates(person, company, candidates, { openrouterKey: "sk-x" })).map((c) => c.userId)).toEqual(["u-ann", "u-ann2"]);
    mockModel("not json at all");
    expect((await rankCandidates(person, company, candidates, { openrouterKey: "sk-x" })).map((c) => c.userId)).toEqual(["u-ann", "u-ann2"]);
    // no key configured ⇒ never calls out at all
    const spy = mockModel('{"order":[2,1]}');
    expect((await rankCandidates(person, company, candidates, {})).map((c) => c.userId)).toEqual(["u-ann", "u-ann2"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("cannot add, remove or re-score a candidate however wild the answer", async () => {
    mockModel('{"order":[99,7,1]}');
    const out = await rankCandidates(person, company, candidates, { openrouterKey: "sk-x" });
    expect(out.map((c) => c.userId).sort()).toEqual(["u-ann", "u-ann2"]);
    for (const c of out) expect(c.score).toBe(candidates.find((x) => x.userId === c.userId)!.score);
  });

  it("does not bother the model for a single candidate", async () => {
    const spy = mockModel('{"order":[1]}');
    expect(await rankCandidates(person, company, [candidates[0]!], { openrouterKey: "sk-x" })).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });
});
