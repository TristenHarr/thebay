import type { CanonicalEvent } from "../core/models/event";

export interface PushOptions {
  baseUrl: string; // e.g. http://localhost:8787 or https://thebay.events
  token: string; // INGEST_TOKEN (bearer)
  batchSize?: number;
}
export interface PushResult {
  batches: number;
  inserted: number;
  updated: number;
  failed: number;
}

/**
 * Push locally-scraped canonical events into the remote (D1-backed) Worker via
 * the authenticated ingest endpoint. Batched so a single request never carries
 * the whole dataset; one failed batch doesn't sink the rest. This is the bridge
 * that keeps scraping on a residential IP while the platform lives on Cloudflare.
 */
export async function pushEvents(events: CanonicalEvent[], opts: PushOptions): Promise<PushResult> {
  const size = Math.max(1, Math.min(opts.batchSize ?? 500, 5000));
  const url = opts.baseUrl.replace(/\/+$/, "") + "/api/admin/ingest";
  const out: PushResult = { batches: 0, inserted: 0, updated: 0, failed: 0 };

  for (let i = 0; i < events.length; i += size) {
    const chunk = events.slice(i, i + size);
    out.batches++;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
        body: JSON.stringify({ events: chunk }),
      });
      if (!res.ok) {
        out.failed += chunk.length;
        continue;
      }
      const j = (await res.json()) as { inserted?: number; updated?: number };
      out.inserted += j.inserted ?? 0;
      out.updated += j.updated ?? 0;
    } catch {
      out.failed += chunk.length;
    }
  }
  return out;
}
