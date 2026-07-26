/**
 * Host-minted badges — the gym leader's ceremony, and the two defences that keep it from
 * counterfeiting the system's own awards.
 *
 * ## 1. Namespacing stops COLLISION
 *
 * `achievements.kind` is free text. A canonical trophy is a bare slug (`local_legend`); a host
 * badge is `gym:<ULID>`. Since no trophy id contains a colon (asserted in
 * tests/trophy-catalog.test.ts) and the schema trigger in migrations/0031 refuses any other
 * namespace, the two id spaces cannot overlap by construction.
 *
 * ## 2. Namespacing does NOT stop IMPERSONATION
 *
 * Nothing above prevents a host minting a badge *labelled* "Local Legend" with the canonical
 * trophy's own emoji. Two things handle that:
 *
 *   · `checkBadge` refuses a reserved label under aggressive normalisation, because
 *     "L0cal-Legend!" and "local  legend" are the obvious next move;
 *   · and the real defence, which is not in this file: a host badge ALWAYS renders with
 *     "awarded by @handle at ‹event›", and a canonical trophy never does. A tick that says who
 *     gave it to you cannot pass as a system award whatever it is called.
 *
 * The reserved list is DERIVED from the trophy catalog rather than hand-maintained, so a new
 * trophy reserves its own name and nobody has to remember a second list.
 */
import { TROPHY_LABELS, normalizeLabel } from "../trophies/catalog";

/** The reserved namespace. The one place this string is built. */
export const BADGE_NAMESPACE = "gym:";

export type BadgeCheck = "ok" | "reserved" | "no_emoji" | "blank" | "too_long";

/** Longest a badge label may be, so it fits a card without truncation. */
export const MAX_BADGE_LABEL = 40;

/** `gym:<badgeId>` — the `achievements.kind` for a host-minted badge. */
export function badgeKind(badgeId: string): string {
  return `${BADGE_NAMESPACE}${badgeId}`;
}

/** The badge id inside a kind, or null if this isn't a host badge. */
export function parseBadgeKind(kind: string): string | null {
  if (!kind.startsWith(BADGE_NAMESPACE)) return null;
  const id = kind.slice(BADGE_NAMESPACE.length);
  return id.length > 0 ? id : null;
}

/** Is this `achievements.kind` a canonical (system) trophy rather than a host badge? */
export function isCanonicalKind(kind: string): boolean {
  return !kind.includes(":");
}

/**
 * May a host mint this badge?
 *
 * Emoji is required for the same reason `place_kinds` requires one: a badge with no icon is
 * unrenderable, and the card is the product.
 */
export function checkBadge(b: { label: string; emoji: string }): BadgeCheck {
  const label = (b.label ?? "").trim();
  if (!label) return "blank";
  if (label.length > MAX_BADGE_LABEL) return "too_long";
  if (!(b.emoji ?? "").trim()) return "no_emoji";
  // Normalised comparison, so homoglyph and punctuation games don't get a free pass.
  if (TROPHY_LABELS.includes(normalizeLabel(label))) return "reserved";
  return "ok";
}

/** Copy for each refusal, so the host is told what to change. */
export const BADGE_CHECK_MESSAGE: Record<BadgeCheck, string> = {
  ok: "",
  blank: "Give the badge a name.",
  too_long: `Keep the name under ${MAX_BADGE_LABEL} characters.`,
  no_emoji: "Pick an emoji — it's what the badge looks like on a card.",
  reserved: "That's the name of a system trophy. Pick something that's yours.",
};

/** URL-safe slug for a badge, unique per event. Total: returns "" if nothing survives. */
export function badgeSlug(label: string): string {
  return (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}
