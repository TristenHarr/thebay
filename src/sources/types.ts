import type { Page } from "playwright";
import type { RawEvent } from "../core/models/event";
import type { SourceConfig, CityDef } from "../core/models/source";
import type { Logger } from "../util/logger";

export interface BrowserPool {
  /** Run `fn` with a fresh page in an isolated context; context is closed after. */
  withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface AdapterContext {
  fetch: typeof fetch;
  browser: BrowserPool;
  logger: Logger;
  now: () => Date;
  secrets: Record<string, string>;
  /** Configured cities — adapters use these for geo params (e.g. Luma coords). */
  cities: CityDef[];
}

/**
 * Every source type implements this. Adding a source = registering one adapter.
 * `fetchEvents` should throw ONLY when the whole source is unreachable; partial
 * per-item failures should be skipped, not thrown, so one bad row can't sink a
 * source.
 */
export interface SourceAdapter<P = Record<string, unknown>> {
  readonly type: string;
  parseParams(raw: unknown): P;
  fetchEvents(cfg: SourceConfig<P>, ctx: AdapterContext): Promise<RawEvent[]>;
}
