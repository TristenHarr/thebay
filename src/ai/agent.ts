/**
 * AI networking agent (deterministic core).
 *
 * Ranks people the viewer should connect with, from a candidate pool (people at
 * their upcoming events + friends-of-friends). The agent proposes; in
 * "approve-each" mode the human confirms every action, in "auto" mode it may act
 * within guardrails. The ranking is deterministic and testable; a model can add
 * flavour text but not change who gets suggested.
 */
export interface AgentCandidate {
  id: string;
  displayName: string;
  handle: string;
  bio?: string | null;
  mutuals?: number;
  sharedEvents?: number;
}
export interface AgentInput {
  interests?: string[];
  goals?: string[];
  candidates: AgentCandidate[];
}
export interface AgentSuggestion {
  targetId: string;
  displayName: string;
  handle: string;
  action: "intro" | "connect";
  reason: string;
  score: number;
}

const STOP = new Set(["the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with", "my", "our", "raise", "find", "meet"]);
function keywords(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const w of (t || "").toLowerCase().match(/[a-z][a-z0-9+#-]{2,}/g) || []) if (!STOP.has(w)) out.add(w);
  return out;
}

export function suggestNetworkActions(input: AgentInput, limit = 5): AgentSuggestion[] {
  const wants = keywords([...(input.goals || []), ...(input.interests || [])]);
  const out: AgentSuggestion[] = [];
  for (const c of input.candidates) {
    const overlap = [...keywords([c.bio || ""])].filter((w) => wants.has(w));
    const mutuals = c.mutuals || 0;
    const shared = c.sharedEvents || 0;
    const score = overlap.length * 10 + mutuals * 8 + shared * 6;
    if (score <= 0) continue;
    const reasons: string[] = [];
    if (shared) reasons.push(`${shared} shared event${shared > 1 ? "s" : ""}`);
    if (mutuals) reasons.push(`${mutuals} mutual${mutuals > 1 ? "s" : ""}`);
    if (overlap.length) reasons.push(`both into ${overlap.slice(0, 2).join(", ")}`);
    out.push({
      targetId: c.id,
      displayName: c.displayName,
      handle: c.handle,
      // warm path (an intro through a mutual) when mutuals exist, else a direct connect
      action: mutuals > 0 ? "intro" : "connect",
      reason: reasons.join(" · "),
      score,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
