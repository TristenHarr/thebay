import type { MiddlewareHandler } from "hono";
import type { Env, Vars } from "../env";
import { NetworkRepo, type Member, type WorkerClientRow } from "../../storage/d1/network-repo";
import { hashSecret } from "../../core/net/invite";

/**
 * Authenticates a scrape-network client by its bearer token — a machine, not a person.
 *
 * This exists as a distinct credential for one reason: today a single shared
 * `INGEST_TOKEN` gates `ingest`, `renormalize`, `prune-out-of-region`, `retag`,
 * `enrich`, `reindex`, `tags`, `run-autopilot` and `geocode`. Handing that to a
 * volunteer wouldn't be granting them the ability to contribute data; it would be
 * granting them the catalog. A worker token reaches `/api/net/*` and nothing else, is
 * stored only as a SHA-256, is revocable per device, and carries the identity of the
 * member who owns it — so a submission is always attributable to a person who joined
 * in a physical handshake.
 *
 * Lookup is by digest, so a stolen database yields no usable tokens, and there is no
 * string comparison to time: the hash is the primary key we query.
 */

export type NetVars = Vars & { client: WorkerClientRow; member: Member };

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

/**
 * 401 unless a live worker token is presented; 403 if its owner is no longer a member
 * or is quarantined. A quarantined member's client is refused work rather than fed
 * jobs whose results we would then hold and never publish — telling them plainly beats
 * wasting their bandwidth.
 */
export const requireWorker: MiddlewareHandler<{ Bindings: Env; Variables: Partial<NetVars> }> = async (c, next) => {
  const token = bearer(c.req.header("authorization"));
  if (!token) return c.json({ error: "worker token required" }, 401);

  const repo = new NetworkRepo(c.env.DB);
  const client = await repo.clientByTokenHash(await hashSecret(token));
  if (!client) return c.json({ error: "unknown or revoked worker token" }, 401);

  const member = await repo.member(client.userId);
  if (!member) return c.json({ error: "this client's owner is not in the network" }, 403);
  if (member.quarantinedAt) return c.json({ error: "membership under review — no work is being issued", reason: "quarantined" }, 403);

  c.set("client", client);
  c.set("member", member);
  await next();
};

/**
 * Where this client speaks from — a salted hash of the IP plus the ASN, which is all
 * we need to answer "are these two workers independent?" and deliberately less than we
 * would need to know where somebody lives.
 *
 * The salt is `HANDSHAKE_KEY` when configured: the hash only has to be stable and
 * unguessable within one deployment, and reusing the key avoids inventing a second
 * secret that could be forgotten in production and silently degrade Sybil detection.
 */
export async function egressOf(c: any): Promise<{ ipHash: string | null; asn: number | null }> {
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const cf = (c.req.raw as any)?.cf;
  const asnRaw = cf?.asn;
  const asn = typeof asnRaw === "number" && Number.isFinite(asnRaw) ? asnRaw : Number.isFinite(Number(asnRaw)) ? Number(asnRaw) : null;
  const salt = c.env?.HANDSHAKE_KEY || "";
  return { ipHash: ip ? await hashSecret(`egress|${salt}|${ip}`) : null, asn };
}

/**
 * Is this client on a residential connection? Derived, never claimed — a capability a
 * client can assert is just a request to be given the work that needs it. Cloudflare
 * tells us the ASN; the datacenter ranges we care about are the ones Eventbrite blocks.
 *
 * Conservative by design: unknown ⇒ not residential. Being wrong in that direction
 * costs a volunteer some jobs; being wrong the other way sends browser-hostile work to
 * a machine that will silently collect 403s and look like a bad actor.
 */
const DATACENTER_ASNS = new Set([
  16509, 14618, 8987, // AWS
  15169, 396982, // Google / GCP
  8075, // Microsoft / Azure
  14061, // DigitalOcean
  16276, // OVH
  24940, // Hetzner
  20473, // Vultr / Choopa
  63949, // Akamai / Linode
  13335, // Cloudflare
]);

export function looksResidential(asn: number | null): boolean {
  return asn != null && Number.isFinite(asn) && !DATACENTER_ASNS.has(asn);
}
