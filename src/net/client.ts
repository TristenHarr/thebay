/**
 * The scrape-network worker protocol, client side. Runtime-agnostic — `fetch` is injected
 * (the idiom every src/news/ingest adapter already uses), no Node APIs, no DOM — so the
 * identical code runs in the CLI, in a Chrome extension's service worker, and in a page
 * somebody leaves open.
 *
 * That sharing is the point. The protocol IS the product: three clients that each
 * re-implemented lease/submit/release would drift, and the one that drifted would look
 * like a bad actor rather than a bad build. What differs between clients is only the
 * `execute` callback — how they actually fetch a page — and that difference is exactly the
 * `capabilities` the coordinator routes on.
 *
 * Two properties this file is responsible for:
 *
 *   · **It never normalises.** It ships `RawEvent[]` and lets the server derive the
 *     fingerprint. A client that normalised would be choosing which existing event its
 *     data merges into, and no downstream validation could undo that.
 *   · **It hands work back.** A source that fails is released immediately, with the
 *     reason, so the coordinator can back the host off and re-offer the job instead of
 *     waiting out a ten-minute lease. Being a good citizen is cheaper than being polled.
 */
import type { RawEvent } from "../core/models/event";

export interface Politeness {
  host: string;
  minGapMs: number;
  disallow: string[];
}

export interface LeaseFromServer {
  leaseId: string;
  jobId: string;
  sourceId: string;
  recipeId: string;
  windowStart: string;
  expiresAt: string;
  recipe: { type: string; params: Record<string, unknown>; host: string };
  politeness: Politeness;
}

export interface Receipt {
  url: string;
  status?: number;
  bytes?: number;
  serverDate?: string;
  etag?: string;
  elapsedMs?: number;
}

export interface SubmitReport {
  ok: boolean;
  accepted: number;
  rejected?: number;
  consensus?: { confirmed: number; pending: number; contradicted: number };
  published?: number;
  standing?: { tier: string; trust: number; confirms: number; contradictions: number } | null;
}

export interface NetClientOpts {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/** Thin HTTP wrapper. Every call carries the worker token and nothing else — no cookies,
 *  because a worker is a machine and has no session. */
export class NetClient {
  private base: string;
  private fetchImpl: typeof fetch;

  constructor(private opts: NetClientOpts) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  lease(max = 3): Promise<{ ok: boolean; leases: LeaseFromServer[]; skipped: Array<{ host: string; reason: string }>; tier: string }> {
    return this.call("/api/net/lease", { max });
  }

  /** Ship what we saw. `items` are RAW adapter output — see the module doc. */
  submit(leaseId: string, items: RawEvent[] | unknown[], receipts: Receipt[] = []): Promise<SubmitReport> {
    return this.call("/api/net/submit", { leaseId, items, ...(receipts.length ? { receipts } : {}) });
  }

  release(leaseId: string, error?: string): Promise<{ ok: boolean }> {
    return this.call(`/api/net/lease/${encodeURIComponent(leaseId)}/release`, error ? { error } : {});
  }

  me(): Promise<{ member: unknown; clients: unknown[] }> {
    return this.call("/api/net/me");
  }
}

/** What a client's own fetching layer must provide. The only part that differs per client. */
export type Executor = (lease: LeaseFromServer) => Promise<{ raws: RawEvent[] | unknown[]; receipts?: Receipt[] }>;

export interface RunWorkerOpts {
  client: NetClient;
  execute: Executor;
  /** Do one round and return. The CLI's `--once`, and how tests stay fast. */
  once?: boolean;
  /** How long to wait between rounds when there was no work. */
  pollMs?: number;
  max?: number;
  sleep?: (ms: number) => Promise<void>;
  onLog?: (message: string) => void;
  /** Called before each round; return false to stop. The loop's off-switch. */
  shouldContinue?: () => boolean;
}

export interface WorkerSummary {
  leased: number;
  submitted: number;
  failed: number;
  items: number;
  published: number;
  /** True when the last round found nothing to do. */
  idle: boolean;
  tier?: string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The worker loop: ask for work, do it, report it, repeat.
 *
 * Politeness is applied twice on purpose. The coordinator already spaces lease GRANTS per
 * host, which is the guarantee that matters across the fleet; this loop additionally
 * spaces the jobs it holds *itself* for one host, so a client handed two Eventbrite jobs
 * in one batch doesn't run them concurrently. Belt and braces, and cheap.
 */
export async function runWorker(opts: RunWorkerOpts): Promise<WorkerSummary> {
  const sleep = opts.sleep ?? realSleep;
  const log = opts.onLog ?? (() => {});
  const summary: WorkerSummary = { leased: 0, submitted: 0, failed: 0, items: 0, published: 0, idle: false };
  const lastHostAt = new Map<string, number>();

  for (;;) {
    if (opts.shouldContinue && !opts.shouldContinue()) break;

    const { leases, skipped, tier } = await opts.client.lease(opts.max ?? 3);
    summary.tier = tier;
    if (!leases.length) {
      summary.idle = true;
      // Say why it was quiet. "Nothing to do" and "every host is blocked" look identical
      // from the outside, and only one of them is fine.
      if (skipped?.length) log(`no work: ${skipped.map((s) => `${s.host} (${s.reason})`).join(", ")}`);
      else log("no work available");
      if (opts.once) break;
      await sleep(opts.pollMs ?? 60_000);
      continue;
    }

    summary.idle = false;
    summary.leased += leases.length;

    for (const lease of leases) {
      // Respect this client's own spacing for repeat visits to one host.
      const since = Date.now() - (lastHostAt.get(lease.politeness.host) ?? 0);
      const gap = Math.max(0, lease.politeness.minGapMs ?? 0);
      if (lastHostAt.has(lease.politeness.host) && since < gap) await sleep(gap - since);
      lastHostAt.set(lease.politeness.host, Date.now());

      // A lease we can't finish in time is worth handing straight back: submitting against
      // an expired lease is refused anyway, so fetching first would waste the host's
      // bandwidth as well as ours.
      if (Date.parse(lease.expiresAt) <= Date.now()) {
        summary.failed++;
        log(`${lease.sourceId}: lease already expired, handing it back`);
        await opts.client.release(lease.leaseId, "expired before work started").catch(() => {});
        continue;
      }

      try {
        const { raws, receipts } = await opts.execute(lease);
        // An empty result is REPORTED, not dropped: "I looked and there was nothing" is
        // evidence the coordinator needs, and a silent client is indistinguishable from a
        // dead one.
        const report = await opts.client.submit(lease.leaseId, raws, receipts ?? []);
        summary.submitted++;
        summary.items += raws.length;
        summary.published += report.published ?? 0;
        log(
          `${lease.sourceId}: ${raws.length} found` +
            (report.consensus ? ` — ${report.consensus.confirmed} confirmed, ${report.consensus.pending} awaiting a second look` : "") +
            (report.published ? `, ${report.published} published` : ""),
        );
      } catch (err) {
        summary.failed++;
        const message = (err as Error)?.message ?? String(err);
        log(`${lease.sourceId}: failed — ${message}`);
        // Hand it back with the reason. One bad source is not a bad night: the loop
        // continues to the next lease.
        await opts.client.release(lease.leaseId, message).catch(() => {});
      }
    }

    if (opts.once) break;
    await sleep(opts.pollMs ?? 60_000);
  }

  return summary;
}
