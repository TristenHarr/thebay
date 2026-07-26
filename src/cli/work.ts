import { parseArgs } from "node:util";
import { NetClient, runWorker, type LeaseFromServer } from "../net/client";
import { executeRecipe } from "../pipeline/execute";
import { createBrowserPool } from "../sources/util/browser";
import type { AdapterContext } from "../sources/types";
import { loadCities } from "../config/load";
import { env } from "../config/env";
import { logger } from "../util/logger";

/**
 * `eventers work` — contribute scraping to the network from this machine.
 *
 * This is the same job the author's Mac has always done, turned inside out. Instead of
 * reading `config/sources.json` off local disk and pushing finished events with the
 * all-powerful `INGEST_TOKEN`, it asks the coordinator what to look at, fetches it, and
 * ships RAW observations with a token scoped to `/api/net/*`. The coordinator decides how
 * fast, from whom, and whether anybody else agrees.
 *
 * The practical upshot: `scripts/daily-scrape.sh` becomes something anyone can run
 * (`bin/thebay-worker.mjs`, or `npm run work`), and the catalog stops depending on one laptop
 * being awake.
 *
 * Capabilities are `fetch` + `browser` because this client has Playwright — so the
 * coordinator routes the browser-hostile sources here rather than to a page in a tab.
 * `residential` is NOT claimed: the server derives that from the egress ASN, because a
 * claimed capability is just a request to be given the work that needs it.
 */
export async function workCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      once: { type: "boolean" },
      max: { type: "string" },
      poll: { type: "string" },
      quiet: { type: "boolean" },
    },
    allowPositionals: true,
  });

  const baseUrl = (values.url as string) || process.env.BAY_URL || process.env.INGEST_URL || "http://localhost:8787";
  const token = (values.token as string) || process.env.BAY_WORKER_TOKEN;
  if (!token) {
    console.error(
      "work needs a worker token: pass --token <t> or set BAY_WORKER_TOKEN.\n\n" +
        "To get one:\n" +
        "  1. join the network in person — meet a member and scan the moving code they show you\n" +
        "     (thebay.events/app/handshake)\n" +
        "  2. register this machine at thebay.events/app/contribute → Register this machine\n" +
        "  3. BAY_WORKER_TOKEN=<token> npm run work -- --url https://thebay.events",
    );
    process.exitCode = 1;
    return;
  }

  const cities = loadCities();
  const browser = createBrowserPool();
  const ctx: AdapterContext = {
    fetch,
    browser,
    logger,
    now: () => new Date(),
    secrets: { AIRTABLE_TOKEN: env.AIRTABLE_TOKEN, EVENTBRITE_TOKEN: env.EVENTBRITE_TOKEN },
    cities,
  };

  // The executor: the ONLY part that differs between this and the browser extension.
  // Note what it does not do — it does not normalise. Shipping raws is what keeps the
  // server the authority on which event a sighting belongs to.
  const execute = async (lease: LeaseFromServer) => {
    const { raws, malformed, durationMs } = await executeRecipe(
      { id: lease.sourceId, type: lease.recipe.type, params: lease.recipe.params },
      ctx,
    );
    if (malformed) logger.warn({ source: lease.sourceId, malformed }, "adapter produced items that failed validation");
    return {
      raws,
      // Weak evidence, honest bookkeeping: what we hit, and how long it took.
      receipts: [{ url: `https://${lease.recipe.host}/`, elapsedMs: durationMs }],
    };
  };

  const client = new NetClient({ baseUrl, token });
  const log = values.quiet ? () => {} : (m: string) => console.log(m);

  // Ctrl-C should finish the job in hand rather than abandon a lease mid-crawl.
  let running = true;
  const stop = () => {
    if (!running) return;
    running = false;
    console.log("\nfinishing the current job, then stopping…");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    log(`working for ${baseUrl} …`);
    const summary = await runWorker({
      client,
      execute,
      once: Boolean(values.once),
      max: values.max ? Number(values.max) : 3,
      pollMs: values.poll ? Number(values.poll) * 1000 : 60_000,
      onLog: log,
      shouldContinue: () => running,
    });
    log(
      `done: ${summary.submitted}/${summary.leased} jobs submitted, ${summary.items} events reported, ` +
        `${summary.published} published${summary.failed ? `, ${summary.failed} failed` : ""}` +
        (summary.tier ? ` (you are ${summary.tier})` : ""),
    );
    if (summary.failed && !summary.submitted) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}
