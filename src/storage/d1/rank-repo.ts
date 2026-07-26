import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import type { RankSurface } from "../../../shared/schema";
import { ANON_VIEWER, saturate, type FeatureVector, type ViewerCtx } from "../../core/rank/features";
import { sanitizeWeights, type Weights } from "../../core/rank/model";
import { positionPropensity } from "../../core/rank/explore";
import { FRIEND_IDS_SQL } from "./social-repo";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

/**
 * RankRepo — the impression log and the model registry.
 *
 * Two jobs, and the interesting one is LABELLING. We never asked the client to tell us
 * what a user engaged with, because it already told the database: an RSVP is a row in
 * `rsvps`, an attendance is a row in `checkins`, a vote is a row in `story_votes`. So
 * labelling is a join, not an instrumentation project — which is also why it is robust,
 * since a signal that was written by the feature that owns it cannot drift out of sync
 * with a separate analytics path.
 *
 * What the join needs and did not exist before migration 0024 is the DENOMINATOR: the
 * things we put on screen that nobody touched. Those are the negatives, and without them
 * there is nothing for a classifier to separate.
 */

/** How long to wait before calling an un-engaged impression a negative. Labelling
 *  something a negative sixty seconds after showing it just teaches the model that
 *  everything is a negative — the user hadn't decided yet. */
export const SETTLE_HOURS = 6;

/** Retention. An impression log is behavioural data about identifiable people; it is
 *  kept because it is load-bearing for the ranker, and no longer. */
export const RETENTION_DAYS = 30;

/**
 * Engagement counts at which an affinity is "half strength".
 *
 * Deliberately small. Two events on a topic is a real preference; requiring twenty would
 * mean nobody has an affinity for their first month and the personalized feed would be
 * indistinguishable from the global one exactly when a new user is deciding whether to
 * come back. Authors need a slightly higher bar than topics because attending one
 * organizer's event twice is weaker evidence than caring about a subject twice.
 */
export const AFFINITY_HALF = { tag: 2, author: 3 } as const;

/** `[{k, n}]` → a `k → [0,1]` affinity map via the same saturating curve the features use. */
function affinityMap(rows: readonly Row[], half: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = r.k;
    if (typeof k !== "string" || !k) continue;
    out.set(k.toLowerCase(), saturate(Number(r.n ?? 0), half));
  }
  return out;
}

/**
 * The label ladder, strongest first.
 *
 * A later, stronger signal must be able to overwrite a weaker one: someone who opens an
 * event, then RSVPs, then actually turns up should end up labelled `checkin`, not `open`.
 * Each rung lists the labels it is allowed to overwrite; nothing may overwrite a rung at
 * or above itself, so the ladder can be re-run any number of times and converges.
 */
interface Rung {
  kind: string;
  /** 1 = engaged, 0 = an explicit negative. */
  label: 0 | 1;
  /** `EXISTS (...)` body. `I` is the alias for the impression row. */
  exists: string;
  /** Which existing label_kinds this rung may replace. */
  overwrites: string[];
}

const LADDER: Record<RankSurface, Rung[]> = {
  events: [
    {
      kind: "checkin",
      label: 1,
      exists:
        "SELECT 1 FROM checkins c WHERE c.user_id = I.viewer_id AND c.event_id = I.item_id AND c.at >= I.served_at",
      overwrites: ["none", "open", "dismiss", "rsvp"],
    },
    {
      kind: "rsvp",
      label: 1,
      exists:
        "SELECT 1 FROM rsvps r WHERE r.user_id = I.viewer_id AND r.event_id = I.item_id AND r.created_at >= I.served_at AND r.status IN ('going','interested','went')",
      overwrites: ["none", "open", "dismiss"],
    },
  ],
  news: [
    {
      kind: "comment",
      label: 1,
      exists:
        "SELECT 1 FROM comments cm WHERE cm.author_id = I.viewer_id AND cm.story_id = I.item_id AND cm.created_at >= I.served_at",
      overwrites: ["none", "open", "dismiss", "vote"],
    },
    {
      kind: "vote",
      label: 1,
      exists:
        "SELECT 1 FROM story_votes v WHERE v.user_id = I.viewer_id AND v.story_id = I.item_id AND v.created_at >= I.served_at",
      overwrites: ["none", "open", "dismiss"],
    },
  ],
  shadows: [
    {
      kind: "reaction",
      label: 1,
      exists:
        "SELECT 1 FROM shadow_reactions sr WHERE sr.user_id = I.viewer_id AND sr.shadow_id = I.item_id AND sr.created_at >= I.served_at",
      overwrites: ["none", "open", "dismiss"],
    },
  ],
};

export interface ImpressionInput {
  itemId: string;
  position: number;
  features: FeatureVector;
}

export interface LogImpressionsInput {
  surface: RankSurface;
  /** Signed-in only — see the note on `rank_impressions.viewer_id` in 0024. */
  viewerId: string;
  modelVersion: string;
  explored: boolean;
  items: readonly ImpressionInput[];
  now?: Date;
}

export interface TrainingRowRow {
  features: FeatureVector;
  label: 0 | 1;
  labelKind: string | null;
  propensity: number;
  explored: boolean;
}

export interface StoredModel {
  id: string;
  surface: RankSurface;
  version: number;
  weights: Weights;
  rrf: Record<string, number>;
  nRows: number;
  holdoutAuc: number | null;
  incumbentAuc: number | null;
  trainedAt: string;
  promotedAt: string | null;
}

export class RankRepo {
  constructor(private db: D1Database) {}

  /* ── serving side ─────────────────────────────────────────────────────────── */

  /**
   * Record what we put on screen.
   *
   * Idempotent per (surface, viewer, item, day) via `dedup_key`, exactly as
   * `points_ledger` and `xp_ledger` are: a user scrolling up and down must not
   * manufacture training rows. A repeat is not discarded though — it bumps
   * `times_shown`, which is the input to the fatigue rescorer, so re-exposure stays
   * observable while the training row stays single.
   */
  async logImpressions(input: LogImpressionsInput): Promise<number> {
    const { surface, viewerId, modelVersion, explored, items } = input;
    if (!items.length) return 0;
    const now = input.now ?? new Date();
    const ts = now.toISOString();
    const day = ts.slice(0, 10);

    const stmts = items.map((it) =>
      this.db
        .prepare(
          `INSERT INTO rank_impressions
             (id, surface, viewer_id, item_id, position, times_shown, model_version,
              features_json, explored, propensity, served_at, dedup_key)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(dedup_key) DO UPDATE SET times_shown = times_shown + 1`,
        )
        .bind(
          ulid(),
          surface,
          viewerId,
          it.itemId,
          Math.max(0, Math.round(it.position)),
          modelVersion,
          JSON.stringify(it.features),
          explored ? 1 : 0,
          positionPropensity(it.position),
          ts,
          `${surface}:${viewerId}:${it.itemId}:${day}`,
        ),
    );

    await this.db.batch(stmts as any);
    return items.length;
  }

  /** How many times this viewer has already seen each of these items — the fatigue
   *  input. One query for the whole candidate set, never one per candidate. */
  async timesShown(surface: RankSurface, viewerId: string | null, itemIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    // No viewer means no personal exposure history. Returning an empty map rather than
    // querying is not just an optimisation: there is no such thing as a shared
    // "anonymous" exposure count, and pretending otherwise would fatigue-suppress
    // popular items for someone seeing them for the first time.
    if (!itemIds.length || !viewerId) return out;
    // D1 caps bind parameters at 100; chunk well inside it.
    for (let i = 0; i < itemIds.length; i += 80) {
      const chunk = itemIds.slice(i, i + 80);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await this.db
        .prepare(
          `SELECT item_id, SUM(times_shown) AS n FROM rank_impressions
            WHERE surface = ? AND viewer_id = ? AND item_id IN (${placeholders})
            GROUP BY item_id`,
        )
        .bind(surface, viewerId, ...chunk)
        .all<Row>();
      for (const r of rows.results ?? []) out.set(String(r.item_id), Number(r.n ?? 0));
    }
    return out;
  }

  /**
   * Everything about a viewer that the feature extractor needs, in three queries.
   *
   * Built ONCE per request, never per candidate — a feature that costs a query is a
   * feature that will be quietly dropped the first time the feed gets slow.
   *
   * Affinity is derived from what someone actually did (RSVP'd to, or turned up at), not
   * from anything they declared. `match_prefs.interests_json` exists and is a statement
   * of intent; a check-in is evidence. Both are useful but they are not the same thing,
   * and behaviour is the one that keeps working when someone's taste drifts and they
   * never go back to edit a form.
   *
   * Keyed on `events.categories` (topic slugs) because that is what the candidate rows
   * carry — `event_tags` is the richer truth, but joining it per candidate would cost a
   * query the extractor cannot afford, and the topic facet is write-through'd to
   * `categories` precisely so cheap readers can use it.
   */
  async viewerContext(userId: string | null): Promise<ViewerCtx> {
    if (!userId) return ANON_VIEWER;

    // "Events this person engaged with" — the shared basis for both event-side maps.
    const engaged = `SELECT event_id FROM rsvps WHERE user_id = ?
                     UNION SELECT event_id FROM checkins WHERE user_id = ?`;
    // "Stories this person engaged with" — same idea on the news side.
    const read = `SELECT story_id FROM story_votes WHERE user_id = ?
                  UNION SELECT story_id FROM comments WHERE author_id = ?`;

    /**
     * TAG AFFINITY IS UNIONED ACROSS BOTH SITES, and that is the point of the monorepo
     * rather than an accident of it. Event `categories` and story `topics` share slugs
     * for the concepts that matter here (hardware, ai, math, …), so someone who has been
     * to three hardware events starts with a hardware affinity on the news front page —
     * on their first visit, before they have voted on anything. Keeping the two apart
     * would make every reader cold-start twice.
     */
    const tags = await this.db
      .prepare(
        `SELECT k, SUM(n) AS n FROM (
           SELECT je.value AS k, COUNT(*) AS n
             FROM events e, json_each(e.categories) je
            WHERE e.id IN (${engaged})
            GROUP BY je.value
           UNION ALL
           SELECT jt.value AS k, COUNT(*) AS n
             FROM stories s, json_each(s.topics_json) jt
            WHERE s.id IN (${read})
            GROUP BY jt.value
         ) GROUP BY k`,
      )
      .bind(userId, userId, userId, userId)
      .all<Row>();

    /**
     * AUTHOR AFFINITY IS NOT UNIONED. An event's author is an organizer ("Frontier
     * Tower"); a story's is its ORIGIN ("hn", "lobsters"). Those are different kinds of
     * thing in one namespace, and merging them would let a source named like a venue
     * collide with it. Both are still returned in one map because the two surfaces draw
     * from disjoint key spaces in practice, and each only ever looks up its own.
     */
    const authors = await this.db
      .prepare(
        `SELECT k, SUM(n) AS n FROM (
           SELECT e.organizer AS k, COUNT(*) AS n
             FROM events e
            WHERE e.organizer IS NOT NULL AND e.organizer <> '' AND e.id IN (${engaged})
            GROUP BY e.organizer
           UNION ALL
           SELECT s.origin AS k, COUNT(*) AS n
             FROM stories s
            WHERE s.id IN (${read})
            GROUP BY s.origin
         ) GROUP BY k`,
      )
      .bind(userId, userId, userId, userId)
      .all<Row>();

    const checkins = await this.db
      .prepare("SELECT COUNT(*) AS n FROM checkins WHERE user_id = ?")
      .bind(userId)
      .first<Row>();

    return {
      tagAffinity: affinityMap(tags.results ?? [], AFFINITY_HALF.tag),
      authorAffinity: affinityMap(authors.results ?? [], AFFINITY_HALF.author),
      checkins: Number(checkins?.n ?? 0),
    };
  }

  /**
   * Per-candidate engagement counts: how many people are going, and how many of them are
   * the viewer's friends.
   *
   * Two chunked queries for the whole candidate set. The friend count is the one signal a
   * global site structurally cannot have, which is why `src/news/rank.ts` already weights
   * a friend's vote at 2× a stranger's — this is the same idea for events.
   */
  async engagementCounts(
    itemIds: readonly string[],
    viewerId: string | null,
  ): Promise<Map<string, { total: number; friends: number }>> {
    const out = new Map<string, { total: number; friends: number }>();
    if (!itemIds.length) return out;

    for (let i = 0; i < itemIds.length; i += 60) {
      const chunk = itemIds.slice(i, i + 60);
      const ph = chunk.map(() => "?").join(",");

      const totals = await this.db
        .prepare(
          `SELECT event_id, COUNT(*) AS n FROM rsvps
            WHERE event_id IN (${ph}) AND status IN ('going','interested','went')
            GROUP BY event_id`,
        )
        .bind(...chunk)
        .all<Row>();
      for (const r of totals.results ?? []) {
        out.set(String(r.event_id), { total: Number(r.n ?? 0), friends: 0 });
      }

      if (!viewerId) continue;
      const friends = await this.db
        .prepare(
          `SELECT event_id, COUNT(*) AS n FROM rsvps
            WHERE event_id IN (${ph}) AND status IN ('going','interested','went')
              AND user_id IN (${FRIEND_IDS_SQL})
            GROUP BY event_id`,
        )
        .bind(...chunk, viewerId, viewerId, viewerId)
        .all<Row>();
      for (const r of friends.results ?? []) {
        const id = String(r.event_id);
        const prev = out.get(id) ?? { total: 0, friends: 0 };
        out.set(id, { ...prev, friends: Number(r.n ?? 0) });
      }
    }
    return out;
  }

  /** Client-only feedback (`open` / `dismiss`). Applied to the most recent impression
   *  of that item, and never over a stronger label the ladder already assigned. */
  async recordFeedback(
    surface: RankSurface,
    viewerId: string,
    itemId: string,
    kind: "open" | "dismiss",
  ): Promise<boolean> {
    const r: any = await this.db
      .prepare(
        `UPDATE rank_impressions
            SET label = ?, label_kind = ?, labeled_at = ?
          WHERE id = (
            SELECT id FROM rank_impressions
             WHERE surface = ? AND viewer_id = ? AND item_id = ?
               AND (label_kind IS NULL OR label_kind IN ('none','open','dismiss'))
             ORDER BY served_at DESC LIMIT 1
          )`,
      )
      .bind(kind === "open" ? 1 : 0, kind, nowIso(), surface, viewerId, itemId)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }

  /* ── labelling ────────────────────────────────────────────────────────────── */

  /**
   * Walk the ladder for one surface, then settle the leftovers as negatives.
   *
   * Bounded and idempotent, so it is safe on a cron: every statement is `LIMIT`ed and
   * re-running changes nothing once converged.
   */
  async labelPending(surface: RankSurface, limit = 2000, now: Date = new Date()): Promise<{ labeled: number; settled: number }> {
    const nowMs = now.getTime();
    const settleBefore = new Date(nowMs - SETTLE_HOURS * 3_600_000).toISOString();
    const ts = now.toISOString();
    let labeled = 0;

    for (const rung of LADDER[surface]) {
      const overwrite = rung.overwrites.map(() => "?").join(",");
      const r: any = await this.db
        .prepare(
          `UPDATE rank_impressions
              SET label = ?, label_kind = ?, labeled_at = ?
            WHERE id IN (
              SELECT I.id FROM rank_impressions I
               WHERE I.surface = ?
                 AND (I.label_kind IS NULL OR I.label_kind IN (${overwrite}))
                 AND EXISTS (${rung.exists})
               LIMIT ?
            )`,
        )
        .bind(rung.label, rung.kind, ts, surface, ...rung.overwrites, limit)
        .run();
      labeled += r.meta?.changes ?? 0;
    }

    // Everything still unlabelled and old enough to have been acted on is a real
    // negative. This is the denominator the whole model depends on.
    const s: any = await this.db
      .prepare(
        `UPDATE rank_impressions
            SET label = 0, label_kind = 'none', labeled_at = ?
          WHERE id IN (
            SELECT id FROM rank_impressions
             WHERE surface = ? AND label IS NULL AND served_at < ?
             LIMIT ?
          )`,
      )
      .bind(ts, surface, settleBefore, limit)
      .run();

    return { labeled, settled: s.meta?.changes ?? 0 };
  }

  /* ── training side ────────────────────────────────────────────────────────── */

  /**
   * The labelled training set, newest first.
   *
   * `features_json` is read back as stored rather than recomputed: the extractor's
   * output changes meaning as the code evolves, and recomputing would pair today's
   * features with a label that answered a different question.
   */
  async trainingRows(
    surface: RankSurface,
    opts: { limit?: number; sinceDays?: number; now?: Date } = {},
  ): Promise<TrainingRowRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20_000, 1), 100_000);
    const nowMs = (opts.now ?? new Date()).getTime();
    const since = new Date(nowMs - (opts.sinceDays ?? RETENTION_DAYS) * 86_400_000).toISOString();
    const rows = await this.db
      .prepare(
        `SELECT features_json, label, label_kind, propensity, explored
           FROM rank_impressions
          WHERE surface = ? AND label IS NOT NULL AND served_at >= ?
          ORDER BY served_at DESC LIMIT ?`,
      )
      .bind(surface, since, limit)
      .all<Row>();

    const out: TrainingRowRow[] = [];
    for (const r of rows.results ?? []) {
      const features = parseFeatures(r.features_json);
      if (!features) continue; // a corrupt row is skipped, never allowed to poison a batch
      out.push({
        features,
        label: Number(r.label) === 1 ? 1 : 0,
        labelKind: r.label_kind ?? null,
        propensity: Number(r.propensity) > 0 ? Number(r.propensity) : 1,
        explored: Number(r.explored) === 1,
      });
    }
    return out;
  }

  async countLabeled(surface: RankSurface): Promise<{ total: number; positives: number }> {
    const r = await this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(label), 0) AS positives
           FROM rank_impressions WHERE surface = ? AND label IS NOT NULL`,
      )
      .bind(surface)
      .first<Row>();
    return { total: Number(r?.total ?? 0), positives: Number(r?.positives ?? 0) };
  }

  /* ── the model registry ───────────────────────────────────────────────────── */

  /** Append a trained candidate. `promotedAt` is set only by a caller that has already
   *  run the gate — and the schema refuses a promotion with no holdout score. */
  async saveModel(m: {
    surface: RankSurface;
    weights: Weights;
    rrf: Record<string, number>;
    nRows: number;
    holdoutAuc: number | null;
    incumbentAuc: number | null;
    promote: boolean;
    notes?: string;
  }): Promise<StoredModel> {
    const ts = nowIso();
    const version = (await this.maxVersion(m.surface)) + 1;
    const id = ulid();
    await this.db
      .prepare(
        `INSERT INTO rank_models
           (id, surface, version, weights_json, rrf_json, n_rows, holdout_auc,
            incumbent_auc, trained_at, promoted_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        m.surface,
        version,
        JSON.stringify(m.weights),
        JSON.stringify(m.rrf),
        Math.max(0, Math.round(m.nRows)),
        m.holdoutAuc,
        m.incumbentAuc,
        ts,
        m.promote ? ts : null,
        m.notes ?? null,
      )
      .run();
    return {
      id,
      surface: m.surface,
      version,
      weights: m.weights,
      rrf: m.rrf,
      nRows: m.nRows,
      holdoutAuc: m.holdoutAuc,
      incumbentAuc: m.incumbentAuc,
      trainedAt: ts,
      promotedAt: m.promote ? ts : null,
    };
  }

  private async maxVersion(surface: RankSurface): Promise<number> {
    const r = await this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM rank_models WHERE surface = ?")
      .bind(surface)
      .first<Row>();
    return Number(r?.v ?? 0);
  }

  /** The live model: the highest promoted version. `null` means "no model yet", which
   *  the serving path treats as a passthrough — see `shouldRescore`. */
  async activeModel(surface: RankSurface): Promise<StoredModel | null> {
    const r = await this.db
      .prepare(
        `SELECT * FROM rank_models
          WHERE surface = ? AND promoted_at IS NOT NULL
          ORDER BY version DESC LIMIT 1`,
      )
      .bind(surface)
      .first<Row>();
    return r ? hydrateModel(r) : null;
  }

  /** Recent candidates, promoted or not — what `GET /api/rank/model` shows an operator
   *  so a run of rejections is visible rather than silent. */
  async recentModels(surface: RankSurface, limit = 10): Promise<StoredModel[]> {
    const rows = await this.db
      .prepare("SELECT * FROM rank_models WHERE surface = ? ORDER BY version DESC LIMIT ?")
      .bind(surface, Math.min(Math.max(limit, 1), 100))
      .all<Row>();
    return (rows.results ?? []).map(hydrateModel);
  }

  /* ── housekeeping ─────────────────────────────────────────────────────────── */

  /** Drop impressions past the retention window. Bounded so one tick can't stall a cron. */
  async gc(days = RETENTION_DAYS, limit = 5000, now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const r: any = await this.db
      .prepare(
        `DELETE FROM rank_impressions WHERE id IN (
           SELECT id FROM rank_impressions WHERE served_at < ? LIMIT ?
         )`,
      )
      .bind(cutoff, limit)
      .run();
    return r.meta?.changes ?? 0;
  }
}

function parseFeatures(raw: unknown): FeatureVector | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as FeatureVector;
  } catch {
    return null;
  }
}

function hydrateModel(r: Row): StoredModel {
  let rrf: Record<string, number> = {};
  try {
    const parsed = JSON.parse(String(r.rrf_json ?? "{}"));
    if (parsed && typeof parsed === "object") rrf = parsed as Record<string, number>;
  } catch {
    /* a corrupt rrf blob falls back to the defaults in core/search/rank.ts */
  }
  return {
    id: r.id,
    surface: r.surface,
    version: Number(r.version),
    weights: sanitizeWeights(safeJson(r.weights_json)),
    rrf,
    nRows: Number(r.n_rows ?? 0),
    holdoutAuc: r.holdout_auc == null ? null : Number(r.holdout_auc),
    incumbentAuc: r.incumbent_auc == null ? null : Number(r.incumbent_auc),
    trainedAt: r.trained_at,
    promotedAt: r.promoted_at ?? null,
  };
}

function safeJson(raw: unknown): unknown {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
