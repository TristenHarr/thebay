import { logger } from "../util/logger";

const HELP = `
eventers — comprehensive tech-events scraper + dashboard

Usage:
  eventers <command> [options]

Commands:
  scrape [--source <id>]... [--no-tag] [--concurrency <n>]
                        Scrape enabled sources, dedupe, store, and tag.
  scrape-news [--url <u>] [--token <t>] [--dry-run]
                        Harvest sources that refuse Cloudflare's egress (OpenAlex)
                        from this residential IP and push them to thebay.news.
  serve                 Start the local web dashboard.
  watch                 Run the scheduler (cron) + dashboard together.
  tag                   (Re)tag events that need it (changed / untagged).
  export [--out <file>] [--include-hidden]
                        Dump ALL events to JSON (default data/events.json).
  bundle [--out <file>] [--site-url <url>]
                        Build a self-contained embeddable HTML widget (iframe-ready).
  migrate               Create/upgrade the SQLite schema and exit.
  help                  Show this help.

Env: copy .env.example to .env. AI is optional (OPENROUTER_API_KEY);
without it, a keyword tagger is used. Edit config/sources.json to add sources.
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "scrape":
      return (await import("./scrape")).scrapeCommand(rest);
    case "scrape-news":
      return (await import("./scrape-news")).scrapeNewsCommand(rest);
    case "serve":
      return (await import("./serve")).serveCommand();
    case "watch":
      return (await import("./watch")).watchCommand();
    case "tag":
      return (await import("./tag")).tagCommand();
    case "export":
      return (await import("./export")).exportCommand(rest);
    case "bundle":
      return (await import("./bundle")).bundleCommand(rest);
    case "build-site":
      return (await import("./build-site")).buildSiteCommand(rest);
    case "push":
      return (await import("./push")).pushCommand(rest);
    case "geocode":
      return (await import("./geocode")).geocodeCommand(rest);
    case "deploy":
      return (await import("./deploy")).deployCommand(rest);
    case "migrate": {
      const { createRepository } = await import("../storage");
      const repo = createRepository();
      repo.close();
      console.log("Database ready (schema migrated).");
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error({ err: err?.message ?? String(err) }, "command failed");
  process.exit(1);
});
