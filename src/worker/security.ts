/**
 * Response hardening, shared by both Workers (thebay.events and thebay.news) so
 * the two can't drift apart on security posture. Applied to EVERY response —
 * including redirects and error pages, which is where these are usually missed.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
};

/** Stamp the hardening headers onto a response (asset responses can have
 *  immutable headers, so fall back to rebuilding it). */
export function harden(res: Response): Response {
  try {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  } catch {
    const r = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
    return r;
  }
}
