/**
 * Harvest the sources the Worker can't reach, and push them.
 *
 * OpenAlex answers this machine with a 200 and the Worker with a 429 — the
 * limit is per-IP and a Worker shares Cloudflare's egress with everybody. So
 * research lives here, on the same residential connection that scrapes
 * Eventbrite, and posts its results to /api/admin/push-news.
 *
 *   npm run scrape-news -- --url https://thebay.news --token "$(cat .ingest-token)"
 *
 * Auth via --token or INGEST_TOKEN; target via --url or INGEST_URL.
 */
import { parseArgs } from "node:util";
import { fetchResearch } from "../news/ingest/research";
import { MAX_PUSH_BATCH } from "../news/ingest/push";

export async function scrapeNewsCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { url: { type: "string" }, token: { type: "string" }, "dry-run": { type: "boolean" } },
    allowPositionals: true,
  });

  const baseUrl = (values.url as string) || process.env.INGEST_URL || "https://thebay.news";
  const token = (values.token as string) || process.env.INGEST_TOKEN;

  console.log("Harvesting research (OpenAlex) locally …");
  const stories = await fetchResearch();
  console.log(`  ${stories.length} papers from Stanford, Berkeley and UCSF.`);
  if (!stories.length) {
    // Zero here means the query genuinely returned nothing — a 429 from a
    // residential IP would be a surprise worth seeing, so it throws rather than
    // being swallowed the way the Worker's scheduled path skips it.
    console.log("Nothing to push.");
    return;
  }

  if (values["dry-run"]) {
    for (const s of stories.slice(0, 10)) console.log(`  · ${s.title}`);
    return;
  }
  if (!token) {
    console.error("scrape-news needs a bearer token: pass --token <t> or set INGEST_TOKEN");
    process.exitCode = 1;
    return;
  }

  const url = baseUrl.replace(/\/+$/, "") + "/api/admin/push-news";
  let created = 0, merged = 0, failed = 0;
  for (let i = 0; i < stories.length; i += MAX_PUSH_BATCH) {
    const chunk = stories.slice(i, i + MAX_PUSH_BATCH);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ stories: chunk }),
      });
      if (!res.ok) {
        // Name the reason. A silent "failed: 10" is what made the last round of
        // ingestion bugs take an hour instead of a minute.
        console.error(`  batch rejected: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        failed += chunk.length;
        continue;
      }
      const j = (await res.json()) as { created?: number; merged?: number };
      created += j.created ?? 0;
      merged += j.merged ?? 0;
    } catch (err) {
      console.error(`  batch failed: ${(err as Error).message}`);
      failed += chunk.length;
    }
  }
  console.log(`Pushed to ${baseUrl}: ${created} new, ${merged} merged${failed ? `, ${failed} failed` : ""}.`);
}
