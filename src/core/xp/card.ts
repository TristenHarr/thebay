/**
 * THE CARD. The thing you see when you catch somebody.
 *
 * Pure, so the Worker can render an OG image and the browser can render the live card from the
 * same function and they cannot disagree about what somebody's stats are.
 *
 * This is where four pieces that already existed finally meet:
 *   · `founderStats` (src/core/xp/stats.ts) — five axes + power + rarity. Written and unit
 *     tested long ago, and until now wired to NOTHING, so nobody had ever seen one.
 *   · `levelProgress` (src/core/xp/levels.ts) — the level from the XP ledger.
 *   · the type chart (src/core/types/chart.ts) — what you are, and which rooms are yours.
 *   · host-minted badges (migrations/0031) — what gym leaders have given you.
 *
 * Rarity comes from `power`, which is computed from activity and reputation — NOT from type.
 * A VC is not rarer than an engineer; somebody who actually shows up is rarer than somebody
 * who doesn't.
 */
import { founderStats, type FounderSnapshot, type FounderStats, type Rarity } from "./stats";
import { levelProgress, type LevelProgress } from "./levels";
import { founderType, type FounderType } from "../types/chart";

export interface CardType {
  id: string;
  label: string;
  emoji: string;
  color: string;
  /** How many people have vouched that they really are this. */
  vouches: number;
}

export interface CardBadge {
  id: string;
  label: string;
  emoji: string;
  color: string;
  /** Always present for a host badge — provenance is what stops it passing as a system award. */
  awardedBy: string | null;
  eventTitle: string | null;
  awardedAt: string;
}

export interface FounderCard {
  userId: string;
  handle: string | null;
  displayName: string;
  level: LevelProgress;
  stats: FounderStats;
  rarity: Rarity;
  /** Primary first, optional secondary second. Empty if they haven't declared. */
  types: CardType[];
  badges: CardBadge[];
  /** Canonical trophies held, for the corner count. */
  trophies: number;
  /** One line under the name. */
  tagline: string;
}

export interface CardInput {
  userId: string;
  handle: string | null;
  displayName: string;
  snapshot: FounderSnapshot;
  /**
   * Total XP from the ledger.
   *
   * Carried separately from `snapshot.level` because that field is a LEVEL — `founderStats`
   * uses it for the `reach` axis — while the progress bar needs the raw total. Widening
   * `FounderSnapshot` instead would ripple into every `founderStats` test for a field that
   * only the card wants.
   */
  xpTotal: number;
  /** Declared type ids, primary first. */
  typeIds: readonly string[];
  /** Vouch counts per type id. */
  vouches?: Record<string, number>;
  badges?: readonly CardBadge[];
  trophies?: number;
}

/** Rarity as a word, for the frame. */
export const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

/**
 * A tagline built from the card's own strongest facts.
 *
 * Deliberately derived rather than free text: a self-written bio is a different feature
 * (`users.bio`), and a card that quotes your own marketing is not evidence of anything. This
 * says what your record says.
 */
function taglineFor(stats: FounderStats, types: CardType[], snapshot: FounderSnapshot): string {
  const t = types[0]?.label;
  const axes: Array<[string, number]> = [
    ["connector", stats.network],
    ["builder", stats.technical],
    ["investor", stats.capital],
    ["regular", stats.momentum],
  ];
  const [top, topScore] = axes.sort((a, b) => b[1] - a[1])[0]!;
  if (topScore < 20) return t ? `${t} · new around here` : "New around here";
  if (snapshot.streakBest >= 5) return `${t ?? "Bay"} · ${top} · ${snapshot.streakBest}-event streak`;
  return t ? `${t} · ${top}` : `Bay ${top}`;
}

/**
 * Assemble the card. Total: an unknown type id renders as a generic chip rather than throwing,
 * because the vocabulary is a table and a client may be a deploy behind.
 */
export function buildCard(input: CardInput): FounderCard {
  const stats = founderStats(input.snapshot);
  const types: CardType[] = input.typeIds
    .map((id) => {
      const t: FounderType | undefined = founderType(id);
      return {
        id,
        label: t?.label ?? id,
        emoji: t?.emoji ?? "❓",
        color: t?.color ?? "#8b8b9a",
        vouches: input.vouches?.[id] ?? 0,
      };
    })
    .slice(0, 2);

  return {
    userId: input.userId,
    handle: input.handle,
    displayName: input.displayName,
    level: levelProgress(input.xpTotal),
    stats,
    rarity: stats.rarity,
    types,
    badges: [...(input.badges ?? [])],
    trophies: input.trophies ?? 0,
    tagline: taglineFor(stats, types, input.snapshot),
  };
}
