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
import { harvestFormD, parseSecFilings, FORMD_BUDGET, type SecFilingRef } from "./formd";
import { CompaniesRepo } from "../../storage/d1/companies-repo";
import { AttributionRepo } from "../../storage/d1/attribution-repo";
import { fetchReddit } from "./reddit";
import { fetchResearch } from "./research";
import { fetchFda } from "./fda";
import { fetchArxiv } from "./arxiv";
import { fetchCrates } from "./crates";
import { workerFeeds, fetchFeeds, type FeedConfig } from "./rss";
import type { IngestedStory } from "./types";
import feedsJson from "../../../config/news-feeds.json";
import { summarizeStory } from "../summarize";
import { harvestPreview } from "./preview";

export interface IngestReport {
  fetched: number;
  created: number;
  merged: number;
  refreshed: number;
  /** How many feeds the deployed Worker actually has configured. Reported so a
   *  stale bundle is visible in the run output instead of being inferred. */
  feeds: number;
  events: number;
  previewed: number;
  summarized: number;
  /** Form D filings whose structured detail was mined this tick (Track E). */
  filings: number;
  /** Companies created from those filings. */
  companies: number;
  failures: string[];
  /** Configured feeds that returned 200 and yielded nothing. Silent rot. */
  emptyFeeds: string[];
}

/** How many stories get an AI summary per run — bounded so a cron tick stays cheap. */
const SUMMARY_BUDGET = 6;
/** How many link previews to harvest per run — bounded so we stay a polite crawler. */
const PREVIEW_BUDGET = 15;

export async function runNewsIngest(env: Env, fetchImpl: typeof fetch = fetch): Promise<IngestReport> {
  const repo = new NewsRepo(env.DB);
  const failures: string[] = [];
  /** Feeds that fetched fine and parsed to zero items — dead, but not loud about it. */
  const emptyFeeds: string[] = [];
  const all: IngestedStory[] = [];

  // Form D refs harvested as a side-effect of the SEC news query — same response,
  // no extra request. Mined for structured data after the story pass (see below).
  const formdRefs: SecFilingRef[] = [];

  const sources: [string, () => Promise<IngestedStory[]>][] = [
    ["hn", () => fetchHn(fetchImpl)],
    ["hn-tags", () => fetchHnTags(fetchImpl)],
    ["lobsters", () => fetchLobsters(fetchImpl)],
    ["github", () => fetchGithub(fetchImpl)],
    ["sec", () => fetchSec(fetchImpl, Date.now(), (form, payload) => {
      if (form === "D") formdRefs.push(...parseSecFilings(payload));
    })],
    ["reddit", () => fetchReddit(env, fetchImpl)],
    ["research", () => fetchResearch(fetchImpl)],
    ["fda", () => fetchFda(fetchImpl)],
    ["arxiv", () => fetchArxiv(fetchImpl)],
    ["crates", () => fetchCrates(fetchImpl)],
    ["rss", async () => {
      const { stories, reasons, empty } = await fetchFeeds(workerFeeds(feedsJson as FeedConfig[]), fetchImpl);
      for (const r of reasons) failures.push(`feed:${r}`);
      // Reported SEPARATELY from failures. A feed that answers 200 and parses to
      // nothing is broken, but it didn't error — folding it into `failures`
      // buried the things that did, which is how a failure list stops being read.
      emptyFeeds.push(...empty);
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

  // ── Form D detail (Track E) ────────────────────────────────────────────────
  // The news story is already stored above; this is the structured filing behind
  // it. Bounded at FORMD_BUDGET detail fetches per tick, and only for accessions
  // we have never seen — otherwise the budget would be spent re-reading the same
  // filings forever. One bad primary_doc.xml costs one filing (harvestFormD
  // returns null per filing), never the run.
  let filings = 0;
  let companies = 0;
  try {
    const companiesRepo = new CompaniesRepo(env.DB);
    const attribution = new AttributionRepo(env.DB);
    const fresh = new Set(await companiesRepo.unseenAccessions(formdRefs.map((r) => r.adsh)));
    const harvest = await harvestFormD(formdRefs.filter((r) => fresh.has(r.adsh)), fetchImpl, FORMD_BUDGET);
    for (const f of harvest.failures) failures.push(f);
    for (const filing of harvest.filings) {
      const stored = await companiesRepo.upsertFromFormD(filing);
      if (!stored) continue; // skip the bad item
      filings++;
      if (stored.companyCreated) companies++;
      // The filing is now public record, so any cause somebody had ALREADY claimed
      // for this round becomes SEC-corroborated. Bare correlations are untouched —
      // the ledger refuses that promotion.
      await attribution.corroborateSecRound(stored.roundId);
    }
    // Attach each filing's story to its company so the front page can render
    // "Acme Robotics — $4.2M" instead of a bare headline.
    if (filings > 0) await companiesRepo.linkStoriesByAccession();
  } catch (err) {
    failures.push(`formd: ${(err as Error).message}`);
  }

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

  return { fetched: all.length, feeds: (feedsJson as FeedConfig[]).length, emptyFeeds, created, merged, refreshed, events, previewed, summarized, filings, companies, failures };
}
