/**
 * Who is allowed to moderate.
 *
 * Admin identity lives in an environment variable, NOT a database column. That's
 * deliberate: privilege stored in config cannot be escalated by an application
 * bug, a stray `ON CONFLICT DO UPDATE` that flips a boolean, or a compromised
 * account editing its own row. Changing who can moderate requires access to the
 * deployment, which is the correct bar.
 *
 * `ADMIN_HANDLES` is a comma-separated list of user handles, e.g. "ann,raj".
 * Unset means nobody can moderate — a safe default, but it does mean it has to
 * be set before the moderation queue is any use.
 */
import type { MiddlewareHandler } from "hono";
import type { Env, Vars } from "../worker/env";

export function adminHandles(env: { ADMIN_HANDLES?: string }): string[] {
  return String(env.ADMIN_HANDLES ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdmin(env: { ADMIN_HANDLES?: string }, user: { handle?: string } | null | undefined): boolean {
  if (!user?.handle) return false;
  return adminHandles(env).includes(user.handle.toLowerCase());
}

/**
 * Gate a route to admins.
 *
 * Non-admins — signed in or not — get a 404, not a 401 or 403. There's no reason
 * to advertise that a moderation surface exists, and a 403 tells an attacker
 * they've found the right URL and only need the right account.
 */
export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: Partial<Vars> }> = async (c, next) => {
  if (!isAdmin(c.env, c.get("user"))) return c.notFound();
  await next();
};
