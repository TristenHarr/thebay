/**
 * The deterministic query parser — search's floor.
 *
 * `POST /api/search` prefers an LLM to read a natural-language query, but the model
 * is allowed to be absent, slow, over budget, or wrong; when it is, THIS runs and
 * the user still gets a good answer. That is the house rule (`OpenRouterTagger` →
 * `KeywordTagger`, `summarize` → `fallbackSummary`) applied to search: the model
 * adds quality, never availability.
 *
 * It handles the things people actually type — `free`, `tonight`, `this weekend`,
 * `next week`, `near <place>`, and literal tag labels — subtracts every span it
 * understood, and hands the leftover text back as `semanticQuery` for the vector
 * retriever. Pure: no clock beyond the injected `now`, no I/O, no mutation.
 */
import { hash128 } from "../util/hash";
import { compileVocab, matchVocab, removeSpans, type CompiledVocab } from "./tag-match";
import { activeTags, MAX_QUERY_TAGS, type TagVocabEntry } from "./vocab";

export type SearchWindow = "tonight" | "today" | "weekend" | "7d" | "30d";
export type SearchIntent = "browse" | "find" | "meet";

export interface SearchFilters {
  /** Only free events. Undefined ⇒ don't care (never `false` — that would be a filter). */
  free?: boolean;
  /** `tag_vocab` ids. OR within a facet, AND across facets. */
  tags: string[];
  /** A neighborhood/city phrase, lowercased. Matched loosely against city/venue/address. */
  near?: string;
  window?: SearchWindow;
}

export interface ParsedQuery {
  filters: SearchFilters;
  /** The residual — what no filter explained. This is what gets embedded. */
  semanticQuery: string;
  intent: SearchIntent;
}

/** Case- and whitespace-insensitive form. Cache keys and hashes are built on this
 *  so "Free Hardware" and "  free   hardware " are one cache entry, not two. */
export function normalizeQuery(q: string): string {
  return (q ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Stable hash of the normalized query — the KV cache key for query understanding. */
export function queryHash(q: string): string {
  return hash128(normalizeQuery(q));
}

/** Most specific first: "tonight or next week" is a question about tonight. */
const WINDOW_PATTERNS: Array<[SearchWindow, RegExp]> = [
  ["tonight", /(?<![a-z0-9])tonight(?![a-z0-9])/g],
  ["today", /(?<![a-z0-9])today(?![a-z0-9])/g],
  ["weekend", /(?<![a-z0-9])(?:this |next |the )?weekend(?![a-z0-9])/g],
  ["7d", /(?<![a-z0-9])(?:next week|this week|coming week|next 7 days|in 7 days)(?![a-z0-9])/g],
  ["30d", /(?<![a-z0-9])(?:this month|next month|next 30 days|in 30 days)(?![a-z0-9])/g],
];

const FREE_RE = /(?<![a-z0-9])free(?![a-z0-9])/g;

/** Prepositions that introduce a place. "at" is deliberately excluded — it far more
 *  often introduces a time ("at 6pm") than a neighborhood. */
const PLACE_RE = /(?<![a-z0-9])(?:near|nearby|around|in|within)\s+([a-z][a-z0-9'’.-]*(?:\s+[a-z][a-z0-9'’.-]*){0,2})/g;

/** Words that can never END a place name. Trimmed off the right of a captured
 *  phrase so "in SoMa next week" yields "soma", not "soma next week". */
const PLACE_STOP = new Set([
  "next", "this", "last", "coming", "week", "weekend", "weeknight", "month", "year",
  "tonight", "today", "tomorrow", "morning", "afternoon", "evening", "night", "day", "days",
  "where", "when", "with", "who", "which", "that", "for", "and", "or", "to", "of", "on",
  "the", "a", "an", "by", "soon", "upcoming", "free", "cheap", "near", "around", "in", "events", "event",
]);
const PLACE_LEAD = new Set(["the", "a", "an"]);

const MEET_RE = /(?<![a-z0-9])(?:meet|meets|meeting|meetups?|network|networking|people|folks|peers|connect|mingle|hiring|recruit|recruiters?|community)(?![a-z0-9])/;

/** Cache the compiled vocabulary per array identity — parsing a query per keystroke
 *  must not recompile ~40 regexes each time. Keyed weakly so it can't leak. */
const compiledCache = new WeakMap<object, { terms: Set<string>; compiled: CompiledVocab }>();

function compile(vocab: readonly TagVocabEntry[]): { terms: Set<string>; compiled: CompiledVocab } {
  const key = vocab as unknown as object;
  const hit = compiledCache.get(key);
  if (hit) return hit;
  const terms = new Set<string>();
  for (const t of activeTags(vocab)) {
    for (const k of t.keywords ?? []) if (k) terms.add(k.toLowerCase());
    if (t.label) terms.add(t.label.toLowerCase());
  }
  const made = { terms, compiled: compileVocab(vocab) };
  compiledCache.set(key, made);
  return made;
}

/** Trim a captured phrase down to the part that can plausibly be a place name.
 *  Returns null when nothing survives (e.g. "in the next week"). */
function trimPlace(phrase: string, vocabTerms: Set<string>): string | null {
  let words = phrase.split(/\s+/).filter(Boolean);
  while (words.length && PLACE_LEAD.has(words[0]!)) words = words.slice(1);
  while (words.length) {
    const last = words[words.length - 1]!;
    if (PLACE_STOP.has(last) || vocabTerms.has(last)) words = words.slice(0, -1);
    else break;
  }
  const out = words.join(" ").replace(/[.,;:]+$/, "").trim();
  if (out.length < 2) return null;
  if (vocabTerms.has(out)) return null; // "interested in ai" is not a place
  return out;
}

/**
 * Parse a natural-language query with regexes and the live tag vocabulary.
 * Total: any string in, a valid `ParsedQuery` out.
 */
export function parseQuery(
  q: string,
  vocab: readonly TagVocabEntry[],
  _now: number = Date.now(),
): ParsedQuery {
  const text = normalizeQuery(q);
  const filters: SearchFilters = { tags: [] };
  const spans: Array<[number, number]> = [];
  if (!text) return { filters, semanticQuery: "", intent: "browse" };

  const { terms, compiled } = compile(vocab);

  // ── time window ───────────────────────────────────────────────────────────
  for (const [win, re] of WINDOW_PATTERNS) {
    re.lastIndex = 0;
    let matched = false;
    for (const m of text.matchAll(re)) {
      matched = true;
      spans.push([m.index, m.index + m[0].length]);
    }
    // Most specific wins, but every time phrase is still subtracted from the residual.
    if (matched && !filters.window) filters.window = win;
  }

  // ── price ─────────────────────────────────────────────────────────────────
  FREE_RE.lastIndex = 0;
  if (FREE_RE.test(text)) filters.free = true;

  // ── place ─────────────────────────────────────────────────────────────────
  const placeRe = new RegExp(PLACE_RE.source, "g");
  for (const m of text.matchAll(placeRe)) {
    const place = trimPlace(m[1] ?? "", terms);
    if (!place) continue;
    filters.near = place;
    spans.push([m.index, m.index + m[0].length]);
    break; // first plausible place wins
  }

  // ── literal tag matches (labels + keywords, word-bounded) ─────────────────
  const hits = matchVocab(text, compiled);
  filters.tags = hits.slice(0, MAX_QUERY_TAGS).map((h) => h.tagId);
  for (const h of hits) spans.push(...h.spans);

  const semanticQuery = removeSpans(text, spans).replace(/\s+/g, " ").trim();
  const intent: SearchIntent = MEET_RE.test(text) ? "meet" : "find";
  return { filters, semanticQuery, intent };
}
