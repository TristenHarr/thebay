/**
 * The extension's service worker: the worker loop, in a browser.
 *
 * It is deliberately thin. The protocol, the loop, the politeness and the failure handling
 * are all `src/net/client.ts` — the same code the CLI runs — and the only thing here is
 * Chrome-specific plumbing: where the token lives, how a page gets opened, and a
 * `chrome.alarms` heartbeat, because a service worker is evicted after ~30 seconds idle and
 * `setInterval` does not survive that.
 *
 * Consent is explicit and revocable: nothing runs until the user presses Start, and the
 * enabled flag is the first thing every wake-up checks.
 */
import { NetClient, runWorker } from "../../src/net/client";
import { makeExecutor, type PageHarvest } from "./executor";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any;

const ALARM = "bay-work";
const HARVEST_TIMEOUT_MS = 25_000;

interface Settings {
  baseUrl: string;
  token: string;
  enabled: boolean;
}
interface Stats {
  jobs: number;
  found: number;
  published: number;
  tier: string;
  status: string;
  at: number;
}

const store = {
  async get(): Promise<Settings & { stats: Stats }> {
    const d = await chrome.storage.local.get(["baseUrl", "token", "enabled", "stats"]);
    return {
      baseUrl: d.baseUrl || "https://thebay.events",
      token: d.token || "",
      enabled: !!d.enabled,
      stats: d.stats || { jobs: 0, found: 0, published: 0, tier: "—", status: "Idle.", at: 0 },
    };
  },
  async patchStats(patch: Partial<Stats>) {
    const { stats } = await store.get();
    await chrome.storage.local.set({ stats: { ...stats, ...patch, at: Date.now() } });
  },
};

/**
 * Open a page in a background tab, read the data blocks a scraper cares about, close it.
 *
 * `active: false` keeps the user's browsing theirs. The read happens in the page's own
 * world via `chrome.scripting.executeScript`, using native DOM APIs — no cheerio, no
 * regex-over-HTML, and no reliance on a parser matching the one the site was built for.
 */
async function openTab(url: string): Promise<PageHarvest> {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForComplete(tab.id);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN", // __NEXT_DATA__ / __SERVER_DATA__ are page globals, not isolated ones
      func: readPage,
    });
    return result as PageHarvest;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/** Injected into the page. Must be self-contained — it is serialised, not bundled. */
function readPage(): { jsonLd: unknown[]; nextData: unknown; serverData: unknown; url: string } {
  const jsonLd: unknown[] = [];
  for (const el of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    const txt = (el.textContent || "").trim();
    if (!txt) continue;
    try {
      jsonLd.push(JSON.parse(txt));
    } catch {
      /* a malformed block is one skipped block, not a failed page */
    }
  }
  let nextData: unknown = null;
  const nextEl = document.getElementById("__NEXT_DATA__");
  if (nextEl?.textContent) {
    try {
      nextData = JSON.parse(nextEl.textContent);
    } catch {
      /* ignore */
    }
  }
  return { jsonLd, nextData, serverData: (window as any).__SERVER_DATA__ ?? null, url: location.href };
}

function waitForComplete(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      // Resolve rather than reject: a page that never fires `complete` (a hanging
      // analytics beacon, a websocket) has usually already rendered what we need.
      resolve();
    }, HARVEST_TIMEOUT_MS);
    const listener = (id: number, info: any) => {
      if (id !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      // A beat for client-rendered pages to populate before we read them.
      setTimeout(resolve, 1200);
    };
    chrome.tabs.onUpdated.addListener(listener);
    if (!tabId) reject(new Error("no tab"));
  });
}

/** One round of work. Called by the alarm, never looping on its own — the service worker
 *  can be evicted mid-loop, and an alarm is the only durable heartbeat available. */
async function tick(): Promise<void> {
  const { baseUrl, token, enabled } = await store.get();
  if (!enabled || !token) return;

  const client = new NetClient({ baseUrl, token });
  const execute = makeExecutor({ openTab });
  try {
    const summary = await runWorker({
      client,
      execute,
      once: true, // one batch per alarm; the alarm is the loop
      max: 2,
      onLog: (m) => store.patchStats({ status: m }),
    });
    const { stats } = await store.get();
    await store.patchStats({
      jobs: stats.jobs + summary.submitted,
      found: stats.found + summary.items,
      published: stats.published + summary.published,
      tier: summary.tier || stats.tier,
      status: summary.idle ? "Nothing to do right now." : `${summary.submitted} job(s) done, ${summary.items} events found.`,
    });
  } catch (err) {
    // A coordinator that is down, or a revoked token. Say so plainly and keep the alarm —
    // the next tick recovers, and a token the user revoked should show as an error rather
    // than as silence.
    await store.patchStats({ status: `Paused: ${(err as Error).message}` });
  }
}

chrome.alarms.onAlarm.addListener((a: any) => {
  if (a.name === ALARM) tick();
});

chrome.runtime.onMessage.addListener((msg: any, _sender: any, reply: (r: unknown) => void) => {
  (async () => {
    if (msg?.type === "setEnabled") {
      await chrome.storage.local.set({ enabled: !!msg.enabled });
      if (msg.enabled) {
        // `periodInMinutes` is floored at 1 by Chrome. That is far more often than a 6-hour
        // consensus window needs, and it costs nothing: the coordinator answers "no work"
        // in one request when there's nothing to do.
        await chrome.alarms.create(ALARM, { periodInMinutes: 1, delayInMinutes: 0 });
        tick();
      } else {
        await chrome.alarms.clear(ALARM);
        await store.patchStats({ status: "Stopped." });
      }
    }
    reply(await store.get());
  })();
  return true; // async reply
});

// Survive a browser restart with the switch still on.
chrome.runtime.onStartup?.addListener(async () => {
  const { enabled } = await store.get();
  if (enabled) await chrome.alarms.create(ALARM, { periodInMinutes: 1, delayInMinutes: 0 });
});
