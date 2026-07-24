import { parseArgs } from "node:util";
import { runScrape } from "../pipeline/pipeline";

export async function scrapeCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string", multiple: true },
      "no-tag": { type: "boolean" },
      concurrency: { type: "string" },
    },
    allowPositionals: true,
  });

  const report = await runScrape({
    trigger: "manual",
    sourceIds: (values.source as string[] | undefined) ?? undefined,
    tag: values["no-tag"] ? false : true,
    concurrency: values.concurrency ? Number(values.concurrency) : undefined,
  });

  console.log("\n── scrape complete ─────────────────────────");
  console.log(`  sources ok      : ${report.okSources}/${report.selected}`);
  console.log(`  sources failed  : ${report.failedSources}`);
  console.log(`  events inserted : ${report.inserted}`);
  console.log(`  events updated  : ${report.updated}`);
  console.log(`  events tagged   : ${report.tagged}`);
  console.log(`  total in db     : ${report.total}`);
  console.log("────────────────────────────────────────────\n");
}
