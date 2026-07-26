import type { Env } from "./env";
import { ScrapeNetRepo } from "../storage/d1/scrape-net-repo";
import { adminHandles } from "../auth/admin";
import { parseRobots } from "../core/scrape/robots";

/**
 * The scrape network's cron work — the parts that need I/O, kept out of `src/worker/index.ts`
 * so each has room to explain itself and can be driven directly from a test.
 *
 * Two of these close holes that would have made the network look mysteriously broken rather
 * than broken:
 *
 *   · `seedFoundingMembers` — only `trusted`/`core` members may vouch, and `network_members`
 *     starts empty, so with nobody founding it the FIRST handshake is unreachable and the whole
 *     thing is inert behind a 403 nobody can explain.
 *   · `refreshRobots` — `parseRobots` existed and nothing called it, so `crawl_delay_ms` and the
 *     disallow rules stayed empty forever and every claim about politeness was aspirational.
 */

/**
 * How we identify ourselves to the sites we crawl. Honest, with a contact path — the same
 * convention `src/news/ingest/hn.ts` uses for thebay.news.
 *
 * Note the contrast with `DEFAULT_UA` in `src/sources/util/http.ts`, which spoofs Chrome for
 * Eventbrite. Nothing here spoofs anything: this UA is the one we ask hosts to write rules for,
 * and a crawler that asks to be governed by robots.txt under a name it doesn't use is not
 * asking anything at all.
 */
export const NETWORK_UA = "thebay.events scrape network (+https://thebay.events/about)";

/** How long a fetched robots.txt is trusted. Re-reading it four times an hour per host would
 *  itself be the impolite thing. */
export const ROBOTS_TTL_MS = 24 * 3600_000;

/** Hosts checked per tick, so a large source list warms up over a few ticks instead of
 *  fanning out dozens of requests at once. */
const ROBOTS_PER_TICK = 8;

/**
 * Make the operator's own handles founding members.
 *
 * Privilege comes from `ADMIN_HANDLES` — config, not a database column — for exactly the reason
 * `src/auth/admin.ts` gives for moderation: privilege stored in config cannot be escalated by an
 * application bug or by a compromised account editing its own row, and changing who founds the
 * network requires access to the deployment.
 *
 * Deliberately weak, three ways. It only ever INSERTs (`ON CONFLICT DO NOTHING`), so a founder
 * who later loses standing the honest way stays lost — config founds you once, it does not keep
 * you promoted. It never creates a user, so naming a handle that hasn't signed in yet is a no-op
 * rather than a forged account. And with `ADMIN_HANDLES` unset it does nothing at all.
 */
export async function seedFoundingMembers(env: Env, atMs: number = Date.now()): Promise<{ seeded: string[] }> {
  const handles = adminHandles(env);
  if (!handles.length) return { seeded: [] };

  const seeded: string[] = [];
  for (const handle of handles.slice(0, 20)) {
    const user = await env.DB.prepare("SELECT id FROM users WHERE handle = ?").bind(handle).first<{ id: string }>();
    if (!user) continue; // hasn't signed in yet — normal on a fresh deploy
    const res: any = await env.DB.prepare(
      `INSERT INTO network_members (user_id, tier, founding, joined_at) VALUES (?, 'core', 1, ?)
       ON CONFLICT(user_id) DO NOTHING`,
    )
      .bind(user.id, new Date(atMs).toISOString())
      .run();
    if ((res?.meta?.changes ?? 0) === 1) seeded.push(user.id);
  }
  return { seeded };
}

/**
 * Fetch and store robots.txt for the hosts whose copy is stale.
 *
 * Fails OPEN, and that direction is deliberate: an absent or unreachable robots.txt means "no
 * restrictions stated", and treating a CDN hiccup as deny-all would silently stop the entire
 * network. A rule we *did* read is obeyed — enforcement happens at lease time in
 * `ScrapeNetRepo.lease`, because storing the rules and then leasing anyway would be theatre.
 *
 * `fetchImpl` is injected, the same idiom every `src/news/ingest/*` adapter uses, so this is
 * testable against real robots.txt fixtures with no network.
 */
export async function refreshRobots(
  env: Env,
  fetchImpl: typeof fetch = fetch,
  atMs: number = Date.now(),
): Promise<{ fetched: number; failed: number }> {
  const net = new ScrapeNetRepo(env.DB);
  const hosts = await net.hostsNeedingRobots(atMs - ROBOTS_TTL_MS, ROBOTS_PER_TICK);
  let fetched = 0;
  let failed = 0;

  for (const host of hosts) {
    try {
      const res = await fetchImpl(`https://${host}/robots.txt`, {
        headers: { "user-agent": NETWORK_UA, accept: "text/plain" },
        redirect: "follow",
      });
      // Anything that isn't a 200 states no restrictions. Recorded as checked either way, so a
      // permanently 404ing host isn't re-fetched every tick.
      const txt = res.ok ? (await res.text().catch(() => "")).slice(0, 200_000) : "";
      const rules = parseRobots(txt, NETWORK_UA);
      await net.setRobots(host, { crawlDelayMs: rules.crawlDelayMs, disallow: rules.disallow, allow: rules.allow, status: res.status }, atMs);
      fetched++;
    } catch {
      // Unreachable. Mark it checked with no restrictions so one dead host doesn't block the
      // rest of the queue behind it on every tick, and try again after the TTL.
      failed++;
      await net.setRobots(host, { crawlDelayMs: null, disallow: [], allow: [], status: null }, atMs);
    }
  }
  return { fetched, failed };
}

/** Did this host just refuse us? A 429 or a 403 is a refusal; a 5xx is a bad day. */
export function isRebuff(status: number | null | undefined): boolean {
  return status === 429 || status === 403;
}

/** `Retry-After` in ms if a client passed one through, else null. */
export function retryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs > 0) return Math.min(3600_000, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
