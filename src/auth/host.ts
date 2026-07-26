import type { MiddlewareHandler } from "hono";
import type { Env, Vars } from "../worker/env";
import { SocialRepo } from "../storage/d1/social-repo";

/**
 * Per-event authorization. Until now there was none: "host only" was a hand-rolled
 * two-liner duplicated verbatim at `src/worker/routes/platform.ts:108-109` and `:117-118`,
 * and every new host-gated route was another chance to get it subtly different.
 *
 * The subtle part is the NULL. `events.host_user_id` is nullable — its comment says
 * "non-null ⇒ user-hosted" — and the overwhelming majority of the catalog is scraped, so
 * it is null. A check written as `host?.id === userId` is correct; one written as
 * `event.host_user_id === user?.id` is a security hole the first time both sides are
 * nullish, and `undefined === undefined` is true. Hence one predicate, tested against
 * exactly that case.
 */

/** Is this user the host of this event? False for a scraped event (no host) and for an
 *  absent user — never "both nullish, therefore yes". */
export async function isHost(db: Env["DB"], eventId: string, userId: string | null | undefined): Promise<boolean> {
  if (!userId || !eventId) return false;
  const host = await new SocialRepo(db).eventHost(eventId);
  return !!host && host.id === userId;
}

/**
 * Gate a route to the event's host. Must run AFTER `requireAuth`, which is what
 * guarantees there is a user to compare against.
 *
 * The 403 body is byte-identical to the string the two migrated call sites returned, so
 * `tests/routes.test.ts` keeps passing unchanged — the point of this refactor is to have
 * one implementation, not to change the contract.
 *
 * Sets `hostEventId` so a handler doesn't re-query the event it was just authorized for.
 */
export function requireHost(param = "id"): MiddlewareHandler<{ Bindings: Env; Variables: Partial<Vars> }> {
  return async (c, next) => {
    const eventId = c.req.param(param);
    const user = c.get("user");
    if (!(await isHost(c.env.DB, eventId ?? "", user?.id))) return c.json({ error: "host only" }, 403);
    c.set("hostEventId", eventId!);
    await next();
  };
}
