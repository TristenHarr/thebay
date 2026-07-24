import { parseArgs } from "node:util";
import { createRepository } from "../storage";
import { pushEvents } from "../pipeline/ingest-client";

/** `eventers push` — send locally-stored events to the live Worker's D1 via the
 *  ingest endpoint. Run after a scrape to publish. Auth via --token or INGEST_TOKEN. */
export async function pushCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      batch: { type: "string" },
      "include-hidden": { type: "boolean" },
    },
    allowPositionals: true,
  });

  const baseUrl = (values.url as string) || process.env.INGEST_URL || "http://localhost:8787";
  const token = (values.token as string) || process.env.INGEST_TOKEN;
  if (!token) {
    console.error("push needs a bearer token: pass --token <t> or set INGEST_TOKEN");
    process.exitCode = 1;
    return;
  }

  const repo = createRepository();
  try {
    const { events } = await repo.queryEvents({
      includeHidden: Boolean(values["include-hidden"]),
      limit: 100_000,
      sort: "start",
    });
    console.log(`Pushing ${events.length} events → ${baseUrl} …`);
    const r = await pushEvents(events, {
      baseUrl,
      token,
      batchSize: values.batch ? Number(values.batch) : 500,
    });
    console.log(
      `Done: ${r.inserted} inserted, ${r.updated} updated, ${r.failed} failed across ${r.batches} batch(es).`,
    );
    if (r.failed) process.exitCode = 1;
  } finally {
    repo.close();
  }
}
