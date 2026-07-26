/**
 * Query-string → `EventFilter`.
 *
 * Extracted from the Worker entry so route modules can accept the SAME filter grammar as
 * `/api/events` without importing from `index.ts` (which imports the route registry, so
 * that would be a cycle). One parser means the personalized feed can never drift from the
 * public catalog on what `?city=` or `?free=1` mean.
 */
import type { EventFilter } from "../storage/repository";

/** The default window: everything from six hours ago onward. The grace matches
 *  `byRecency` in `core/search/rank.ts` — an event that started an hour ago is still
 *  joinable, so it is still a result. */
export const PAST_GRACE_MS = 6 * 3600 * 1000;

export function parseFilter(q: Record<string, string>, nowMs: number = Date.now()): EventFilter {
  const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const num = (v?: string) => (v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  const truthy = (v?: string) => v === "1" || v === "true";
  let from = q.from;
  if (!from && !truthy(q.past)) from = new Date(nowMs - PAST_GRACE_MS).toISOString();
  return {
    from: from || undefined,
    to: q.to || undefined,
    cities: list(q.city),
    categories: list(q.category),
    sources: list(q.source),
    free: truthy(q.free) ? true : undefined,
    minScore: num(q.minScore),
    q: q.q || undefined,
    starred: truthy(q.starred) ? true : undefined,
    includeHidden: truthy(q.includeHidden),
    sort: q.sort === "score" ? "score" : "start",
    limit: num(q.limit),
    offset: num(q.offset),
  };
}
