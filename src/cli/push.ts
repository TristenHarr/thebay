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

    // Report the run to the remote so /api/scrape-status reflects this push — this
    // is how production knows it scraped, when, and how much. Non-fatal on failure.
    try {
      const last = (await repo.listRuns(1))[0];
      const res = await fetch(baseUrl.replace(/\/+$/, "") + "/api/admin/scrape-report", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          startedAt: last?.startedAt,
          finishedAt: last?.finishedAt ?? undefined,
          trigger: "scrape+push",
          eventsNew: r.inserted,
          eventsUpdated: r.updated,
          sources: (last?.sourceResults ?? []).map((s) => ({
            sourceId: s.sourceId,
            status: s.status,
            rawCount: s.rawCount,
            error: s.error ?? undefined,
            durationMs: s.durationMs,
          })),
        }),
      });
      console.log(res.ok ? `Reported run to ${baseUrl} (see /api/scrape-status).` : `Run report rejected (HTTP ${res.status}).`);
    } catch (e) {
      console.warn(`Run report failed (non-fatal): ${(e as Error).message}`);
    }

    if (r.failed) process.exitCode = 1;
  } finally {
    repo.close();
  }
}
