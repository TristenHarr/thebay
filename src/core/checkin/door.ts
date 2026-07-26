/**
 * The door code's shape and lifetime — pure, and imported by BOTH the Worker
 * (`PlatformRepo.createCheckinToken`) and the browser (`web/src/features/checkin`),
 * following the precedent of `web/src/features/city/City.tsx` importing `inBay`
 * straight out of `src/core`. The TTL and the refresh cadence have to agree or the
 * door goes dark mid-event, so they live in one file rather than two.
 *
 * ## What was wrong
 *
 * `checkin_tokens` stores `ulid() + ulid()` in PLAINTEXT with a one-hour TTL, no
 * single-use and no revocation — and the client put the token in a URL **query
 * param** and auto-submitted it on mount. Forwarding that link checked someone in
 * from anywhere, for an hour. Pressing "↻ Rotate code" minted a second valid token
 * and left the first one live, which is the opposite of rotating.
 *
 * ## What this fixes, and what it does not
 *
 * Fixed here: the window is ~2 minutes instead of an hour, rotation actually revokes,
 * and the credential moves into the URL **fragment** so it never reaches a server log,
 * a `Referer` header, or a CDN record.
 *
 * NOT fixed here, deliberately: the token is still stored in the clear, there is still
 * no geofence, and there is still no proof you were in the room. Those are what
 * `door_codes` + `event_presence` are for (migrations/0027), and host-awarded XP hangs
 * off *those* — never off this table. A check-in only claims you attended; it must not
 * become the thing that mints currency. Keeping the two separate is why `checkins` can
 * stay untouched while the economy gets a hardened record of its own.
 */

/** How long a displayed code stays valid. Short enough that a forwarded link is dead
 *  before it can be useful; long enough to survive a slow phone finishing a scan. */
export const CHECKIN_TOKEN_TTL_MS = 120_000;

/** How often the host's screen mints a fresh code. Must be < the TTL so the code on
 *  screen always has life left in it. The gap (30s) is the grace an in-flight scan gets. */
export const CHECKIN_ROTATE_MS = 90_000;

/**
 * The URL a door QR encodes. An `https://` link, so a stranger's stock camera app
 * opens the check-in page with nothing installed.
 *
 * The token is in the FRAGMENT, and that is the entire purpose of this function.
 * Put it in the query string — as the shipped client did — and it lands in the
 * Worker's request log, in analytics, and in the `Referer` of every outbound link on
 * the page. `src/core/net/invite.ts` documents the same reasoning for handshake
 * secrets; the check-in screen never got the memo.
 */
export function checkinUrl(origin: string, eventId: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/app/event/${encodeURIComponent(eventId)}/checkin#token=${encodeURIComponent(token)}`;
}

/**
 * Read the token back out of a scanned URL. Total: returns null for anything that
 * isn't a URL carrying a `token` fragment param.
 *
 * A legacy `?token=` link is deliberately NOT honoured. Accepting it would keep the
 * leak path open for anything still generating that shape, and every token minted in
 * the old format expires within the hour anyway.
 */
export function tokenFromUrl(url: string): string | null {
  try {
    return tokenFromHash(new URL(url).hash);
  } catch {
    return null;
  }
}

/** The same read, for a browser that has `location.hash` rather than a whole URL. */
export function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return token || null;
}
