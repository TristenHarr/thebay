import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

/**
 * The operator's bearer token, checked in ONE place.
 *
 * This check was copy-pasted thirteen times across `src/worker/index.ts`, four route modules
 * and `src/worker/news.ts`, each an inline `c.req.header("authorization") !== \`Bearer ${token}\``.
 * Thirteen copies of a security check is thirteen chances for one of them to drift, and the
 * drift that matters is the silent kind: an admin route that forgets the `!token` guard becomes
 * an OPEN admin route the moment the secret is unset.
 *
 * Two behaviours worth stating, because both were already true and are now true by construction:
 *
 *   · **Fail closed.** No `INGEST_TOKEN` configured means every admin route 401s. An unset
 *     secret must never mean "no check required".
 *   · **Constant-time comparison.** The old `!==` leaked the length of the shared prefix through
 *     timing. That is a weak attack against a 256-bit token over the internet, but it costs
 *     nothing to remove and there is no argument for keeping it.
 *
 * Note what this is NOT: it is not the volunteers' credential. Worker tokens
 * (`src/worker/middleware/worker-token.ts`) authenticate a member's machine and reach
 * `/api/net/*` only. `INGEST_TOKEN` grants `renormalize`, `prune-out-of-region`, `enrich` and
 * `run-autopilot` — handing it out would hand over the catalog, so it is only ever the
 * operator's.
 */

/** Constant-time string compare. Total: a length mismatch is false, never a throw. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Does this request carry the operator's token? Fail-closed when none is configured. */
export function ingestTokenOk(c: { env: Env; req: { header(name: string): string | undefined } }): boolean {
  const token = c.env.INGEST_TOKEN;
  if (!token) return false;
  const header = c.req.header("authorization");
  return !!header && timingSafeEqual(header, `Bearer ${token}`);
}

/** 401 unless the operator's token is presented. */
export const requireIngestToken: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!ingestTokenOk(c as any)) return c.json({ error: "unauthorized" }, 401);
  await next();
};
