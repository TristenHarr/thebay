import type { CanonicalEvent } from "../core/models/event";
import type { Category } from "../core/models/category";
import type { SourceConfig } from "../core/models/source";

export interface EventFilter {
  from?: string;
  to?: string;
  cities?: string[];
  categories?: string[];
  sources?: string[];
  free?: boolean;
  minScore?: number;
  q?: string;
  starred?: boolean;
  includeHidden?: boolean;
  sort?: "start" | "score";
  limit?: number;
  offset?: number;
}

export interface FacetCount {
  value: string;
  count: number;
}
export interface EventFacets {
  cities: FacetCount[];
  categories: FacetCount[];
  sources: FacetCount[];
}
export interface EventQueryResult {
  events: CanonicalEvent[];
  total: number;
  facets: EventFacets;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
}

export interface TagInput {
  id: string;
  categories: Category[];
  interestScore: number;
  interestReason: string;
  tagSource: "ai" | "keyword";
}

export interface StoredSource {
  id: string;
  type: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
}

export interface SourceRunResult {
  sourceId: string;
  status: "ok" | "error";
  rawCount?: number;
  error?: string | null;
  durationMs?: number;
}

export interface RunSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: string;
  okSources: number;
  failedSources: number;
  eventsNew: number;
  eventsUpdated: number;
  sourceResults?: SourceRunResult[];
}

/**
 * Storage port. The async signatures make the SQLite implementation swappable
 * for a Cloudflare D1 implementation later with no call-site changes.
 */
export interface Repository {
  // events
  upsertEvents(events: CanonicalEvent[]): Promise<UpsertResult>;
  queryEvents(filter: EventFilter): Promise<EventQueryResult>;
  getEventById(id: string): Promise<CanonicalEvent | null>;
  setEventFlags(
    id: string,
    flags: { starred?: boolean; hidden?: boolean },
  ): Promise<CanonicalEvent | null>;
  eventsNeedingTags(limit?: number): Promise<CanonicalEvent[]>;
  applyTags(tags: TagInput[]): Promise<void>;
  countEvents(): Promise<number>;

  // sources
  syncSources(sources: SourceConfig[]): Promise<void>;
  listSources(): Promise<StoredSource[]>;

  // runs
  startRun(trigger: string): Promise<string>;
  recordSourceResult(runId: string, r: SourceRunResult): Promise<void>;
  finishRun(
    runId: string,
    counts: {
      okSources: number;
      failedSources: number;
      eventsNew: number;
      eventsUpdated: number;
    },
  ): Promise<void>;
  listRuns(limit?: number): Promise<RunSummary[]>;

  close(): void;
}
