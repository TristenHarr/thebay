/**
 * Deterministic vocabulary matching — the keyword half of tagging and of query
 * parsing, over the LIVE `tag_vocab` rows rather than the bundled taxonomy.
 *
 * Matching is on WORD BOUNDARIES, never substrings. That rule is not cosmetic:
 * substring matching is what once tagged every "email" as AI and every "service"
 * as VC. Multi-word phrases ("open bar", "demo day") match as phrases.
 *
 * Pure: text in, hits + character spans out. The spans are what lets the query
 * parser subtract everything it understood and hand the *residual* to a semantic
 * retriever.
 */
import { activeTags, type TagVocabEntry } from "./vocab";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-token match, bounded by non-alphanumerics, so "ai" hits "AI dinner" but
 *  never "em[ai]l" — and "c++"/"k8s"/"series-a" still work. Global: we want spans. */
const boundedRe = (kw: string) =>
  new RegExp(`(?<![a-z0-9])${escapeRegExp(kw.toLowerCase())}(?![a-z0-9])`, "gi");

/** A label is usable as a matcher only when it reads as plain words — "Hardware"
 *  yes, "VC / Early-stage" no (its keywords cover it). */
const LABEL_OK = /^[a-z0-9][a-z0-9 &'’-]*$/i;

export interface CompiledTag {
  id: string;
  facet: string;
  /** Longest phrase first, so "open bar" wins over a hypothetical "bar". */
  matchers: RegExp[];
}
export type CompiledVocab = CompiledTag[];

export function compileVocab(vocab: readonly TagVocabEntry[]): CompiledVocab {
  return activeTags(vocab).map((t) => {
    const terms = new Set<string>();
    for (const k of t.keywords ?? []) {
      const s = (k ?? "").trim().toLowerCase();
      if (s) terms.add(s);
    }
    const label = (t.label ?? "").trim();
    if (label && LABEL_OK.test(label)) terms.add(label.toLowerCase());
    return {
      id: t.id,
      facet: t.facet,
      matchers: [...terms].sort((a, b) => b.length - a.length).map(boundedRe),
    };
  });
}

export interface VocabHit {
  tagId: string;
  facet: string;
  /** How many distinct terms of this tag fired — a crude but honest confidence. */
  hits: number;
  /** `[start, end)` character offsets in the searched text, ascending. */
  spans: Array<[number, number]>;
}

/**
 * Every vocabulary tag that fires against `text`, strongest first. Empty text or
 * an empty vocabulary yields [].
 */
export function matchVocab(text: string, compiled: CompiledVocab): VocabHit[] {
  const hay = (text ?? "").toLowerCase();
  if (!hay) return [];
  const out: VocabHit[] = [];
  for (const tag of compiled) {
    const spans: Array<[number, number]> = [];
    let hits = 0;
    for (const re of tag.matchers) {
      re.lastIndex = 0;
      let fired = false;
      for (const m of hay.matchAll(re)) {
        fired = true;
        spans.push([m.index, m.index + m[0].length]);
      }
      if (fired) hits++;
    }
    if (hits) {
      spans.sort((a, b) => a[0] - b[0]);
      out.push({ tagId: tag.id, facet: tag.facet, hits, spans });
    }
  }
  return out.sort((a, b) => b.hits - a.hits || a.tagId.localeCompare(b.tagId));
}

/** Confidence for a keyword-derived tag: one term is a decent signal, several is
 *  a strong one. Bounded to (0,1] so it satisfies the CHECK on event_tags. */
export function keywordConfidence(hits: number): number {
  return Math.min(0.95, 0.5 + 0.15 * Math.max(0, hits - 1));
}

/** Blank out the character ranges a matcher consumed. Used to build the semantic
 *  residual of a query: what the deterministic parser could NOT explain. */
export function removeSpans(text: string, spans: ReadonlyArray<readonly [number, number]>): string {
  if (!spans.length) return text;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (end <= cursor) continue;
    const s = Math.max(start, cursor);
    if (s > cursor) out += text.slice(cursor, s);
    out += " ";
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}
