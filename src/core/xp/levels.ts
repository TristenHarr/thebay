/**
 * The Experience curve — the game's RPG-style leveling track, deliberately SEPARATE
 * from social `points` (which stays the credible "founder score"). XP comes from
 * movement, orbs, catches, crawls (and a nod from social actions) — see xp-repo.
 *
 * Pure + deterministic. Level n requires `100·(n-1)²` cumulative XP: the first
 * levels come fast, then it steepens. Everyone starts at level 1 with 0 XP. No I/O,
 * so it's identical on the Worker and in the browser (the level bar renders locally).
 */
const K = 100;

/** Cumulative XP required to REACH `level` (level 1 = 0). */
export function xpForLevel(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return K * (l - 1) * (l - 1);
}

/** The level for a cumulative XP total — the exact inverse of `xpForLevel`. */
export function levelForXp(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 1;
  return Math.floor(Math.sqrt(xp / K)) + 1;
}

export interface LevelProgress {
  level: number;
  xp: number; // total cumulative XP
  xpIntoLevel: number; // XP earned since reaching the current level
  xpForNext: number; // XP span of the current level (base→next)
  toNext: number; // XP remaining to the next level
  pct: number; // 0..1 progress within the current level
}

/** Everything the level bar needs from a raw XP total. */
export function levelProgress(xp: number): LevelProgress {
  const total = Math.max(0, Math.floor(xp || 0));
  const level = levelForXp(total);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const span = next - base;
  const into = total - base;
  return { level, xp: total, xpIntoLevel: into, xpForNext: span, toNext: next - total, pct: span ? into / span : 0 };
}
