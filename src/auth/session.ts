import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../worker/env";

export const SESSION_COOKIE = "bay_session";
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const key = (token: string) => `sess:${token}`;
const newToken = () =>
  (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");

type Ctx<E extends { Bindings: Env }> = Context<E>;

/** Mint a session (opaque token in KV → userId) and set the cookie. */
export async function startSession<E extends { Bindings: Env }>(c: Ctx<E>, userId: string): Promise<void> {
  const token = newToken();
  await c.env.SESSIONS.put(key(token), userId, { expirationTtl: TTL_SECONDS });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: TTL_SECONDS,
  });
}

/** Resolve the current request's userId from its session cookie, or null. */
export async function currentUserId<E extends { Bindings: Env }>(c: Ctx<E>): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return (await c.env.SESSIONS.get(key(token))) || null;
}

/** Destroy the session (server + cookie). */
export async function endSession<E extends { Bindings: Env }>(c: Ctx<E>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.SESSIONS.delete(key(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
