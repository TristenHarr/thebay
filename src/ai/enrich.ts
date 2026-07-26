/**
 * Bounded event enrichment — tags and embeddings.
 *
 * This is what replaces `D1Repo.retagAll`, which did `SELECT *` over the whole
 * events table into Worker memory and then wrote every row back. That works at
 * 5,000 events and dies at 50,000, in production, with no partial progress. Here
 * the caller supplies a bounded slice (SearchRepo walks an id cursor) and every
 * stage degrades independently:
 *
 *   - **Tags.** A model reads the whole facet space (format/audience/stage/perk),
 *     which keywords genuinely cannot. It is intersected against `tag_vocab` so it
 *     cannot invent a tag, and if it returns nothing usable the deterministic
 *     keyword pass — the existing, tested `KeywordTagger` plus word-boundary
 *     matching over the live vocabulary — is the answer. The model is never
 *     required.
 *   - **Cost.** Derived from `is_free`/`price_text`, not from words. "free food" in
 *     a description must not make a $40 conference free.
 *   - **Embeddings.** Workers AI + Vectorize, both optional bindings. Absent ⇒
 *     skipped, and search still runs on FTS5 + keyword.
 */
import { CATCH_ALL_CATEGORY, type CategoryDef } from "../core/models/category";
import { KeywordTagger } from "./keyword-tagger";
import { completeJson, type BudgetGuard, type KvLike, type ModelConfig } from "./json-llm";
import { z } from "zod";
import { compileVocab, keywordConfidence, matchVocab, type CompiledVocab } from "../core/search/tag-match";
import { activeTags, intersectTags, slugOf, tagId, vocabPromptLines, type TagAssignment, type TagVocabEntry } from "../core/search/vocab";

/** Workers AI text-embedding model. 768 dimensions — the Vectorize index must
 *  match (`wrangler vectorize create events-v1 --dimensions=768 --metric=cosine`). */
export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBED_DIMS = 768;

/** How many events go in one tagging prompt. Small enough that one bad event can't
 *  poison a big batch, big enough that the per-call overhead amortises. */
export const LLM_BATCH = 8;

/** The bindings this module can use, structurally typed — `@cloudflare/workers-types`
 *  is not ambient here (tsconfig `types: ["node"]`), and both bindings are optional. */
export interface EnrichEnv {
  AI?: { run(model: string, input: unknown): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  VECTORIZE?: {
    query(
      vector: number[],
      opts?: { topK?: number; filter?: Record<string, unknown>; returnMetadata?: boolean | string },
    ): Promise<{ matches: Array<{ id: string; score: number; metadata?: Record<string, unknown> }> }>;
    upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>): Promise<unknown>;
    deleteByIds(ids: string[]): Promise<unknown>;
  };
}

export interface EnrichEvent {
  id: string;
  title: string;
  description: string | null;
  organizer: string | null;
  venueName: string | null;
  city: string;
  startUtc: string;
  isFree: boolean | null;
  priceText: string | null;
  contentHash: string;
}

export interface EnrichedEvent {
  id: string;
  tags: TagAssignment[];
  /** The legacy `events.categories` value (topic slugs) — write-through fodder. */
  categories: string[];
  interestScore: number;
  interestReason: string;
  tagSource: "ai" | "keyword";
  contentHash: string;
}

// ── deterministic core ───────────────────────────────────────────────────────

/** Reconstruct the `CategoryDef[]` the existing tagger expects from the topic
 *  facet of the live vocabulary. The interest score stays byte-identical to what
 *  the pipeline already produces — this track changes the tag model, not scoring. */
export function topicCategoryDefs(vocab: readonly TagVocabEntry[]): CategoryDef[] {
  return activeTags(vocab)
    .filter((t) => t.facet === "topic")
    .map((t) => ({ id: slugOf(t.id), label: t.label, color: t.color ?? "#8d99ae", keywords: t.keywords ?? [] }));
}

const searchableText = (e: EnrichEvent) =>
  [e.title, e.description, e.organizer, e.venueName].filter(Boolean).join(" ");

/**
 * Cost tags from DATA, not from words. `is_free` and `price_text` are facts the
 * scraper captured; a description saying "free food" is not.
 */
export function costTags(isFree: boolean | null, priceText: string | null): TagAssignment[] {
  const price = firstPrice(priceText);
  if (isFree === true || price === 0) return [{ tagId: "cost:free", confidence: 1, source: "keyword" }];
  const out: TagAssignment[] = [];
  if (price != null) {
    out.push({ tagId: "cost:paid", confidence: 1, source: "keyword" });
    if (price < 25) out.push({ tagId: "cost:under-25", confidence: 0.9, source: "keyword" });
  } else if (isFree === false) {
    out.push({ tagId: "cost:paid", confidence: 0.8, source: "keyword" });
  }
  return out;
}

function firstPrice(priceText: string | null): number | null {
  if (!priceText) return null;
  if (/(?<![a-z0-9])free(?![a-z0-9])/i.test(priceText)) return 0;
  const m = /\$\s?(\d+(?:\.\d{1,2})?)/.exec(priceText);
  return m ? Number(m[1]) : null;
}

/**
 * The full deterministic read of one event: keyword tags across every facet,
 * data-derived cost tags, a guaranteed topic, and the existing interest score.
 * Pure apart from `KeywordTagger`, which is itself pure.
 */
export function enrichOneDeterministic(
  e: EnrichEvent,
  compiled: CompiledVocab,
  score: { interestScore: number; reason: string },
): EnrichedEvent {
  const hits = matchVocab(searchableText(e), compiled);
  const tags: TagAssignment[] = hits
    // Cost is decided by is_free/price_text below; keyword hits on "free" are noise.
    .filter((h) => h.facet !== "cost")
    .map((h) => ({ tagId: h.tagId, confidence: keywordConfidence(h.hits), source: "keyword" as const }));
  tags.push(...costTags(e.isFree, e.priceText));

  // Every event gets a topic, exactly as the legacy tagger guaranteed — otherwise
  // the write-through would blank events.categories and break the dashboard.
  if (!tags.some((t) => t.tagId.startsWith("topic:"))) {
    tags.push({ tagId: tagId("topic", CATCH_ALL_CATEGORY), confidence: 0.3, source: "keyword" });
  }
  // The cost ids and the catch-all topic are written literally, so an operator who
  // retires or deletes one of those rows would otherwise turn every enrich batch
  // into an FK violation. Drop anything the vocabulary no longer contains.
  const known = new Set(compiled.map((c) => c.id));
  const valid = tags.filter((t) => known.has(t.tagId));
  return {
    id: e.id,
    tags: valid,
    categories: topicSlugs(valid),
    interestScore: score.interestScore,
    interestReason: score.reason,
    tagSource: "keyword",
    contentHash: e.contentHash,
  };
}

function topicSlugs(tags: TagAssignment[]): string[] {
  return [...new Set(tags.filter((t) => t.tagId.startsWith("topic:")).map((t) => slugOf(t.tagId)))];
}

/** Deterministic enrichment for a batch. This is the floor every other path
 *  falls back to, so it must never fail. */
export async function enrichDeterministic(
  events: EnrichEvent[],
  vocab: readonly TagVocabEntry[],
): Promise<EnrichedEvent[]> {
  if (!events.length) return [];
  const compiled = compileVocab(vocab);
  const tagger = new KeywordTagger(topicCategoryDefs(vocab));
  const scored = await tagger.tag(
    events.map((e) => ({ id: e.id, title: e.title, description: e.description, organizer: e.organizer })),
  );
  const byId = new Map(scored.map((s) => [s.id, s]));
  return events.map((e) => {
    const s = byId.get(e.id);
    return enrichOneDeterministic(e, compiled, {
      interestScore: s?.interestScore ?? 10,
      reason: s?.reason ?? "no strong keyword signal",
    });
  });
}

// ── the model pass ───────────────────────────────────────────────────────────

export const LlmTagsSchema = z.object({
  events: z
    .array(z.object({ id: z.string(), tags: z.array(z.unknown()).max(20) }))
    .max(LLM_BATCH * 2),
});

const TAG_SYSTEM = [
  "You label San Francisco Bay Area tech events with tags from a fixed vocabulary.",
  'Reply with JSON only: {"events":[{"id":"<the event id>","tags":["facet:slug", ...]}]}',
  "",
  "Rules:",
  "- Every tag MUST be copied verbatim from the vocabulary. Never invent an id.",
  "- Prefer precision: 2-6 tags per event. Use [] if you are unsure.",
  "- Do not guess the cost facet; it is derived from ticket data, not from wording.",
  "- Include one id from the format facet when the format is clear, and audience/stage/perk when the copy states it.",
].join("\n");

/** Pure: the exact prompt for a batch. Exported so the shape is testable offline. */
export function buildTagMessages(events: EnrichEvent[], vocab: readonly TagVocabEntry[]) {
  const body = events
    .map((e) =>
      [
        `id: ${e.id}`,
        `title: ${e.title}`,
        e.organizer ? `organizer: ${e.organizer}` : null,
        e.venueName ? `venue: ${e.venueName}` : null,
        e.description ? `description: ${e.description.slice(0, 600)}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n---\n");
  return [
    { role: "system" as const, content: `${TAG_SYSTEM}\n\nVOCABULARY (facet: id (label), …)\n${vocabPromptLines(vocab).join("\n")}` },
    { role: "user" as const, content: body },
  ];
}

export interface EnrichOpts {
  model?: ModelConfig;
  cache?: KvLike | null;
  budget?: BudgetGuard | null;
  /** Set false to force the deterministic path (used by tests and by `?llm=0`). */
  useLlm?: boolean;
  timeoutMs?: number;
  refresh?: boolean;
}

/**
 * Enrich a bounded batch. Deterministic first, then the model layered on top —
 * so the result is never worse than the keyword pass, whatever the model does.
 */
export async function enrichEvents(
  events: EnrichEvent[],
  vocab: readonly TagVocabEntry[],
  opts: EnrichOpts = {},
): Promise<EnrichedEvent[]> {
  const base = await enrichDeterministic(events, vocab);
  const cfg = opts.model ?? {};
  const canModel = opts.useLlm !== false && (!!cfg.openrouterKey || !!cfg.env?.AI);
  if (!canModel || !base.length) return base;

  const byId = new Map(base.map((b) => [b.id, b]));
  for (let i = 0; i < events.length; i += LLM_BATCH) {
    const slice = events.slice(i, i + LLM_BATCH);
    const out = await completeJson(buildTagMessages(slice, vocab), cfg, {
      schema: LlmTagsSchema,
      cache: opts.cache ?? null,
      budget: opts.budget ?? null,
      timeoutMs: opts.timeoutMs ?? 12_000,
      maxTokens: 600,
      refresh: opts.refresh,
    }).catch(() => null);
    if (!out) continue; // this slice stays deterministic; the rest still gets a try

    for (const row of out.events) {
      const target = byId.get(row.id);
      if (!target) continue; // the model echoed an id we never sent
      const extra = intersectTags(row.tags, vocab, 12)
        // Cost is data-derived; the model is not allowed a vote.
        .filter((id) => !id.startsWith("cost:"))
        .filter((id) => !target.tags.some((t) => t.tagId === id));
      if (!extra.length) continue;
      target.tags = [...target.tags, ...extra.map((id) => ({ tagId: id, confidence: 0.7, source: "llm" as const }))];
      target.categories = topicSlugs(target.tags);
      target.tagSource = "ai";
    }
  }
  return [...byId.values()];
}

// ── embeddings (optional path) ───────────────────────────────────────────────

/** What actually gets embedded. Title first (it carries the most signal), then the
 *  human context; bounded so one enormous description can't dominate a batch. */
export function embedText(e: EnrichEvent): string {
  return [e.title, e.organizer, e.venueName, e.city, (e.description ?? "").slice(0, 1200)]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2000);
}

/** Embed strings via Workers AI. Returns [] when the binding is absent or the call
 *  fails — the caller must treat embeddings as optional. */
export async function embed(texts: string[], env: EnrichEnv): Promise<number[][]> {
  if (!env.AI || !texts.length) return [];
  try {
    const r = await env.AI.run(EMBED_MODEL, { text: texts });
    const data = r?.data;
    if (!Array.isArray(data)) return [];
    return data
      .filter((v: unknown): v is number[] => Array.isArray(v) && v.length === EMBED_DIMS)
      .map((v: number[]) => v);
  } catch {
    return [];
  }
}

/**
 * Embed a batch of events and upsert them into Vectorize. Returns the ids that
 * were successfully stored, so the caller only advances `embedded_hash` for those.
 * A missing VECTORIZE binding (the default — the index is commented out in
 * wrangler.jsonc until it's created) makes this a clean no-op.
 */
export async function embedAndUpsert(
  events: EnrichEvent[],
  env: EnrichEnv,
): Promise<Array<{ id: string; hash: string }>> {
  if (!env.VECTORIZE || !env.AI || !events.length) return [];
  const vectors = await embed(events.map(embedText), env);
  if (vectors.length !== events.length) return [];
  try {
    await env.VECTORIZE.upsert(
      events.map((e, i) => ({
        id: e.id,
        values: vectors[i]!,
        // Metadata mirrors the columns search filters on, so a future
        // metadata-filtered vector query needs no extra plumbing.
        metadata: { startUtc: e.startUtc, city: e.city, free: e.isFree === true },
      })),
    );
  } catch {
    return [];
  }
  return events.map((e) => ({ id: e.id, hash: e.contentHash }));
}

/**
 * Semantic candidates for a query, best first. Returns [] whenever the vector path
 * is unavailable — which is the normal case today — so search falls back to FTS5
 * with no branching at the call site.
 *
 * Deliberately unfiltered: metadata filters require Vectorize metadata indexes
 * that may not exist, and the ids are intersected with the SQL candidate pool
 * anyway, so filtering here would only cost recall.
 */
export async function vectorCandidates(
  text: string,
  env: EnrichEnv,
  opts: { topK?: number } = {},
): Promise<string[]> {
  if (!env.VECTORIZE || !env.AI || !text.trim()) return [];
  const [vector] = await embed([text], env);
  if (!vector) return [];
  try {
    const res = await env.VECTORIZE.query(vector, { topK: Math.min(Math.max(opts.topK ?? 50, 1), 100) });
    return (res?.matches ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}
