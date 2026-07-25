/**
 * The shape every aggregator normalizes into, so the merge path is identical
 * regardless of where a story came from.
 *
 * `externalUrl` is the DISCUSSION on the source site, kept separate from `url`
 * (the article). We send readers to the article and credit the source thread as
 * a distinct link — we never reproduce their comments.
 */
import type { StoryOrigin } from "../../../shared/schema";

export interface IngestedStory {
  origin: StoryOrigin;
  /** Stable id on the source, for idempotent re-ingest. */
  externalId: string;
  title: string;
  /** The article. Null for self-posts, which we then link to the source thread. */
  url: string | null;
  externalUrl: string | null;
  points: number | null;
  comments: number | null;
  createdAt: string;
  author: string | null;
  topics: string[];
}

/** Drop anything unusable rather than letting one bad row sink a whole feed. */
export function isUsable(s: Partial<IngestedStory>): s is IngestedStory {
  return !!(s.title && s.title.trim().length >= 3 && s.externalId && (s.url || s.externalUrl));
}
