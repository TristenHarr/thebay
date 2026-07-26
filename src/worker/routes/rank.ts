import { Hono } from "hono";
import { requireIngestToken } from "../middleware/bearer";
import type { Env, Vars } from "../env";
import { RankRepo } from "../../storage/d1/rank-repo";
import { requireAuth, optionalAuth } from "../../auth/middleware";
import { rankTick, trainSurface, type TrainResult } from "../../core/rank/train";
import { RankFeedbackSchema, RANK_SURFACES, RankSurfaceSchema } from "../../../shared/schema";
import { emptyFeatures } from "../../core/rank/features";
import { epsilonFrom } from "../../core/rank/explore";
import { rerank, eventToRankItem } from "../../core/rank/rerank";
import { D1Repo } from "../../storage/d1/d1-repo";
import { parseFilter } from "../event-filter";

/** Widest candidate window the personalized feed will rank over. Mirrors
 *  `SearchRepo`'s pool ceiling — past this the per-request cost stops being worth the
 *  extra recall. */
const POOL_MAX = 400;
/** How deep to record impressions. Logging a 400-row pool would mostly record rows nobody
 *  scrolled to, and a negative nobody could have seen is noise, not evidence. */
const LOG_TOP = 20;

/**
 * The learning loop's HTTP surface.
 *
 * Deliberately small. Three things the rest of the system cannot do for itself:
 *
 *   · `POST /api/rank/impressions` — what the client actually put on screen. This is the
 *     only genuinely new telemetry in the feature; the positive labels are joined from
 *     tables we already write (see `RankRepo.labelPending`).
 *   · `POST /api/rank/feedback` — the two signals no server-side table witnesses
 *     (`open`, `dismiss`).
 *   · `GET /api/rank/model` — what the live model is, what it scored, and what the last
 *     few candidates scored. An unattended loop needs a window, or "it stopped improving
 *     three weeks ago" is indistinguishable from "it is working fine".
 *
 * Plus the admin trigger, which shares its body with the cron exactly as
 * `enrichSlice` does, so an operator's manual run and the scheduled run cannot diverge.
 */
type App = Hono<{ Bindings: Env; Variables: Partial<Vars> }>;
const repo = (c: { env: Env }) => new RankRepo(c.env.DB);

export function rankRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  /**
   * The personalized events feed — the one surface where learning actually happens.
   *
   * A SEPARATE ENDPOINT rather than a new `sort=` on `/api/events`, deliberately. The
   * public catalog API is consumed by the static dashboard, the embed widget and
   * `events.json`, all of which depend on its documented `start_utc` ordering, and it is
   * unauthenticated so it must not pay for a session lookup. Personalization, exploration
   * and impression logging all live here instead, and `/api/events` is byte-identical to
   * what it was.
   *
   * Accepts the same filter grammar as `/api/events` (shared `parseFilter`), so a city or
   * category filter means the same thing on both.
   */
  app.get("/api/events/foryou", optionalAuth, async (c) => {
    const viewer = c.get("user")?.id ?? null;
    const filter = parseFilter(c.req.query());
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
    // Rank over a wider window than we return, then slice — the same approach
    // `NewsRepo.feed` takes, and for the same reason: the interesting signals are
    // per-viewer, so they can't live in an ORDER BY. Anything outside the pool is
    // invisible to personalization, so the pool is the real recall knob.
    const pool = Math.min(Math.max(limit * 4, 100), POOL_MAX);

    const { events, total, facets } = await new D1Repo(c.env.DB).queryEvents({
      ...filter,
      sort: "start",
      limit: pool,
      offset: 0,
    });
    const ids = events.map((e) => e.id);
    const r = repo(c);
    const [viewerCtx, engagement, seen, model] = await Promise.all([
      r.viewerContext(viewer),
      r.engagementCounts(ids, viewer),
      r.timesShown("events", viewer, ids),
      r.activeModel("events"),
    ]);

    const out = rerank({
      items: events,
      toRankItem: (e) => eventToRankItem(e, engagement.get(e.id)),
      viewer: viewerCtx,
      surface: "events",
      nowMs: Date.now(),
      weights: model?.weights ?? null,
      viewerId: viewer,
      // This endpoint is the one that opted into learning, so it is the one that explores.
      explore: true,
      epsilon: epsilonFrom(c.env.RANK_EPSILON),
      timesShown: seen,
    });

    const page = out.items.slice(0, limit);
    // Log what we SERVED, with the vectors that produced the ordering. The server is the
    // only party that knows them, which is why this is not a client responsibility.
    // Signed-in only: an anonymous row could never become a positive, and its exposure
    // count would be shared with every other anonymous visitor.
    if (page.length && viewer) {
      await r.logImpressions({
        surface: "events",
        viewerId: viewer,
        modelVersion: model ? `v${model.version}` : "v0",
        explored: out.explored,
        items: page.slice(0, LOG_TOP).map((e, i) => ({
          itemId: e.id,
          position: i,
          features: out.features.get(e.id) ?? emptyFeatures(),
        })),
      });
    }

    return c.json({
      events: page,
      total,
      facets,
      // Say plainly which regime produced this ordering. `rescored: false` means the
      // learned model is not live yet and this is the ordinary chronological feed.
      ranking: {
        model: model ? model.version : null,
        rescored: out.rescored,
        explored: out.explored,
        pool: events.length,
      },
    });
  });

  /** `open` / `dismiss` — the only feedback the server can't observe for itself. */
  app.post("/api/rank/feedback", requireAuth, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = RankFeedbackSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid feedback" }, 400);
    const { surface, itemId, kind } = parsed.data;
    const applied = await repo(c).recordFeedback(surface, c.get("user")!.id, itemId, kind);
    // `false` means we have no impression to attach it to — not an error, just nothing
    // to learn from. Reported honestly rather than as a silent 200.
    return c.json({ ok: true, applied });
  });

  /**
   * What is live, and what the loop has been doing.
   *
   * Public (`optionalAuth`) and read-only: the weights are not a secret, and being able
   * to see why a feed is ordered the way it is beats asking people to trust it.
   */
  app.get("/api/rank/model", optionalAuth, async (c) => {
    const asked = RankSurfaceSchema.safeParse(c.req.query("surface"));
    const surfaces = asked.success ? [asked.data] : [...RANK_SURFACES];
    const out: Record<string, unknown> = {};
    for (const surface of surfaces) {
      const live = await repo(c).activeModel(surface);
      const counts = await repo(c).countLabeled(surface);
      out[surface] = {
        // `null` means the passthrough: no learned model, ordering is the hand-tuned
        // fusion exactly as it has always been.
        live: live
          ? {
              version: live.version,
              weights: live.weights,
              rrf: live.rrf,
              holdoutAuc: live.holdoutAuc,
              incumbentAuc: live.incumbentAuc,
              trainedAt: live.trainedAt,
              promotedAt: live.promotedAt,
              nRows: live.nRows,
            }
          : null,
        labelled: counts,
        recent: (await repo(c).recentModels(surface, 5)).map((m) => ({
          version: m.version,
          holdoutAuc: m.holdoutAuc,
          incumbentAuc: m.incumbentAuc,
          promoted: !!m.promotedAt,
          trainedAt: m.trainedAt,
        })),
      };
    }
    return c.json(out);
  });

  /** Admin: run the loop now. Same code path as the cron. */
  app.post("/api/admin/rank/train", requireIngestToken, async (c) => {
    const asked = RankSurfaceSchema.safeParse(c.req.query("surface"));
    const results: TrainResult[] = asked.success
      ? [await trainSurface(repo(c), asked.data)]
      : await rankTick(repo(c));
    return c.json({ ok: true, results });
  });

  /** Admin: enforce retention now rather than waiting for a tick. */
  app.post("/api/admin/rank/gc", requireIngestToken, async (c) => {
    return c.json({ ok: true, deleted: await repo(c).gc() });
  });

  return app;
}
