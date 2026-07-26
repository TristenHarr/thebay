/**
 * Ingestion orchestration — what the news cron runs every 15 minutes.
 *
 * This lives on the Worker, not the user's Mac. Unlike the events scraper (which
 * needs a residential IP and a browser for Eventbrite/Airtable), these are plain
 * JSON and XML fetches, so the news site stays current whether or not a laptop is
 * awake.
 *
 * Every source is isolated: one failing feed reduces the harvest, it never fails
 * the run. Aggregation etiquette is enforced here — we identify ourselves, link
 * to the original article, credit the source thread separately, and never copy
 * anyone's comment text.
 */
import type { Env } from "../../worker/env";
import { NewsRepo } from "../../storage/d1/news-repo";
import { fetchHn, fetchHnTags } from "./hn";
import { fetchLobsters } from "./lobsters";
import { fetchGithub } from "./github";
import { fetchSec } from "./sec";
import { fetchFeeds, type FeedConfig } from "./rss";
import type { IngestedStory } from "./types";
import feedsJson from "../../../config/news-feeds.json";
import { summarizeStory } from "../summarize";
import { harvestPreview } from "./preview";

export interface IngestReport {
  fetched: number;
  created: number;
  merged: number;
  refreshed: number;
  events: number;
  previewed: number;
  summarized: number;
  failures: string[];
}

/** How many stories get an AI summary per run — bounded so a cron tick stays cheap. */
const SUMMARY_BUDGET = 6;
/** How many link previews to harvest per run — bounded so we stay a polite crawler. */
const PREVIEW_BUDGET = 15;

export async function runNewsIngest(env: Env, fetchImpl: typeof fetch = fetch): Promise<IngestReport> {
  const repo = new NewsRepo(env.DB);
  const failures: string[] = [];
  const all: IngestedStory[] = [];

  const sources: [string, () => Promise<IngestedStory[]>][] = [
    ["hn", () => fetchHn(fetchImpl)],
    ["hn-tags", () => fetchHnTags(fetchImpl)],
    ["lobsters", () => fetchLobsters(fetchImpl)],
    ["github", () => fetchGithub(fetchImpl)],
    ["sec", () => fetchSec(fetchImpl)],
    ["rss", async () => {
      const { stories, failed } = await fetchFeeds(feedsJson as FeedConfig[], fetchImpl);
      for (const f of failed) failures.push(`feed:${f}`);
      return stories;
    }],
  ];

  for (const [name, run] of sources) {
    try {
      all.push(...(await run()));
    } catch (err) {
      failures.push(`${name}: ${(err as Error).message}`);
    }
  }

  const { created, merged, refreshed } = await repo.upsertIngested(all);

  let events = 0;
  try { events = await repo.syncEventStories(); }
  catch (err) { failures.push(`events: ${(err as Error).message}`); }

  // Harvest link previews BEFORE summarizing, so the summarizer can fall back to
  // a freshly-fetched description. Bounded per run to stay a polite crawler.
  let previewed = 0;
  try {
    for (const story of await repo.needingPreview(PREVIEW_BUDGET)) {
      if (!story.url) continue;
      const meta = await harvestPreview(story.url, fetchImpl);
      await repo.setPreview(story.id, meta); // stamped even when empty — no re-fetch loop
      if (meta.imageUrl || meta.description) previewed++;
    }
  } catch (err) {
    failures.push(`preview: ${(err as Error).message}`);
  }

  let summarized = 0;
  try {
    for (const story of await repo.needingSummary(SUMMARY_BUDGET)) {
      const result = await summarizeStory(env, story);
      if (result) { await repo.setSummary(story.id, result.summary, result.topics); summarized++; }
    }
  } catch (err) {
    failures.push(`summarize: ${(err as Error).message}`);
  }

  return { fetched: all.length, created, merged, refreshed, events, previewed, summarized, failures };
}
