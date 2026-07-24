import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRepository } from "../storage";

/** Dump all events (including past + hidden) to a JSON file. */
export async function exportCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: "string" }, "include-hidden": { type: "boolean" } },
    allowPositionals: true,
  });
  const out = resolve(process.cwd(), (values.out as string) || "data/events.json");

  const repo = createRepository();
  try {
    const { events, total } = await repo.queryEvents({
      includeHidden: values["include-hidden"] ? true : false,
      limit: 100_000,
      sort: "start",
      // no `from` → all events, past and future
    });
    mkdirSync(dirname(out), { recursive: true });
    const payload = {
      generatedAt: new Date().toISOString(),
      count: events.length,
      total,
      events,
    };
    writeFileSync(out, JSON.stringify(payload, null, 2));
    console.log(`Exported ${events.length} events to ${out}`);
  } finally {
    repo.close();
  }
}
