/**
 * Bearer secrets and the redemption policy for the scrape network — pure and
 * runtime-portable (WebCrypto only, no `node:crypto`), so it behaves identically in
 * the Worker, in tests and in a client.
 *
 * The *credential* that admits someone is not here: it's an animated handshake, and
 * it lives in ./handshake.ts. What's here is the surrounding policy — who may redeem
 * (proximity, liveness, not-yourself) — plus the secret generator and digest
 * comparison used for worker tokens.
 *
 * Worker tokens get the same treatment as everything else in this repo: 256 bits of
 * CSPRNG, shown exactly once, stored only as SHA-256. Deliberately stronger than the
 * existing `createCheckinToken` (src/storage/d1/platform-repo.ts), which stores
 * `ulid()+ulid()` in plaintext — a check-in token only claims you attended an event,
 * whereas one of these submits data to the public catalog.
 */

/** "We are standing together", not "we are in the same city". */
export const INVITE_RADIUS_M = 75;

/** Bytes of entropy in a worker token. 32 B = 256 bits. */
const SECRET_BYTES = 32;

/** base64url (RFC 4648 §5) with no padding — safe in a URL and in a header. */
function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh 256-bit secret. */
export function mintSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/** SHA-256, lowercase hex. What we persist; the plaintext is shown once and dropped. */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time comparison of two hex digests. Total by design: a length mismatch or
 * an empty string returns false rather than throwing, because both are reachable
 * straight from user input — and the early length check is fine here, since digest
 * length is public and never secret-dependent.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Every way a redemption can fail before we even look at the frames. */
export type RedeemCheck = "ok" | "expired" | "revoked" | "taken" | "too_far" | "out_of_region" | "self";

export interface InviteFacts {
  ambassadorId: string;
  lat: number;
  lng: number;
  expiresAt: string;
  revokedAt?: string | null;
  redeemedAt?: string | null;
}

/**
 * The redemption policy, pure: given the session and where the scanner is standing,
 * may they in? Separated from the SQL so every rejection is unit-testable without a
 * database, and so the ORDER of the checks is visible and deliberate — identity and
 * liveness first, geography last, because the geographic messages are the only ones
 * we want to explain to an honest user standing in the wrong place.
 *
 * This does NOT decide single-use on its own. `taken` here is a courtesy fast path
 * for a clear 409; the guarantee lives in the redeeming UPDATE, because two
 * concurrent redemptions can both pass any check that only reads.
 */
export function checkRedeem(
  inv: InviteFacts,
  joiner: { id: string; lat: number; lng: number },
  atMs: number,
  inRegion: (lat: number, lng: number) => boolean,
  distanceM: (aLat: number, aLng: number, bLat: number, bLng: number) => number,
): RedeemCheck {
  if (inv.ambassadorId === joiner.id) return "self";
  if (inv.revokedAt) return "revoked";
  if (inv.redeemedAt) return "taken";
  const exp = Date.parse(inv.expiresAt);
  if (!Number.isFinite(exp) || exp <= atMs) return "expired";
  if (!inRegion(joiner.lat, joiner.lng)) return "out_of_region";
  if (distanceM(inv.lat, inv.lng, joiner.lat, joiner.lng) > INVITE_RADIUS_M) return "too_far";
  return "ok";
}
