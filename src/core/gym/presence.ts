/**
 * The hardened door — the policy half, pure and runtime-portable.
 *
 * This exists because `checkin_tokens` cannot be what host-awarded XP rests on. That
 * table stores `ulid()+ulid()` in plaintext, and until very recently the client put the
 * token in a URL *query param* and auto-submitted it on mount, so forwarding the link
 * checked someone in from another state. `src/core/checkin/door.ts` shortened that window
 * and moved the token into the fragment, but a check-in only claims you attended — it is
 * a social record, and it is load-bearing for the review-gate, the attend streak,
 * `points.checkin` and `VibeRepo`'s verification. Tightening it further would change the
 * meaning of every historical row.
 *
 * So the economy gets its own record. `event_presence` is created only by consuming one
 * of these codes, and it inherits `src/core/net/invite.ts`'s four defences:
 *
 *   1. the secret is 256 bits of CSPRNG and only its SHA-256 is stored, so a database
 *      read — or a leaked backup — cannot manufacture attendance;
 *   2. it expires in 90 seconds and the on-screen code re-mints every 30, revoking its
 *      predecessor, so a photographed screen is stale before it can be forwarded;
 *   3. it has a use ceiling, enforced by the claiming UPDATE (see `GymRepo.claimDoorUse`);
 *   4. redemption requires the scanner's GPS to be within `DOOR_RADIUS_M` of where the
 *      host's phone stood when the code was minted, inside the Bay, and inside the
 *      event's own time window.
 *
 * The one generalisation over a handshake invite: a handshake code is shown to ONE
 * person, a door code to a QUEUE. Single-use would mean re-minting per scan, so this has
 * `max_uses` instead — the same atomic guarantee, counted.
 */
import { eventEndMs, eventStartMs, type EventWindow } from "./window";

/** A screenshot is stale before it can be forwarded. */
export const DOOR_TTL_MS = 90_000;

/** The displayed QR re-mints this often, revoking the code that was on screen. */
export const DOOR_ROTATE_MS = 30_000;

/** A 30-second window admits a queue, not a city. */
export const DOOR_MAX_USES = 20;

/**
 * "Inside this venue", not "on this block".
 *
 * Deliberately looser than `INVITE_RADIUS_M` (75 m): indoor GPS is poor, a conference
 * floor is bigger than a sidewalk handshake, and the distance is measured to the HOST's
 * minting fix rather than to `events.latitude` — `/api/host` never collects coordinates
 * and a large share of scraped venues are ungeocoded, so the event row is not a usable
 * anchor.
 */
export const DOOR_RADIUS_M = 150;

/** Doors may open this long before the listed start. */
export const DOOR_OPENS_BEFORE_MS = 60 * 60 * 1000;

/** …and shut this long after the end. */
export const DOOR_SHUTS_AFTER_MS = 3 * 60 * 60 * 1000;

/**
 * What the door QR encodes. An `https://` URL, so a stranger's stock camera app opens the
 * page with nothing installed — the lowest-friction path we can offer someone standing in
 * a doorway.
 *
 * The secret is in the FRAGMENT, which browsers never send to a server. That is the whole
 * point of this function: in the query string it would land in the Worker's request log,
 * in analytics, and in the `Referer` of every outbound link on the page.
 */
export function doorUrl(origin: string, eventId: string, codeId: string, secret: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/app/event/${encodeURIComponent(eventId)}/door#c=${encodeURIComponent(codeId)}&k=${encodeURIComponent(secret)}`;
}

/** Parse what `doorUrl` produced. Total: null unless both halves are present. */
export function parseDoorUrl(url: string): { codeId: string; secret: string } | null {
  try {
    return parseDoorHash(new URL(url).hash);
  } catch {
    return null;
  }
}

/** The same read, for a browser that has `location.hash` rather than a whole URL. */
export function parseDoorHash(hash: string): { codeId: string; secret: string } | null {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const codeId = p.get("c");
  const secret = p.get("k");
  return codeId && secret ? { codeId, secret } : null;
}

/** Every way a scan can fail, as data. The route maps these to status codes and copy. */
export type PresenceCheck =
  | "ok"
  | "expired"
  | "revoked"
  | "exhausted"
  | "too_far"
  | "out_of_region"
  | "self"
  | "too_early"
  | "too_late";

export interface DoorFacts {
  hostId: string;
  lat: number;
  lng: number;
  expiresAt: string;
  revokedAt?: string | null;
  uses: number;
  maxUses: number;
}

/** When a door may be open at all — the cheapest single defence against pre-minting a
 *  code for next month's event and farming presence tonight. */
export function doorWindow(ev: EventWindow): { fromMs: number; toMs: number } {
  return { fromMs: eventStartMs(ev) - DOOR_OPENS_BEFORE_MS, toMs: eventEndMs(ev) + DOOR_SHUTS_AFTER_MS };
}

/**
 * May this person claim presence? Pure and total.
 *
 * The ORDER is deliberate and is part of the contract: identity, then liveness, then
 * TIME, then geography. Geography comes last because the geographic messages are the
 * only ones worth explaining to an honest attendee standing in the wrong place — telling
 * someone "you're too far away" when the real problem is that the code was already spent
 * sends them walking around a lobby for nothing.
 *
 * This does NOT decide the use ceiling on its own. `exhausted` is a courtesy fast path
 * for a clean 409; the guarantee lives in the claiming UPDATE, because two concurrent
 * scans can both pass any check that only reads. Same division as `checkRedeem`'s `taken`.
 */
export function checkPresence(
  door: DoorFacts,
  scanner: { id: string; lat: number; lng: number },
  ev: EventWindow,
  atMs: number,
  inRegion: (lat: number, lng: number) => boolean,
  distanceM: (aLat: number, aLng: number, bLat: number, bLng: number) => number,
): PresenceCheck {
  // A host cannot generate their own attendance — that is the mint printing its own
  // monetary base. Mirrors `network_invites`' self-vouch CHECK.
  if (door.hostId === scanner.id) return "self";
  if (door.revokedAt) return "revoked";
  if (door.uses >= door.maxUses) return "exhausted";

  const exp = Date.parse(door.expiresAt);
  if (!Number.isFinite(exp) || exp <= atMs) return "expired";

  const { fromMs, toMs } = doorWindow(ev);
  // An unparseable event window fails CLOSED. For something that gates minted currency
  // that is the only safe default.
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return "too_late";
  if (atMs < fromMs) return "too_early";
  if (atMs > toMs) return "too_late";

  if (!inRegion(scanner.lat, scanner.lng)) return "out_of_region";
  if (distanceM(door.lat, door.lng, scanner.lat, scanner.lng) > DOOR_RADIUS_M) return "too_far";
  return "ok";
}
