import { parseArgs } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DATASF_SOURCES, mapRows, pickDataset, type CatalogResult, type DataSfSource, type PlaceImportItem, type SocrataRow } from "../core/places/datasf";

/**
 * `eventers import-places` — seed the crowd city map from DataSF so it isn't
 * empty on day one, then keep it current by re-running (the push is idempotent
 * on `external_ref`).
 *
 * Runs LOCALLY and pushes to production over the bearer-gated
 * `POST /api/admin/places-import`, exactly like the event scraper: the Worker
 * never has to reach out to a third-party API on a request path.
 *
 * Dataset ids are resolved through the Socrata catalog at runtime rather than
 * hardcoded — four-by-four ids change when a publisher re-publishes, and a stale
 * id 404s into a silent empty import. Per the house source convention, a bad row
 * is skipped and counted; only a source that is wholly unreachable throws, and
 * even then the other sources still run.
 */

const CATALOG = "https://api.us.socrata.com/api/catalog/v1";
const DOMAIN = "data.sfgov.org";
const UA = "thebay.events/1.0 (hello@thebay.events)";
const PAGE = 1000;

export interface HarvestOpts {
  fetchImpl?: typeof fetch;
  /** Max rows to pull per source. 0 = everything. */
  limit?: number;
  pageSize?: number;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noop = () => {};

async function getJson(url: string, f: typeof fetch): Promise<unknown> {
  const res = await f(url, { headers: { accept: "application/json", "user-agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/**
 * Ask the Socrata catalog which dataset this is today. Throws when the catalog
 * itself is unreachable (that IS the source being down); returns null when
 * nothing matches confidently, so we skip rather than import the wrong table.
 */
export async function resolveDataset(source: DataSfSource, opts: HarvestOpts = {}): Promise<{ id: string; name: string } | null> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${CATALOG}?domains=${DOMAIN}&search_context=${DOMAIN}&only=dataset&limit=8&q=${encodeURIComponent(source.query)}`;
  const body = (await getJson(url, f)) as { results?: CatalogResult[] };
  return pickDataset(body?.results, source.expectName);
}

/** Page through a resolved dataset, mapping as we go. */
export async function harvestSource(source: DataSfSource, datasetId: string, opts: HarvestOpts = {}): Promise<{ items: PlaceImportItem[]; skipped: number }> {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? noop;
  const pageSize = Math.min(PAGE, Math.max(1, opts.pageSize ?? PAGE));
  const cap = Math.max(0, opts.limit ?? 0);
  const items: PlaceImportItem[] = [];
  let skipped = 0;
  for (let offset = 0; ; offset += pageSize) {
    const want = cap ? Math.min(pageSize, cap - offset) : pageSize;
    if (want <= 0) break;
    const base = `https://${DOMAIN}/resource/${datasetId}.json?$limit=${want}&$offset=${offset}`;
    let rows: SocrataRow[];
    try {
      // `$order=:id` makes paging stable; some legacy datasets reject it.
      rows = (await getJson(`${base}&$order=:id`, f)) as SocrataRow[];
    } catch {
      rows = (await getJson(base, f)) as SocrataRow[];
    }
    if (!Array.isArray(rows) || !rows.length) break;
    const mapped = mapRows(source, rows);
    items.push(...mapped.items);
    skipped += mapped.skipped;
    log(`  ${source.key}: +${mapped.items.length} (skipped ${mapped.skipped}) — ${items.length} total`);
    if (rows.length < want) break;
    await sleep(200); // polite pacing for an unauthenticated Socrata client
  }
  return { items, skipped };
}

export interface HarvestReport {
  items: PlaceImportItem[];
  bySource: Record<string, { dataset: string | null; got: number; skipped: number; error?: string }>;
  failed: string[];
}

/** Resolve + harvest every configured source. One dead source never sinks the run. */
export async function harvestAll(opts: HarvestOpts = {}, sources: DataSfSource[] = DATASF_SOURCES): Promise<HarvestReport> {
  const log = opts.log ?? noop;
  const report: HarvestReport = { items: [], bySource: {}, failed: [] };
  const seen = new Set<string>();
  for (const source of sources) {
    try {
      const dataset = await resolveDataset(source, opts);
      if (!dataset) {
        report.bySource[source.key] = { dataset: null, got: 0, skipped: 0, error: "no confident catalog match" };
        report.failed.push(source.key);
        log(`! ${source.key}: no confident match in the DataSF catalog — skipped`);
        continue;
      }
      log(`→ ${source.key}: "${dataset.name}" (${dataset.id})`);
      const { items, skipped } = await harvestSource(source, dataset.id, opts);
      // external_ref is UNIQUE; de-dup here so one payload can't self-conflict.
      const fresh = items.filter((i) => !seen.has(i.externalRef) && (seen.add(i.externalRef), true));
      report.items.push(...fresh);
      report.bySource[source.key] = { dataset: dataset.id, got: fresh.length, skipped };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report.bySource[source.key] = { dataset: null, got: 0, skipped: 0, error: msg };
      report.failed.push(source.key);
      log(`! ${source.key}: unreachable (${msg}) — continuing with the other sources`);
    }
  }
  return report;
}

/** Push to the bearer-gated admin endpoint, chunked + retried. */
export async function pushPlaces(
  items: PlaceImportItem[],
  opts: { url: string; token: string; fetchImpl?: typeof fetch; chunk?: number; log?: (m: string) => void },
): Promise<{ inserted: number; updated: number; skipped: number; failedChunks: number }> {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? noop;
  const chunk = Math.min(5000, Math.max(1, opts.chunk ?? 500));
  const endpoint = opts.url.replace(/\/+$/, "") + "/api/admin/places-import";
  const total = { inserted: 0, updated: 0, skipped: 0, failedChunks: 0 };
  for (let i = 0; i < items.length; i += chunk) {
    const slice = items.slice(i, i + chunk);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const res = await f(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
          body: JSON.stringify({ places: slice }),
        });
        if (res.ok) {
          const j = (await res.json()) as { inserted?: number; updated?: number; skipped?: number };
          total.inserted += j.inserted ?? 0;
          total.updated += j.updated ?? 0;
          total.skipped += j.skipped ?? 0;
          ok = true;
        } else if (res.status === 401) {
          throw new Error("unauthorized — check INGEST_TOKEN");
        }
      } catch (e) {
        if (e instanceof Error && /unauthorized/.test(e.message)) throw e;
        await sleep(800 * (attempt + 1));
      }
    }
    if (!ok) total.failedChunks++;
    log(`  pushed ${Math.min(i + chunk, items.length)}/${items.length}`);
  }
  return total;
}

/** `eventers import-places [--url] [--token] [--limit n] [--source key]… [--dry-run] [--out file]` */
export async function importPlacesCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      limit: { type: "string" },
      source: { type: "string", multiple: true },
      out: { type: "string" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
  });
  const baseUrl = (values.url as string) || process.env.INGEST_URL || "http://localhost:8787";
  const token = (values.token as string) || process.env.INGEST_TOKEN || "";
  const limit = values.limit === undefined ? 5000 : Number(values.limit);
  const wanted = (values.source as string[] | undefined)?.map((s) => s.trim()).filter(Boolean);
  const sources = wanted?.length ? DATASF_SOURCES.filter((s) => wanted.includes(s.key)) : DATASF_SOURCES;
  if (!sources.length) {
    console.error(`Unknown --source. Available: ${DATASF_SOURCES.map((s) => s.key).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const log = (m: string) => console.log(m);
  console.log(`Resolving DataSF datasets via the Socrata catalog (limit ${limit || "all"} rows/source)…`);
  const report = await harvestAll({ limit: Number.isFinite(limit) ? limit : 5000, log }, sources);
  for (const [key, s] of Object.entries(report.bySource)) {
    console.log(`  ${key}: ${s.got} places${s.skipped ? ` (${s.skipped} rows skipped)` : ""}${s.error ? ` — ${s.error}` : ""}`);
  }
  console.log(`${report.items.length} places ready.`);

  if (values.out) {
    const file = resolve(process.cwd(), values.out as string);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ places: report.items }, null, 2));
    console.log(`Wrote ${file}`);
  }
  if (values["dry-run"]) return;
  if (!report.items.length) {
    // Every source failing is a real failure; a partial harvest is not.
    if (report.failed.length === sources.length) process.exitCode = 1;
    return;
  }
  if (!token) {
    console.log("No token — set --token / INGEST_TOKEN to push. (Use --dry-run --out to inspect first.)");
    return;
  }
  const pushed = await pushPlaces(report.items, { url: baseUrl, token, log });
  console.log(`Pushed → ${baseUrl}: ${pushed.inserted} new, ${pushed.updated} updated, ${pushed.skipped} skipped${pushed.failedChunks ? `, ${pushed.failedChunks} chunk(s) failed` : ""}.`);
  if (pushed.failedChunks) process.exitCode = 1;
}
