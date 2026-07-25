/**
 * Feed filtering. Pure, so the same rules run on the server and can be reasoned
 * about in tests — mirroring web/src/features/discover/filter.ts, which took the
 * same logic out of a component and made it testable.
 *
 * The product decision encoded here: `bay` (our own submissions + our events) is
 * the DEFAULT view. thebay.news is a Bay publication that also aggregates, not an
 * aggregator with a local section — so seeing HN and Lobsters is something the
 * reader opts into.
 */
import type { StoryOrigin } from "../../shared/schema";

/** Origins that count as "ours". */
export const LOCAL_ORIGINS: StoryOrigin[] = ["bay", "event"];

export interface Filterable {
  origin: StoryOrigin;
  topics?: string[] | null;
  dead?: number | boolean;
}

export interface NewsView {
  src: "bay" | "all" | StoryOrigin;
  topic?: string;
}

export function applyNewsFilter<T extends Filterable>(rows: readonly T[], view: NewsView): T[] {
  const topic = view.topic?.toLowerCase();
  return rows.filter((r) => {
    if (r.dead) return false; // moderation tombstones never render, in any view
    if (view.src === "bay") { if (!LOCAL_ORIGINS.includes(r.origin)) return false; }
    else if (view.src !== "all" && r.origin !== view.src) return false;
    if (topic && !(r.topics ?? []).some((t) => String(t).toLowerCase() === topic)) return false;
    return true;
  });
}
