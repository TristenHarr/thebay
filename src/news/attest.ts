/**
 * Bay-presence attestation.
 *
 * Posting, commenting and voting on thebay.news require the actor to be
 * physically in the Bay Area. Asking the browser for coordinates on every write
 * would be miserable, so a single successful check buys a 12-hour attestation in
 * KV; the write routes check for it rather than re-prompting.
 *
 * Voting is gated too, deliberately: it drives ranking, so leaving it open would
 * make the geofence decorative for the action that matters most.
 *
 * This is a friction and locality mechanism, not a security boundary — browser
 * geolocation is client-reported and a determined user can lie to it. It is
 * exactly as strong as the map bulletin board's existing gate, which is the
 * standard this site already set.
 */
import { inBay } from "../core/geo";
import type { Env } from "../worker/env";

export const ATTEST_TTL_SECONDS = 12 * 60 * 60;

const key = (userId: string) => `geo:${userId}`;

/** Record a successful in-Bay check. Returns false (and stores nothing) if the
 *  coordinates are outside the Bay or unusable. */
export async function attestLocation(env: Env, userId: string, lat: number, lng: number): Promise<boolean> {
  if (!inBay(lat, lng)) return false;
  await env.SESSIONS.put(key(userId), new Date().toISOString(), { expirationTtl: ATTEST_TTL_SECONDS });
  return true;
}

/** Has this user proved they're in the Bay recently? */
export async function hasAttestation(env: Env, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  return (await env.SESSIONS.get(key(userId))) !== null;
}
