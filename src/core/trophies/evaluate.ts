/**
 * The trophy evaluator — pure, total, and the single decider of what is earned.
 *
 * Both sides run this function. The Worker runs it to decide what to GRANT; the
 * browser runs it (or renders its output) to draw the trophy case. That is the same
 * arrangement as `src/core/xp/levels.ts`, and for the same reason: a progress bar
 * that says "8/10 check-ins" must be computed by the code that will actually fire
 * the award, or the two drift and the UI starts lying.
 *
 * TOTAL means no input can throw. Metric snapshots are assembled from ~20 SQL
 * aggregates; a single NULL that slips through as NaN must degrade to "not earned,
 * 0% progress", never to a 500 on the achievements screen or — worse — a NaN width
 * on a progress bar. Every value is sanitised once, at the top, and the rest of the
 * function can then assume a non-negative number.
 */
import { TROPHIES, TROPHY_METRICS, type Trophy, type TrophyMetric } from "./catalog";

export type TrophyMetrics = Record<TrophyMetric, number>;

/** A zeroed snapshot. Every metric present, so a missing key is a type error rather
 *  than a silent `undefined >= threshold` (which is always false, and always a bug). */
export function emptyMetrics(): TrophyMetrics {
  const m = {} as TrophyMetrics;
  for (const k of TROPHY_METRICS) m[k] = 0;
  return m;
}

export interface TrophyProgress {
  id: string;
  series: string;
  tier: number;
  earned: boolean;
  /** The sanitised metric value this was judged against. */
  value: number;
  threshold: number;
  /** 0..1, always finite. */
  pct: number;
  /** How much more of `metric` is needed. 0 once earned. */
  remaining: number;
}

export interface TrophyEvaluation {
  /** Ids to grant, in catalog order. */
  earned: string[];
  /** Every trophy, earned or not — the trophy case renders locked rungs from this. */
  progress: TrophyProgress[];
  /** The three closest unearned trophies. Never includes a secret. */
  nextUp: TrophyProgress[];
  /** Total XP the earned set is worth. */
  xp: number;
}

/** NaN → 0, negatives → 0, Infinity kept (it legitimately clears any threshold).
 *  Sanitising here is what makes every downstream number finite. */
function clean(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x > 0 ? x : 0;
}

function judge(t: Trophy, m: TrophyMetrics): TrophyProgress {
  const value = clean(m[t.metric] ?? 0);
  const earned = value >= t.threshold;
  // `threshold` is always >= 1 in the catalog, so this never divides by zero; the
  // min() is what keeps Infinity from producing a pct above 1.
  const pct = earned ? 1 : Math.min(1, Math.max(0, value / t.threshold));
  return {
    id: t.id,
    series: t.series,
    tier: t.tier,
    earned,
    value,
    threshold: t.threshold,
    pct,
    remaining: earned ? 0 : Math.max(0, t.threshold - value),
  };
}

/** How many trophies to suggest. Three is enough to feel achievable and few enough
 *  that the list reads as a goal rather than a backlog. */
const NEXT_UP = 3;

export function evaluate(m: TrophyMetrics): TrophyEvaluation {
  const progress = TROPHIES.map((t) => judge(t, m));

  const earned: string[] = [];
  let xp = 0;
  for (let i = 0; i < TROPHIES.length; i++) {
    if (progress[i]!.earned) {
      earned.push(TROPHIES[i]!.id);
      xp += TROPHIES[i]!.xp;
    }
  }

  // Closest first. Secrets are excluded entirely — suggesting one would spoil it,
  // which is the only thing a secret trophy has going for it.
  const nextUp = progress
    .filter((p, i) => !p.earned && !TROPHIES[i]!.secret)
    .sort((a, b) => b.pct - a.pct || a.remaining - b.remaining)
    .slice(0, NEXT_UP);

  return { earned, progress, nextUp, xp };
}
