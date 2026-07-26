/**
 * The training tick — one bounded, unattended pass per surface.
 *
 * Coordination only: the arithmetic lives in `model.ts` and the SQL in `rank-repo.ts`.
 * It takes a `RankRepo` rather than a `D1Database` so the whole decision procedure —
 * including every way it can decline to promote — is testable with a fake repo and no
 * database at all.
 *
 * THE HOLDOUT IS A TIME SPLIT, NOT A RANDOM ONE. Ranking is a forecasting problem: the
 * question is "will this model do well on tomorrow's traffic", and a random split answers
 * a different and easier question, because rows from the same session land on both sides
 * and leak. Training on the older rows and evaluating on the newest ones is the only
 * split that can catch a model that has learned a fad.
 *
 * Every path through this function ends in a `saveModel` call, including the ones that
 * refuse to promote. A cron that silently declines is indistinguishable from a cron that
 * silently died, so the rejections are written down with their reasons.
 */
import type { RankSurface } from "../../../shared/schema";
import type { RankRepo } from "../../storage/d1/rank-repo";
import { DEFAULT_WEIGHTS } from "../search/rank";
import {
  evaluate,
  rowWeight,
  shouldPromote,
  trainLogistic,
  MIN_TRAINING_ROWS,
  type Evaluation,
  type TrainingRow,
  type Weights,
} from "./model";

/** Fraction of the newest rows held back for evaluation. */
export const HOLDOUT_FRACTION = 0.2;
/** Below this the split is meaningless, whatever `MIN_TRAINING_ROWS` says. */
const MIN_HOLDOUT = 50;

export interface TrainResult {
  surface: RankSurface;
  /** Labelled rows available. */
  rows: number;
  /** Whether a model was fitted at all (false = not enough data yet). */
  trained: boolean;
  promoted: boolean;
  reason: string;
  candidateAuc: number | null;
  incumbentAuc: number | null;
  /** The version written, or null when nothing was written. */
  version: number | null;
}

export interface TrainSurfaceOpts {
  minRows?: number;
  holdoutFraction?: number;
  /** Overrides for the promotion thresholds — used by tests, not by the cron. */
  gate?: { minRows?: number; minPositives?: number; minGain?: number; minAuc?: number };
  /** The clock, injected so a training run is reproducible against fixed data —
   *  the same discipline the rest of `src/core` follows. */
  now?: Date;
  /** How far back to read labelled rows. */
  sinceDays?: number;
}

/**
 * Train one surface and decide whether the result deserves to go live.
 *
 * Returns rather than throws: this runs on a cron next to two other jobs, and a surface
 * with no data is the normal case for weeks after launch, not an error.
 */
export async function trainSurface(
  repo: RankRepo,
  surface: RankSurface,
  opts: TrainSurfaceOpts = {},
): Promise<TrainResult> {
  const minRows = opts.minRows ?? MIN_TRAINING_ROWS;
  const holdoutFraction = clampFraction(opts.holdoutFraction ?? HOLDOUT_FRACTION);

  const raw = await repo.trainingRows(surface, { now: opts.now, sinceDays: opts.sinceDays });
  const base: TrainResult = {
    surface,
    rows: raw.length,
    trained: false,
    promoted: false,
    reason: "",
    candidateAuc: null,
    incumbentAuc: null,
    version: null,
  };

  if (raw.length < minRows) {
    // The expected state early on. Nothing is written — there is nothing to say yet.
    return { ...base, reason: `waiting for data (${raw.length}/${minRows} labelled rows)` };
  }

  // Row importance = how much this engagement kind counts × inverse propensity of the
  // slot it was served in. Both corrections, in one number, computed once.
  const rows: TrainingRow[] = raw.map((r) => ({
    features: r.features,
    label: r.label,
    weight: rowWeight(r.labelKind, r.propensity),
  }));

  // `trainingRows` comes back newest-first, so the head is the future.
  const holdoutSize = Math.max(MIN_HOLDOUT, Math.floor(rows.length * holdoutFraction));
  if (rows.length - holdoutSize < minRows / 2) {
    return { ...base, reason: `not enough history to hold out (${rows.length} rows)` };
  }
  const holdout = rows.slice(0, holdoutSize);
  const train = rows.slice(holdoutSize);

  const weights = trainLogistic(train, surface);
  const candidate = evaluate(holdout, weights);

  const incumbent = await repo.activeModel(surface);
  // Score the incumbent on the SAME holdout. Comparing against the AUC stored on the
  // incumbent's own row would compare two different questions on two different slices.
  const incumbentEval: Evaluation | null = incumbent ? evaluate(holdout, incumbent.weights) : null;

  const decision = shouldPromote(candidate, incumbentEval, opts.gate);

  const saved = await repo.saveModel({
    surface,
    weights,
    rrf: rrfFor(incumbent?.rrf),
    nRows: train.length,
    holdoutAuc: candidate.auc,
    incumbentAuc: incumbentEval?.auc ?? null,
    promote: decision.promote,
    notes: decision.reason,
  });

  return {
    surface,
    rows: raw.length,
    trained: true,
    promoted: decision.promote,
    reason: decision.reason,
    candidateAuc: candidate.auc,
    incumbentAuc: incumbentEval?.auc ?? null,
    version: saved.version,
  };
}

/**
 * The RRF list weights carried onto the new model row.
 *
 * The fusion weights are NOT learned yet — this loop trains the rescoring stage only, so
 * every model inherits whatever fusion the incumbent used, defaulting to the hand-tuned
 * values in `core/search/rank.ts`. Storing them alongside the learned weights means the
 * row is a complete description of a serving policy, which is what makes an old
 * impression's `model_version` interpretable later.
 */
function rrfFor(previous: Record<string, number> | undefined): Record<string, number> {
  if (previous && Object.keys(previous).length) return previous;
  return { ...DEFAULT_WEIGHTS };
}

function clampFraction(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return HOLDOUT_FRACTION;
  return Math.min(0.5, x);
}

/** Label, then train, for every surface. The shape the cron calls. */
export async function rankTick(
  repo: RankRepo,
  surfaces: readonly RankSurface[] = ["events", "news", "shadows"],
  opts: TrainSurfaceOpts = {},
): Promise<TrainResult[]> {
  const out: TrainResult[] = [];
  for (const surface of surfaces) {
    await repo.labelPending(surface, 2000, opts.now ?? new Date());
    out.push(await trainSurface(repo, surface, opts));
  }
  return out;
}
