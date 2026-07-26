/**
 * Natural-language query understanding.
 *
 * "free hardware meetups in SoMa next week where I'll meet actual robotics people"
 * is one sentence carrying four filters and a semantic residual. A small model
 * reads it far better than regexes — so we ask one, with the LIVE tag vocabulary
 * injected into the prompt so it can only choose tags that exist today.
 *
 * Two hard rules, both enforced here rather than trusted to the model:
 *
 *  1. **The model may never invent a tag id.** Its output is intersected against
 *     `tag_vocab` (`intersectTags`) and unknown ids are dropped silently. An
 *     invented tag cannot reach a SQL clause, a facet count, or the UI.
 *  2. **The model may never be required.** No key, no budget, a timeout, malformed
 *     JSON — every one of those returns `null` from `completeJson`, and we answer
 *     from `parseQuery` instead. The model's output is *merged onto* the
 *     deterministic parse, never substituted for it, so understanding can only
 *     ever improve on the fallback.
 *
 * The pure parts (`buildMessages`, `mergeModelOutput`) are separated from the one
 * impure call so the prompt and the sanitisation are unit-testable without a network.
 */
import { z } from "zod";
import type { ChatMsg } from "../../ai/llm";
import { completeJson, type BudgetGuard, type KvLike, type ModelConfig } from "../../ai/json-llm";
import { normalizeQuery, parseQuery, type ParsedQuery, type SearchIntent, type SearchWindow } from "./parse";
import { intersectTags, vocabPromptLines, MAX_QUERY_TAGS, type TagVocabEntry } from "./vocab";

/** Query understanding must not add perceptible latency; 2.5s then we fall back. */
const UNDERSTAND_TIMEOUT_MS = 2_500;
const MAX_NEAR_LEN = 48;

export const WINDOWS = ["tonight", "today", "weekend", "7d", "30d"] as const;

/**
 * What we let the model say. Everything is optional and nullable because a cheap
 * model will omit or null fields at random, and `completeJson` returns null on a
 * schema miss — an over-strict schema here means silently always falling back.
 */
export const UnderstandSchema = z.object({
  tags: z.array(z.unknown()).max(40).optional().nullable(),
  free: z.boolean().optional().nullable(),
  near: z.string().max(120).optional().nullable(),
  window: z.enum(WINDOWS).optional().nullable(),
  semanticQuery: z.string().max(400).optional().nullable(),
  intent: z.enum(["browse", "find", "meet"]).optional().nullable(),
});
export type UnderstandOutput = z.infer<typeof UnderstandSchema>;

const SYSTEM = [
  "You turn a person's event-search sentence into structured filters for a San Francisco Bay Area events site.",
  "Reply with JSON only, matching exactly this shape:",
  '{"tags":["facet:slug"],"free":true|false|null,"near":"neighborhood or city or null","window":"tonight|today|weekend|7d|30d|null","semanticQuery":"the part of the query no filter captured","intent":"browse|find|meet"}',
  "",
  "Rules:",
  "- tags MUST be copied verbatim from the vocabulary below. Never invent an id. If nothing fits, use [].",
  "- free: true only when the person asked for free/no-cost events.",
  "- near: a place name only (neighborhood, city, district). Never a time, never a topic.",
  '- window: relative time only. "next week" and "this week" are both "7d"; a month is "30d".',
  "- semanticQuery: the leftover meaning a keyword filter cannot express (e.g. 'people actually building robots'). Empty string if nothing is left.",
  '- intent: "meet" when they want to meet people, "browse" for an aimless look, otherwise "find".',
].join("\n");

/** The exact messages we send. Pure, so the prompt is testable and the KV cache
 *  key (which hashes these messages) is stable for a given query + vocabulary. */
export function buildMessages(q: string, vocab: readonly TagVocabEntry[]): ChatMsg[] {
  return [
    { role: "system", content: `${SYSTEM}\n\nVOCABULARY (facet: id (label), …)\n${vocabPromptLines(vocab).join("\n")}` },
    { role: "user", content: normalizeQuery(q) },
  ];
}

function cleanNear(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // Letters, digits, spaces and the punctuation real place names use ("O'Farrell",
  // "Menlo-Park"). Everything else — including the `%` and `_` that would become
  // wildcards in the LIKE clause this feeds — is dropped, then each word is
  // stripped of leading/trailing punctuation so no token is pure noise.
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9 .'’-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, ""))
    .filter(Boolean)
    .join(" ");
  if (s.length < 2 || s.length > MAX_NEAR_LEN) return undefined;
  return s;
}

/**
 * Merge the model's reading onto the deterministic parse.
 *
 * The fallback is the FLOOR, never the ceiling: tags are unioned (so a tag the
 * regexes found survives a model that missed it), `free` is OR'd, and the model
 * only *wins* where it is genuinely better than a regex — the place name, the time
 * window, the residual and the intent. Pure.
 */
export function mergeModelOutput(
  out: UnderstandOutput | null,
  fallback: ParsedQuery,
  vocab: readonly TagVocabEntry[],
): ParsedQuery {
  if (!out) return fallback;
  const tags = [...new Set([...fallback.filters.tags, ...intersectTags(out.tags ?? [], vocab)])].slice(0, MAX_QUERY_TAGS);
  const near = cleanNear(out.near) ?? fallback.filters.near;
  const window = (out.window ?? undefined) as SearchWindow | undefined;
  const semantic = typeof out.semanticQuery === "string" ? out.semanticQuery.trim().toLowerCase() : "";
  return {
    filters: {
      ...fallback.filters,
      tags,
      free: out.free === true || fallback.filters.free === true ? true : undefined,
      ...(near ? { near } : {}),
      ...(window ?? fallback.filters.window ? { window: window ?? fallback.filters.window } : {}),
    },
    semanticQuery: semantic || fallback.semanticQuery,
    intent: ((out.intent ?? fallback.intent) as SearchIntent) ?? "find",
  };
}

export interface UnderstandOpts {
  model?: ModelConfig;
  /** KV response cache. Query phrasings repeat constantly — this is what makes
   *  per-search model cost round to zero. */
  cache?: KvLike | null;
  budget?: BudgetGuard | null;
  now?: number;
  timeoutMs?: number;
  refresh?: boolean;
}

export interface Understanding extends ParsedQuery {
  /** Which path produced this. Surfaced in the API response so a degraded search
   *  is observable instead of just quietly worse. */
  source: "llm" | "deterministic";
}

/**
 * Read a query. Always returns something usable — the model is an optimisation.
 */
export async function understandQuery(
  q: string,
  vocab: readonly TagVocabEntry[],
  opts: UnderstandOpts = {},
): Promise<Understanding> {
  const fallback = parseQuery(q, vocab, opts.now);
  const text = normalizeQuery(q);
  if (!text) return { ...fallback, source: "deterministic" };

  const cfg = opts.model ?? {};
  // No key and no Workers AI binding ⇒ don't even build a prompt.
  if (!cfg.openrouterKey && !cfg.env?.AI) return { ...fallback, source: "deterministic" };

  const out = await completeJson(buildMessages(text, vocab), cfg, {
    schema: UnderstandSchema,
    cache: opts.cache ?? null,
    budget: opts.budget ?? null,
    timeoutMs: opts.timeoutMs ?? UNDERSTAND_TIMEOUT_MS,
    maxTokens: 300,
    refresh: opts.refresh,
  }).catch(() => null);

  if (!out) return { ...fallback, source: "deterministic" };
  return { ...mergeModelOutput(out, fallback, vocab), source: "llm" };
}
