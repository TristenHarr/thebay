import pLimit from "p-limit";
import { getAdapter } from "../sources/registry";
import { createBrowserPool } from "../sources/util/browser";
import type { AdapterContext } from "../sources/types";
import { createNormalizer } from "../core/normalize/normalize";
import { looksOutOfRegion } from "../core/normalize/region";
import { UNKNOWN_CITY } from "../core/models/source";
import { dedupeWithinRun } from "../core/dedup";
import { RawEventSchema, type CanonicalEvent } from "../core/models/event";
import type { CategoryDef } from "../core/models/category";
import { loadSources, loadCities, loadCategories } from "../config/load";
import { createRepository, type Repository } from "../storage";
import { createTagger } from "../ai";
import { env } from "../config/env";
import { logger } from "../util/logger";

export interface ScrapeOptions {
  trigger?: "manual" | "schedule";
  sourceIds?: string[];
  concurrency?: number;
  tag?: boolean;
  repo?: Repository;
}

export interface ScrapeReport {
  runId: string;
  okSources: number;
  failedSources: number;
  selected: number;
  inserted: number;
  updated: number;
  tagged: number;
  total: number;
}

export async function tagPending(opts: {
  repo: Repository;
  categories?: CategoryDef[];
  batchLimit?: number;
  max?: number;
}): Promise<number> {
  const categories = opts.categories ?? loadCategories();
  const tagger = createTagger(categories, logger);
  const batchLimit = opts.batchLimit ?? 500;
  const max = opts.max ?? Number.POSITIVE_INFINITY;

  // Loop until nothing needs tagging (or we hit the cap). Tagged events set
  // tagged_hash = content_hash, so they drop out of the next fetch — no
  // infinite loop, and every event gets covered regardless of dataset size.
  let total = 0;
  for (;;) {
    if (total >= max) break;
    const pending = await opts.repo.eventsNeedingTags(
      Math.min(batchLimit, max - total),
    );
    if (!pending.length) break;

    const results = await tagger.tag(
      pending.map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        organizer: e.organizer,
      })),
    );
    await opts.repo.applyTags(
      results.map((r) => ({
        id: r.id,
        categories: r.categories,
        interestScore: r.interestScore,
        interestReason: r.reason,
        tagSource: tagger.name,
      })),
    );
    total += results.length;
    if (pending.length < batchLimit) break;
  }

  logger.info({ tagged: total, tagger: tagger.name }, "tagging complete");
  return total;
}

export async function runScrape(opts: ScrapeOptions = {}): Promise<ScrapeReport> {
  const trigger = opts.trigger ?? "manual";
  const repo = opts.repo ?? createRepository();
  const ownRepo = !opts.repo;

  const cities = loadCities();
  const categories = loadCategories();
  const allSources = loadSources();
  await repo.syncSources(allSources);

  const selected = allSources.filter(
    (s) =>
      s.enabled && (!opts.sourceIds?.length || opts.sourceIds.includes(s.id)),
  );

  const normalize = createNormalizer(cities);
  const browser = createBrowserPool();
  const ctx: AdapterContext = {
    fetch,
    browser,
    logger,
    now: () => new Date(),
    secrets: {
      AIRTABLE_TOKEN: env.AIRTABLE_TOKEN,
      EVENTBRITE_TOKEN: env.EVENTBRITE_TOKEN,
    },
    cities,
  };

  const runId = await repo.startRun(trigger);
  const limit = pLimit(opts.concurrency ?? 4);
  const collected: CanonicalEvent[] = [];
  let ok = 0;
  let failed = 0;

  await Promise.all(
    selected.map((src) =>
      limit(async () => {
        const started = Date.now();
        try {
          const adapter = getAdapter(src.type);
          const params = adapter.parseParams(src.params);
          const raws = await adapter.fetchEvents({ ...src, params }, ctx);

          let normalized = 0;
          for (const r of raws) {
            const parsed = RawEventSchema.safeParse(r);
            if (!parsed.success) continue;
            const canon = normalize(parsed.data, new Date());
            if (canon) {
              collected.push(canon);
              normalized++;
            }
          }
          ok++;
          await repo.recordSourceResult(runId, {
            sourceId: src.id,
            status: "ok",
            rawCount: raws.length,
            durationMs: Date.now() - started,
          });
          logger.info(
            { source: src.id, raw: raws.length, normalized },
            "source ok",
          );
        } catch (err) {
          failed++;
          const message = (err as Error)?.message ?? String(err);
          await repo.recordSourceResult(runId, {
            sourceId: src.id,
            status: "error",
            error: message,
            durationMs: Date.now() - started,
          });
          logger.error({ source: src.id, err: message }, "source failed");
        }
      }),
    ),
  );

  // Drop events we can confidently place outside the region (other US states /
  // countries) — location-search leakage. Precision-first, so ambiguous/online
  // events stay. Logged, never silent.
  const inRegion = collected.filter((e) => !(e.city === UNKNOWN_CITY && looksOutOfRegion(e.address)));
  const droppedOOR = collected.length - inRegion.length;
  if (droppedOOR) logger.info({ droppedOutOfRegion: droppedOOR }, "dropped out-of-region events");

  const deduped = dedupeWithinRun(inRegion);
  const { inserted, updated } = await repo.upsertEvents(deduped);
  logger.info(
    { inserted, updated, droppedOutOfRegion: droppedOOR, sources: `${ok}/${selected.length}` },
    "scrape stored",
  );

  let tagged = 0;
  if (opts.tag !== false) {
    tagged = await tagPending({ repo, categories });
  }

  await repo.finishRun(runId, {
    okSources: ok,
    failedSources: failed,
    eventsNew: inserted,
    eventsUpdated: updated,
  });
  await browser.close();

  const total = await repo.countEvents();
  if (ownRepo) repo.close();

  return {
    runId,
    okSources: ok,
    failedSources: failed,
    selected: selected.length,
    inserted,
    updated,
    tagged,
    total,
  };
}
