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

  // Kick one off immediately, then on the cron cadence.
  scrape();
  const job = new Cron(env.SCRAPE_CRON, scrape);
  logger.info(
    { cron: env.SCRAPE_CRON, next: job.nextRun()?.toISOString() },
    "watch: scheduled scraping + dashboard running",
  );
}
