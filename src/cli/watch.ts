import { Cron } from "croner";
import { env } from "../config/env";
import { runScrape } from "../pipeline/pipeline";
import { startServer } from "../server/node-server";
import { createRepository } from "../storage";
import { logger } from "../util/logger";

export async function watchCommand(): Promise<void> {
  const repo = createRepository();

  await startServer({ repo });

  const scrape = () =>
    runScrape({ trigger: "schedule", repo }).catch((err) =>
      logger.error({ err: err?.message ?? String(err) }, "scheduled scrape failed"),
    );

  /**
   * Research rides along with the local schedule, because it CAN'T ride along
   * with the Worker's. OpenAlex rate-limits per IP and a Worker shares
   * Cloudflare's egress, so the scheduled handler gets a 429 every time while
   * this machine gets a 200 — the same reason the scrape itself lives here.
   * Without this it would only refresh when someone remembered to run it.
   *
   * Best-effort by design: a news failure must never take down event scraping,
   * which is the job this process actually exists to do.
   */
  const pushResearch = () => {
    if (!process.env.INGEST_TOKEN) return; // nothing to push with; stay quiet
    return import("./scrape-news")
      .then((m) => m.scrapeNewsCommand([]))
      .catch((err) => logger.warn({ err: err?.message ?? String(err) }, "research push failed"));
  };

  // Kick one off immediately, then on the cron cadence.
  scrape();
  pushResearch();
  const job = new Cron(env.SCRAPE_CRON, () => {
    scrape();
    pushResearch();
  });
  logger.info(
    { cron: env.SCRAPE_CRON, next: job.nextRun()?.toISOString() },
    "watch: scheduled scraping + dashboard running",
  );
}
