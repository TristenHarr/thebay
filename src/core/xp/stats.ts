/**
 * Founder "stats" — the Pokémon-style card you see when you catch someone. PURE and
 * deterministic, derived entirely from data the platform already has (match prefs,
 * mentor topics, reviews, the social graph, activity) — no new profile fields. Used
 * by the Pokédex (catches) and any "scout a founder" surface.
 *
 * Five axes, each 0..100:
 *   capital   — investor / VC signal
 *   technical — builder signal
 *   network   — connector signal (friends + intros)
 *   momentum  — recent in-person activity (streaks, shadows, check-ins)
 *   reach     — reputation (level, reviews, points)
 * plus `power` (weighted overall) and a `rarity` bucket from power.
 */
export interface FounderSnapshot {
  technical: boolean;
  interests: string[];
  mentorTopics: string[];
  friends: number;
  introsMade: number;
  points: number;
  level: number;
  streakBest: number;
  reviewAvg: number | null; // 1..5
  reviewCount: number;
  shadows: number;
  checkins: number;
}

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export interface FounderStats {
  capital: number;
  technical: number;
  network: number;
  momentum: number;
  reach: number;
  power: number;
  rarity: Rarity;
}

const CAPITAL_WORDS = ["vc", "venture", "invest", "investor", "investing", "capital", "fund", "funding", "angel", "lp", "seed", "raise", "fundraising", "syndicate"];
const TECH_WORDS = ["ai", "ml", "llm", "infra", "infrastructure", "code", "coding", "eng", "engineer", "engineering", "hardware", "systems", "backend", "rust", "protocol", "cryptography", "robotics", "devtools", "compiler", "kernel", "data", "math"];

const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
/** Saturating curve: 0 at 0, 50 at n=half, asymptotes to 100. */
const saturate = (n: number, half: number) => (n <= 0 ? 0 : (100 * n) / (n + half));
/** Count word-boundary matches (so "ai" ⊄ "email", "vc" ⊄ "service"). */
function kwHits(text: string[], words: string[]): number {
  const hay = text.join(" ").toLowerCase();
  return words.reduce((n, w) => (new RegExp(`\\b${w}\\b`).test(hay) ? n + 1 : n), 0);
}

export function founderStats(s: FounderSnapshot): FounderStats {
  const tags = [...s.interests, ...s.mentorTopics];
  const capital = clamp(kwHits(tags, CAPITAL_WORDS) * 22 + saturate(s.points, 800) * 0.35);
  const technical = clamp((s.technical ? 45 : 0) + kwHits(tags, TECH_WORDS) * 14);
  const network = clamp(saturate(s.friends, 20) * 0.6 + saturate(s.introsMade, 4) * 0.4);
  const momentum = clamp(saturate(s.streakBest, 4) * 0.4 + saturate(s.shadows, 8) * 0.3 + saturate(s.checkins, 8) * 0.3);
  const reviewQuality = s.reviewAvg != null ? ((s.reviewAvg - 1) / 4) * 30 * Math.min(1, s.reviewCount / 3) : 0;
  const reach = clamp(Math.min(40, s.level * 4) + reviewQuality + saturate(s.points, 600) * 0.3);
  const power = clamp(capital * 0.2 + technical * 0.2 + network * 0.25 + momentum * 0.15 + reach * 0.2);
  const rarity: Rarity = power >= 85 ? "legendary" : power >= 70 ? "epic" : power >= 52 ? "rare" : power >= 32 ? "uncommon" : "common";
  return { capital, technical, network, momentum, reach, power, rarity };
}
