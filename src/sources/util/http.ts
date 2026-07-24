import pRetry from "p-retry";

export const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface FetchOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  method?: string;
  body?: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Per-host politeness gate. Some hosts (Eventbrite) drop connections when hit
 * by several concurrent request streams — which happens when multiple sources
 * for the same site run in parallel. For hosts with a configured min-gap, all
 * requests (across every source) funnel through one serial chain with a delay
 * between them. Hosts not listed here (e.g. Luma) are untouched and stay fully
 * parallel.
 */
const HOST_MIN_GAP_MS: Record<string, number> = {
  "www.eventbrite.com": 900,
  "eventbrite.com": 900,
};
const hostChains = new Map<string, Promise<unknown>>();

function hostname(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

async function throughGate<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const gap = HOST_MIN_GAP_MS[hostname(url)];
  if (!gap) return fn();
  const host = hostname(url);
  const prev = hostChains.get(host) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run after the previous request, pass or fail
  // Release the gate `gap` ms after this request settles.
  hostChains.set(
    host,
    run.then(
      () => sleep(gap),
      () => sleep(gap),
    ),
  );
  return run;
}

/** fetch with a realistic UA, timeout, per-host throttle, and retry on 5xx / network errors. */
export async function httpFetch(url: string, opts: FetchOpts = {}): Promise<Response> {
  return throughGate(url, () =>
    pRetry(
      async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
        try {
          const res = await fetch(url, {
            method: opts.method ?? "GET",
            body: opts.body,
            redirect: "follow",
            headers: {
              "user-agent": DEFAULT_UA,
              "accept-language": "en-US,en;q=0.9",
              ...opts.headers,
            },
            signal: ctrl.signal,
          });
          // Rate limited: wait (honoring Retry-After) and let pRetry try again.
          if (res.status === 429) {
            const ra = Number(res.headers.get("retry-after"));
            await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : 5000);
            throw new Error(`HTTP 429 for ${url}`);
          }
          // Retry transient server errors; surface other 4xx to the caller.
          if (res.status >= 500) throw new Error(`HTTP ${res.status} for ${url}`);
          return res;
        } finally {
          clearTimeout(timer);
        }
      },
      { retries: opts.retries ?? 4, minTimeout: 1000, maxTimeout: 15_000 },
    ),
  );
}

export async function fetchText(url: string, opts?: FetchOpts): Promise<string> {
  const res = await httpFetch(url, opts ?? {});
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function fetchJson<T = unknown>(
  url: string,
  opts?: FetchOpts,
): Promise<T> {
  const res = await httpFetch(url, {
    ...opts,
    headers: { accept: "application/json", ...opts?.headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}
