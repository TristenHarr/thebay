import type { MiddlewareHandler } from "hono";
import type { Env, Vars } from "../worker/env";
import { SocialRepo } from "../storage/d1/social-repo";
import { currentUserId } from "./session";

/** Attach the user if signed in; never blocks. Use for routes that adapt to auth. */
export const optionalAuth: MiddlewareHandler<{ Bindings: Env; Variables: Partial<Vars> }> = async (c, next) => {
  const uid = await currentUserId(c);
  if (uid) {
    const user = await new SocialRepo(c.env.DB).getUserById(uid);
    if (user) c.set("user", user);
  }
  await next();
};

/** Gate a route: 401 unless signed in. Downstream handlers get a typed non-null user. */
export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const uid = await currentUserId(c);
  const user = uid ? await new SocialRepo(c.env.DB).getUserById(uid) : null;
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
};
