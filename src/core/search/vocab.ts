/**
 * The tag vocabulary — the shared language of search.
 *
 * Tags are `facet:slug` ids (`topic:hardware`, `format:demo-day`) stored in the
 * `tag_vocab` table, NOT bundled into the Worker. That's the point of A1: adding
 * a tag is a row, not a redeploy. Everything here is pure — the repo loads rows,
 * these helpers give them meaning.
 *
 * `intersectTags` is the security boundary for the LLM path. A model asked to pick
 * tags WILL occasionally invent `topic:quantum-biology`; every model-supplied tag
 * list must pass through here so an invented id can never reach a SQL clause, a
 * facet count, or the UI.
 */

/** The facets the seed ships with. Not a closed set — a row with a new facet just
 *  works — but these are what the prompt and the UI group by. */
export const FACETS = ["topic", "format", "audience", "stage", "cost", "perk"] as const;
export type Facet = (typeof FACETS)[number];

export type TagStatus = "active" | "proposed" | "retired";

export interface TagVocabEntry {
  /** `facet:slug`, e.g. `topic:hardware`. */
  id: string;
  facet: string;
  label: string;
  keywords: string[];
  emoji?: string | null;
  color?: string | null;
  /** Absent is treated as 'active' so hand-built fixtures stay terse. */
  status?: TagStatus;
}

/**
 * Where an assignment came from. Provenance is permanent: a keyword guess and a
 * host's own label look identical once written, so re-enrichment could not
 * otherwise know which rows it is allowed to throw away.
 */
export type TagSourceKind = "keyword" | "llm" | "host" | "crowd";

export interface TagAssignment {
  tagId: string;
  /** 0..1 — the CHECK on event_tags enforces the range. */
  confidence: number;
  source: TagSourceKind;
}

/** Hard cap on how many tags any one query may filter on. Bounds both the SQL
 *  (D1's 100-param ceiling) and the blast radius of a confused model. */
export const MAX_QUERY_TAGS = 12;

export function tagId(facet: string, slug: string): string {
  return `${facet}:${slug}`;
}

/** `topic:hardware` → `topic`. Returns "" for a malformed id (never throws). */
export function facetOf(id: string): string {
  const i = typeof id === "string" ? id.indexOf(":") : -1;
  return i > 0 ? id.slice(0, i) : "";
}

/** `topic:hardware` → `hardware`. Returns "" for a malformed id. */
export function slugOf(id: string): string {
  const i = typeof id === "string" ? id.indexOf(":") : -1;
  return i > 0 ? id.slice(i + 1) : "";
}

/** Only tags people may actually be shown or filtered by. */
export function activeTags(vocab: readonly TagVocabEntry[]): TagVocabEntry[] {
  return vocab.filter((t) => (t.status ?? "active") === "active");
}

/**
 * Filter an untrusted list of tag ids down to ids that really exist and are
 * active. Case-insensitive; de-duplicates; preserves the caller's order; tolerates
 * a bare slug when exactly one active tag owns it (unambiguous, so it's a lookup,
 * not a guess). Anything else is dropped silently — a search must degrade, not 400.
 */
export function intersectTags(
  candidate: unknown,
  vocab: readonly TagVocabEntry[],
  max: number = MAX_QUERY_TAGS,
): string[] {
  if (!Array.isArray(candidate)) return [];
  const active = activeTags(vocab);
  const byId = new Map<string, string>();
  const bySlug = new Map<string, string | null>(); // null ⇒ ambiguous, refuse to guess
  for (const t of active) {
    byId.set(t.id.toLowerCase(), t.id);
    const slug = slugOf(t.id).toLowerCase();
    if (!slug) continue;
    bySlug.set(slug, bySlug.has(slug) ? null : t.id);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidate) {
    if (typeof raw !== "string") continue;
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const hit = byId.get(key) ?? bySlug.get(key) ?? null;
    if (!hit || seen.has(hit)) continue;
    seen.add(hit);
    out.push(hit);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Group tag ids by facet. Search semantics are OR within a facet, AND across
 * facets — "hardware or software, AND free, AND a hackathon" is what people mean
 * when they tick boxes in two different columns.
 */
export function groupByFacet(tagIds: readonly string[]): Map<string, string[]> {
  const g = new Map<string, string[]>();
  for (const id of tagIds) {
    const f = facetOf(id);
    if (!f) continue;
    const bucket = g.get(f);
    if (bucket) bucket.push(id);
    else g.set(f, [id]);
  }
  return g;
}

/** Compact rendering of the live vocabulary for an LLM prompt. Ids first so the
 *  model copies them verbatim; labels give it the semantics. */
export function vocabPromptLines(vocab: readonly TagVocabEntry[], maxPerFacet = 40): string[] {
  const byFacet = new Map<string, TagVocabEntry[]>();
  for (const t of activeTags(vocab)) {
    const b = byFacet.get(t.facet);
    if (b) b.push(t);
    else byFacet.set(t.facet, [t]);
  }
  return [...byFacet.entries()].map(
    ([facet, tags]) => `${facet}: ${tags.slice(0, maxPerFacet).map((t) => `${t.id} (${t.label})`).join(", ")}`,
  );
}
