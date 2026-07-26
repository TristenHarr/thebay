/**
 * The one thing a model is allowed to do in identity resolution: reorder a
 * candidate list that deterministic code already produced.
 *
 * It is given names and signals, never emails or ids it could invent, and its
 * answer is passed through {@link applyRanking}, which drops anything that was
 * not already a candidate. `completeJson` returns null on any failure, so the
 * deterministic order is the always-available path — the model adds quality,
 * never availability, and it cannot add a person.
 *
 * IT STILL DOES NOT WRITE THE LINK. Ranking decides which question to ask first.
 * Only the person themselves answers it.
 */
import { z } from "zod";
import { completeJson, type KvLike } from "../../ai/json-llm";
import type { ChatMsg } from "../../ai/llm";
import { applyRanking, type Candidate, type CompanyRef, type PersonRef } from "./identity";

export const RankSchema = z.object({
  /** Candidate ORDINALS (1-based) from the prompt, best first. Never ids or names. */
  order: z.array(z.number().int().positive()).max(20),
});
export type RankResult = z.infer<typeof RankSchema>;

/**
 * The prompt. Candidates are referred to by ordinal so the model has no id to
 * hallucinate, and the instruction is explicitly "rank", never "decide".
 */
export function buildRankPrompt(person: PersonRef, company: CompanyRef, candidates: Candidate[]): ChatMsg[] {
  const lines = candidates.map((c, i) => `${i + 1}. ${c.displayName} — signals: ${c.signals.join(", ")}`).join("\n");
  return [
    {
      role: "system",
      content:
        "You rank possible identity matches. You do NOT decide them: a human confirms every match. " +
        'Reply with JSON only: {"order":[<1-based candidate numbers, most likely first>]}. ' +
        "Include every candidate exactly once. Invent nothing.",
    },
    {
      role: "user",
      content:
        `Filing: ${company.name}\nPerson on the filing: ${person.name} (${person.role})\n\nCandidates:\n${lines}\n\n` +
        "Which candidate is most likely the same person? Order them.",
    },
  ];
}

export interface RankConfig {
  openrouterKey?: string | null;
  model?: string | null;
  cache?: KvLike | null;
  dailyBudgetUsd?: number | null;
}

/**
 * Reordered candidates, or the deterministic order unchanged. Never throws, and
 * never returns a candidate that was not passed in.
 */
export async function rankCandidates(
  person: PersonRef,
  company: CompanyRef,
  candidates: Candidate[],
  cfg: RankConfig,
): Promise<Candidate[]> {
  if (candidates.length < 2 || !cfg.openrouterKey) return candidates;
  const result = await completeJson(buildRankPrompt(person, company, candidates), { openrouterKey: cfg.openrouterKey, model: cfg.model }, {
    schema: RankSchema,
    maxTokens: 120,
    cache: cfg.cache ?? null,
    budget: cfg.cache && cfg.dailyBudgetUsd ? { kv: cfg.cache, dailyUsd: cfg.dailyBudgetUsd } : null,
  }).catch(() => null);
  if (!result) return candidates;
  // Ordinals → ids, here rather than in the prompt, so an out-of-range number is
  // simply dropped instead of resolving to somebody.
  const ids = result.order.map((n) => candidates[n - 1]?.userId).filter((x): x is string => !!x);
  return applyRanking(candidates, ids);
}
