/**
 * How strongly an edge is drawn — a fixed base per kind, decayed by how long ago it happened.
 *
 * The decay is the honest part. "You and Sam checked in at the same event" is a much weaker
 * statement about today if it happened three years ago, and a graph that draws a 2019
 * co-attendance as boldly as last Tuesday's is telling the viewer something false about
 * their own network. So recency is a multiplier, never a filter: the old edge stays visible
 * (it really happened) and simply fades.
 *
 * Deliberately NOT learned. A trained weight would make this a similarity score, which is
 * the thing `evidence.ts` exists to replace.
 */
import { orderPair, type GraphEdge } from "./types";
import { strongestTier } from "./evidence";

/** After this long, an edge is worth half what it was. Six months is roughly the horizon
 *  over which "we were in a room together" stops predicting anything about now. */
export const HALF_LIFE_DAYS = 180;

/** Nothing decays below this — an old fact is still a fact, and a zero-strength edge would
 *  be invisible, which is a different claim from "weak". */
export const MIN_STRENGTH = 0.12;

const DAY_MS = 86_400_000;

/**
 * Exponential decay on the edge's own timestamp.
 *
 * A null `at` means the source row carries no time (a friendship row's `created_at` exists,
 * but a `hosted` edge is about the event, not the moment of hosting). Timeless edges do not
 * decay — guessing a date to decay from would be inventing a fact.
 */
export function recencyFactor(at: string | null, nowMs: number = Date.now()): number {
  if (!at) return 1;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return 1;
  const ageDays = Math.max(0, (nowMs - t) / DAY_MS);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/** Base strength × recency, floored. Total: hostile inputs clamp rather than propagate. */
export function edgeStrength(base: number, at: string | null, nowMs: number = Date.now()): number {
  const b = Number.isFinite(base) ? Math.max(0, Math.min(1, base)) : 0;
  const decayed = b * recencyFactor(at, nowMs);
  return Math.max(MIN_STRENGTH * b, Math.min(1, decayed));
}

/**
 * Collapse duplicates into one edge per (a, b, kind), concatenating their evidence.
 *
 * Two rows can genuinely evidence the same relation — you RSVP'd *and* checked in, or a pair
 * is both friends and vouched. Those are different KINDS and stay separate edges. What this
 * merges is the same kind arriving twice (from a chunked query, or from both directions of an
 * undirected pair), which would otherwise draw two lines on top of each other and
 * double-count degree.
 *
 * Strength takes the MAX rather than the sum: two reasons don't make a relation stronger than
 * its best reason, and summing would let volume manufacture importance.
 */
export function mergeEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  const by = new Map<string, GraphEdge>();
  for (const e of edges) {
    const [a, b] = e.directed ? [e.a, e.b] : orderPair(e.a, e.b);
    const key = `${a}|${b}|${e.kind}`;
    const seen = by.get(key);
    if (!seen) {
      by.set(key, { ...e, a, b });
      continue;
    }
    seen.strength = Math.max(seen.strength, e.strength);
    for (const ev of e.evidence) {
      // Same source row twice is a chunking artefact, not a second reason.
      const dup = seen.evidence.some((x) => x.source.table === ev.source.table && JSON.stringify(x.source.keys) === JSON.stringify(ev.source.keys));
      if (!dup) seen.evidence.push(ev);
    }
  }
  return [...by.values()];
}

/** Degree per node, counting merged edges. Drives node radius in both views. */
export function degrees(edges: readonly GraphEdge[]): Map<string, number> {
  const d = new Map<string, number>();
  for (const e of edges) {
    d.set(e.a, (d.get(e.a) ?? 0) + 1);
    d.set(e.b, (d.get(e.b) ?? 0) + 1);
  }
  return d;
}

/**
 * Rank edges for truncation. Deterministic to the last tiebreak, because a graph that
 * returns a different 400 edges on every request is impossible to debug and makes the
 * `omitted` count meaningless.
 */
export function rankEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  return [...edges].sort((x, y) => {
    const t = (strongestTier(y.evidence.map((e) => e.tier)) ?? "inferred").localeCompare(strongestTier(x.evidence.map((e) => e.tier)) ?? "inferred");
    return y.strength - x.strength || t || (y.evidence[0]?.at ?? "").localeCompare(x.evidence[0]?.at ?? "") || `${x.a}|${x.b}`.localeCompare(`${y.a}|${y.b}`);
  });
}
