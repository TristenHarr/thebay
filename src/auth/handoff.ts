/**
 * Cross-domain sign-in handoff.
 *
 * thebay.events and thebay.news are different registrable domains, so no cookie
 * can span them — there is no `Domain=` value that covers both, and that is a
 * property of the public suffix list, not something to work around. A signed-in
 * user is instead handed across with a single-use token.
 *
 * The token is:
 *   - stored HASHED, so a database dump doesn't yield live sessions;
 *   - claimed by ONE atomic guarded UPDATE, so two concurrent redemptions can't
 *     both succeed (see src/auth/magic.ts for the same lesson learned);
 *   - valid for 30 seconds, since it only has to survive one redirect;
 *   - bound to a target host, so a token minted for one domain can't be
 *     replayed at another;
 *   - carrying its destination path SERVER-SIDE, so the landing endpoint can
 *     never be turned into an open redirect by editing the query string.
 */
import type { Env } from "../worker/env";

const TTL_MS = 30_000;

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const newToken = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");

/**
 * Only site-relative paths are accepted as a destination. Rejects absolute URLs,
 * protocol-relative "//evil.com", and backslash tricks. Anything suspicious
 * degrades to "/" rather than erroring — a failed handoff should land the reader
 * on the front page, never on an error.
 */
export function safeNextPath(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s.startsWith("/")) return "/";
  if (s.startsWith("//") || s.includes("\\") || s.includes("://")) return "/";
  if (!/^\/[A-Za-z0-9/_\-.~?=&%#+,:]*$/.test(s)) return "/";
  return s.slice(0, 300);
}

/** Mint a handoff token for `userId`, valid only at `targetHost`. */
export async function mintHandoff(
  env: Env,
  userId: string,
  targetHost: string,
  nextPath: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const token = newToken();
  await env.DB
    .prepare(
      `INSERT INTO handoff_tokens (token_hash, user_id, target_host, next_path, expires_at, used, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(
      await sha256hex(token),
      userId,
      targetHost,
      safeNextPath(nextPath),
      new Date(nowMs + TTL_MS).toISOString(),
      new Date(nowMs).toISOString(),
    )
    .run();
  return token;
}

/**
 * Claim a handoff token. Returns the user and destination, or null for anything
 * unknown, expired, already used, or minted for a different host — the caller
 * treats all of those identically (send them to the front page, logged out)
 * rather than leaking which one it was.
 */
export async function claimHandoff(
  env: Env,
  token: string,
  targetHost: string,
  nowMs: number = Date.now(),
): Promise<{ userId: string; nextPath: string } | null> {
  if (!token) return null;
  const hash = await sha256hex(token);

  // The UPDATE is the guard: atomic, so a replayed token loses the race.
  const claimed = await env.DB
    .prepare(
      `UPDATE handoff_tokens SET used = 1
        WHERE token_hash = ? AND used = 0 AND expires_at > ? AND target_host = ?`,
    )
    .bind(hash, new Date(nowMs).toISOString(), targetHost)
    .run();
  if (!claimed.meta?.changes) return null;

  const row = await env.DB
    .prepare("SELECT user_id, next_path FROM handoff_tokens WHERE token_hash = ?")
    .bind(hash)
    .first<{ user_id: string; next_path: string }>();
  if (!row) return null;
  return { userId: row.user_id, nextPath: safeNextPath(row.next_path) };
}

/**
 * A handoff must be a real top-level navigation. Without this an attacker could
 * force a victim's browser to load the landing URL from an <img> or fetch() and
 * silently sign them in as the attacker (session fixation / login CSRF).
 */
export function isTopLevelNavigation(headers: { get(name: string): string | null }): boolean {
  const dest = headers.get("sec-fetch-dest");
  const mode = headers.get("sec-fetch-mode");
  // Reject only on a POSITIVE signal that this is NOT a top-level navigation.
  //
  // Requiring both headers to be present-and-correct looks stricter but is
  // wrong: plenty of legitimate clients send partial or no fetch-metadata (curl
  // sends none, some HTTP stacks send mode without dest), and those users would
  // be locked out of signing in. The attack we actually care about always
  // carries a positive tell — an <img> sends dest=image, a fetch() sends
  // mode=cors/no-cors with dest=empty — so checking for those catches it without
  // punishing clients that simply say nothing.
  if (dest !== null && dest !== "document") return false;
  if (mode !== null && mode !== "navigate") return false;
  return true;
}
