import type { D1Database } from "@cloudflare/workers-types";
import {
  VIBE_AXES,
  blendVibe,
  baselinePredict,
  clampAxis,
  clampAxes,
  deriveBestFor,
  deriveExpect,
  templateHeadline,
  templateBlurb,
  normalizeCrowd,
  meanAxes,
  HOST_MIN_EVENTS,
  type CrowdMix,
  type EventFacts,
  type HostTrackRecord,
  type VibeAxes,
  type VibeAxis,
  type VibePrediction,
  type VibeSource,
} from "../../core/vibe";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();

/** D1 rejects statements with more than 100 bound parameters; 90 is the house
 *  chunk size (see D1Repo.chunk / NewsRepo.attachSources). */
const CHUNK = 90;
/** Hard ceiling on tag filters so a hostile query can't blow the bind cap. */
const MAX_TAG_FILTERS = 8;

/** SQL column per axis — the axes are camelCase in the domain, snake in the table. */
const AXIS_COL: Record<VibeAxis, string> = {
  energy: "energy",
  formality: "formality",
  intimacy: "intimacy",
  talkRatio: "talk_ratio",
  signal: "signal",
  approachability: "approachability",
};

/** What the client renders. `source` + `nReports` are the honesty contract: a
 *  'predicted' card has never been in front of an attendee. */
export interface VibeCard {
  eventId: string;
  axes: VibeAxes;
  headline: string;
  blurb: string;
  bestFor: string[];
  expect: string[];
  crowd: CrowdMix;
  source: VibeSource;
  confidence: number;
  /** VERIFIED reports only. Never a prediction dressed up as agreement. */
  nReports: number;
  /** Which model wrote the prose. null ⇒ the deterministic template did. */
  model: string | null;
  updatedAt: string;
}

/** One attendee's slider card. `verified` is decided by the server. */
export interface VibeReportInput extends Partial<VibeAxes> {
  crowd?: CrowdMix | null;
  tags?: string[] | null;
  worthIt?: number | null;
}

export interface StoredVibeReport extends Partial<VibeAxes> {
  userId: string;
  verified: boolean;
  crowd: CrowdMix;
  tags: string[];
  worthIt: number | null;
  createdAt: string;
}

export interface VibeSearchFilters {
  min?: Partial<VibeAxes>;
  max?: Partial<VibeAxes>;
  bestFor?: string[];
  source?: VibeSource[];
  minReports?: number;
  limit?: number;
}

const safeArr = (s: unknown): string[] => {
  if (typeof s !== "string") return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
};
const safeObj = (s: unknown): Record<string, unknown> => {
  if (typeof s !== "string") return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
};
/** The facts columns every card read joins in — the prose fallback needs them. */
const FACT_COLS = "e.title, e.description, e.categories, e.city, e.venue_name, e.organizer, e.is_free, e.price_text, e.start_utc";

function rowFacts(r: Row): EventFacts {
  return {
    title: r.title ?? "",
    description: r.description ?? null,
    categories: safeArr(r.categories),
    city: r.city ?? null,
    venueName: r.venue_name ?? null,
    organizer: r.organizer ?? null,
    isFree: r.is_free == null ? null : !!r.is_free,
    priceText: r.price_text ?? null,
    startUtc: r.start_utc ?? null,
  };
}

/**
 * VibeRepo — storage for predicted + crowd-reported event vibes.
 *
 * Thin by design: all of the arithmetic lives in `src/core/vibe.ts`, all of the
 * bounds live in the schema (0015_vibes.sql). Two things this repo does own,
 * because they are data questions rather than maths:
 *
 *  · **Verification.** A report counts only if the reporter has a row in `checkins`
 *    for that event. The client never gets to assert it.
 *  · **Prose fallback.** `headline`/`blurb` are stored ONLY when a model wrote them.
 *    Otherwise they're rendered from the current numbers at read time, so the
 *    sentence can never go stale against the axes — and a card always renders
 *    with no model configured anywhere.
 */
export class VibeRepo {
  constructor(private db: D1Database) {}

  /* ── reads ───────────────────────────────────────────────────────────────── */

  async get(eventId: string): Promise<VibeCard | null> {
    const r = await this.db
      .prepare(`SELECT v.*, ${FACT_COLS} FROM event_vibes v JOIN events e ON e.id = v.event_id WHERE v.event_id = ?`)
      .bind(eventId)
      .first<Row>();
    return r ? this.hydrate(r) : null;
  }

  /** Bulk read for a list view / Track A's search. Chunked under D1's bind cap. */
  async getMany(eventIds: string[]): Promise<Map<string, VibeCard>> {
    const out = new Map<string, VibeCard>();
    const ids = [...new Set(eventIds)].filter(Boolean);
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const ph = chunk.map(() => "?").join(",");
      const res = await this.db
        .prepare(`SELECT v.*, ${FACT_COLS} FROM event_vibes v JOIN events e ON e.id = v.event_id WHERE v.event_id IN (${ph})`)
        .bind(...chunk)
        .all<Row>();
      for (const r of res.results ?? []) out.set(r.event_id, this.hydrate(r));
    }
    return out;
  }

  /**
   * Range filters over the axes + `best_for` tags. Exposed so search can consume
   * vibes as facets without reaching into this table itself.
   */
  async search(f: VibeSearchFilters): Promise<VibeCard[]> {
    const where: string[] = [];
    const args: any[] = [];
    for (const a of VIBE_AXES) {
      const lo = clampAxis(f.min?.[a]);
      if (lo != null) { where.push(`v.${AXIS_COL[a]} >= ?`); args.push(lo); }
      const hi = clampAxis(f.max?.[a]);
      if (hi != null) { where.push(`v.${AXIS_COL[a]} <= ?`); args.push(hi); }
    }
    const tags = [...new Set((f.bestFor ?? []).map((t) => String(t).trim()).filter(Boolean))].slice(0, MAX_TAG_FILTERS);
    if (tags.length) {
      where.push(`EXISTS (SELECT 1 FROM json_each(v.best_for_json) WHERE json_each.value IN (${tags.map(() => "?").join(",")}))`);
      args.push(...tags);
    }
    const sources = (f.source ?? []).filter((s) => s === "predicted" || s === "blended" || s === "reported");
    if (sources.length) { where.push(`v.source IN (${sources.map(() => "?").join(",")})`); args.push(...sources); }
    if (f.minReports != null) { where.push("v.n_reports >= ?"); args.push(Math.max(0, Math.trunc(f.minReports))); }

    const limit = Math.min(200, Math.max(1, Math.trunc(f.limit ?? 50)));
    const res = await this.db
      .prepare(
        `SELECT v.*, ${FACT_COLS} FROM event_vibes v JOIN events e ON e.id = v.event_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY v.confidence DESC, v.event_id LIMIT ?`,
      )
      .bind(...args, limit)
      .all<Row>();
    return (res.results ?? []).map((r) => this.hydrate(r));
  }

  /** Every report held for a room (verified or not) — the audit view. */
  async reportsFor(eventId: string): Promise<StoredVibeReport[]> {
    const res = await this.db.prepare("SELECT * FROM vibe_reports WHERE event_id = ? ORDER BY created_at").bind(eventId).all<Row>();
    return (res.results ?? []).map((r) => ({
      userId: r.user_id,
      energy: r.energy ?? undefined,
      formality: r.formality ?? undefined,
      intimacy: r.intimacy ?? undefined,
      talkRatio: r.talk_ratio ?? undefined,
      signal: r.signal ?? undefined,
      approachability: r.approachability ?? undefined,
      verified: !!r.verified,
      crowd: normalizeCrowd(safeObj(r.crowd_json)),
      tags: safeArr(r.tags_json),
      worthIt: r.worth_it ?? null,
      createdAt: r.created_at,
    }));
  }

  /** Has this person already vibed this room? (drives the report form's state) */
  async myReport(eventId: string, userId: string): Promise<StoredVibeReport | null> {
    const all = await this.reportsFor(eventId);
    return all.find((r) => r.userId === userId) ?? null;
  }

  /** Did this person actually walk through the door? Decides `verified`. */
  async hasCheckin(eventId: string, userId: string): Promise<boolean> {
    return !!(await this.db.prepare("SELECT 1 AS x FROM checkins WHERE user_id = ? AND event_id = ?").bind(userId, eventId).first<Row>());
  }

  /**
   * Events whose card is missing (or, with `refresh`, whose prose no model has
   * written yet). Soonest first — an event you might still go to is worth a model
   * call; last month's isn't.
   */
  async eventsNeedingVibe(limit = 50, refresh = false): Promise<Array<{ eventId: string; facts: EventFacts }>> {
    const cond = refresh ? "(v.event_id IS NULL OR v.model IS NULL)" : "v.event_id IS NULL";
    const res = await this.db
      .prepare(
        `SELECT e.id, ${FACT_COLS} FROM events e LEFT JOIN event_vibes v ON v.event_id = e.id
          WHERE ${cond} AND e.hidden = 0
          ORDER BY e.start_utc DESC LIMIT ?`,
      )
      .bind(Math.min(500, Math.max(1, Math.trunc(limit))))
      .all<Row>();
    return (res.results ?? []).map((r) => ({ eventId: r.id, facts: rowFacts(r) }));
  }

  /** The structured facts a prediction is allowed to see. */
  async eventFacts(eventId: string): Promise<EventFacts | null> {
    const r = await this.db.prepare(`SELECT ${FACT_COLS} FROM events e WHERE e.id = ?`).bind(eventId).first<Row>();
    return r ? rowFacts(r) : null;
  }

  /**
   * The host's earned prior: the mean of the rooms they've actually run, but only
   * once >= HOST_MIN_EVENTS of them have been REPORTED by real attendees. Caliber
   * has to be earned from evidence; it is never guessed from a listing.
   *
   * Keyed on `host_user_id` for platform-hosted events, else on the normalised
   * organizer string (that's all a scraped listing gives us).
   */
  async hostPrior(eventId: string): Promise<HostTrackRecord | null> {
    const me = await this.db.prepare("SELECT host_user_id, organizer FROM events WHERE id = ?").bind(eventId).first<Row>();
    if (!me) return null;
    const hostId: string | null = me.host_user_id ?? null;
    const org = String(me.organizer ?? "").trim().toLowerCase();
    if (!hostId && !org) return null;

    const match = hostId ? "e.host_user_id = ?" : "lower(trim(e.organizer)) = ?";
    const res = await this.db
      .prepare(
        `SELECT v.energy, v.formality, v.intimacy, v.talk_ratio, v.signal, v.approachability
           FROM event_vibes v JOIN events e ON e.id = v.event_id
          WHERE ${match} AND v.event_id != ? AND v.n_reports > 0 AND v.source <> 'predicted'`,
      )
      .bind(hostId ?? org, eventId)
      .all<Row>();
    const rows = res.results ?? [];
    if (rows.length < HOST_MIN_EVENTS) return null;
    const axes = meanAxes(rows.map((r) => clampAxes(this.axesOf(r), NEUTRAL)));
    return axes ? { events: rows.length, axes } : null;
  }

  /** Rooms you checked into but haven't vibed — the collection prompt. */
  async pendingPrompts(userId: string): Promise<Array<{ eventId: string; title: string; startUtc: string; checkedInAt: string }>> {
    const res = await this.db
      .prepare(
        `SELECT c.event_id, c.at, e.title, e.start_utc
           FROM checkins c JOIN events e ON e.id = c.event_id
          WHERE c.user_id = ?
            AND NOT EXISTS (SELECT 1 FROM vibe_reports r WHERE r.event_id = c.event_id AND r.user_id = c.user_id)
          ORDER BY c.at DESC LIMIT 50`,
      )
      .bind(userId)
      .all<Row>();
    return (res.results ?? []).map((r) => ({ eventId: r.event_id, title: r.title, startUtc: r.start_utc, checkedInAt: r.at }));
  }

  /** Everyone who owes at least one vibe report — the web-push nudge audience. */
  async usersOwingReports(limit = 500): Promise<string[]> {
    const res = await this.db
      .prepare(
        `SELECT DISTINCT c.user_id FROM checkins c
          WHERE NOT EXISTS (SELECT 1 FROM vibe_reports r WHERE r.event_id = c.event_id AND r.user_id = c.user_id)
          LIMIT ?`,
      )
      .bind(Math.max(1, Math.trunc(limit)))
      .all<Row>();
    return (res.results ?? []).map((r) => r.user_id);
  }

  /* ── writes ──────────────────────────────────────────────────────────────── */

  /**
   * Store the prior for a room and re-blend. `prose` is persisted only when a
   * model authored it (pass null to let the deterministic template render at read
   * time, which is what keeps a headline from going stale against the numbers).
   */
  async savePrediction(
    eventId: string,
    prediction: VibePrediction,
    prose: { headline: string; blurb: string } | null,
    model: string | null,
  ): Promise<VibeCard | null> {
    const ts = nowIso();
    await this.db
      .prepare(
        `INSERT INTO event_vibes (event_id, predicted_json, headline, blurb, source, confidence, n_reports, model, updated_at)
         VALUES (?, ?, ?, ?, 'predicted', 0.3, 0, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET predicted_json = excluded.predicted_json,
                                             headline = excluded.headline,
                                             blurb = excluded.blurb,
                                             model = excluded.model,
                                             updated_at = excluded.updated_at`,
      )
      .bind(eventId, JSON.stringify(prediction), prose?.headline ?? null, prose?.blurb ?? null, model, ts)
      .run();
    return this.recompute(eventId);
  }

  /**
   * Record one attendee's report and re-blend. Verification is read from
   * `checkins` here, never taken from the caller.
   */
  async addReport(eventId: string, userId: string, input: VibeReportInput): Promise<{ verified: boolean; card: VibeCard | null }> {
    const seen = await this.db.prepare("SELECT 1 AS x FROM checkins WHERE user_id = ? AND event_id = ?").bind(userId, eventId).first<Row>();
    const verified = !!seen;
    const a = (x: VibeAxis) => clampAxis(input[x]);
    await this.db
      .prepare(
        `INSERT INTO vibe_reports (event_id, user_id, energy, formality, intimacy, talk_ratio, signal, approachability, crowd_json, tags_json, worth_it, verified, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id, user_id) DO UPDATE SET energy = excluded.energy, formality = excluded.formality,
           intimacy = excluded.intimacy, talk_ratio = excluded.talk_ratio, signal = excluded.signal,
           approachability = excluded.approachability, crowd_json = excluded.crowd_json, tags_json = excluded.tags_json,
           worth_it = excluded.worth_it, verified = excluded.verified, created_at = excluded.created_at`,
      )
      .bind(
        eventId, userId,
        a("energy"), a("formality"), a("intimacy"), a("talkRatio"), a("signal"), a("approachability"),
        JSON.stringify(normalizeCrowd(input.crowd)),
        JSON.stringify((input.tags ?? []).map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 8)),
        input.worthIt == null ? null : Math.min(5, Math.max(1, Math.trunc(input.worthIt))),
        verified ? 1 : 0,
        nowIso(),
      )
      .run();
    return { verified, card: await this.recompute(eventId) };
  }

  /**
   * Re-derive the stored card from (prior + host carry-over + verified reports).
   * Idempotent: the prior is kept immutably in `predicted_json`, so running this
   * twice can never fold the blend's own output back into itself.
   */
  async recompute(eventId: string): Promise<VibeCard | null> {
    const facts = await this.eventFacts(eventId);
    if (!facts) return null;
    const existing = await this.db.prepare("SELECT predicted_json, headline, blurb, model FROM event_vibes WHERE event_id = ?").bind(eventId).first<Row>();

    // No prior yet (e.g. the first report landed before any enrichment) — fall back
    // to the deterministic listing read so the card always exists.
    const prediction = this.parsePrediction(existing?.predicted_json, facts);
    const reports = await this.reportsFor(eventId);
    const host = await this.hostPrior(eventId);

    const blend = blendVibe({
      predicted: prediction.axes,
      predictedCrowd: prediction.crowd,
      host,
      // Passed through as-is: blendVibe fills an unrated slider from the PRIOR
      // (which includes the host carry-over), not from a silent zero.
      reports: reports.map((r) => ({ ...r, verified: r.verified, crowd: r.crowd })),
    });

    // best-for / expect track the CURRENT numbers, with any model-supplied tags
    // kept behind them.
    const bestFor = [...new Set([...deriveBestFor(blend.axes, facts), ...prediction.bestFor])].slice(0, 4);
    const expect = [...new Set([...deriveExpect(blend.axes, facts), ...prediction.expect])].slice(0, 6);

    await this.db
      .prepare(
        `INSERT INTO event_vibes (event_id, energy, formality, intimacy, talk_ratio, signal, approachability,
                                  headline, blurb, best_for_json, expect_json, crowd_json, predicted_json,
                                  source, confidence, n_reports, model, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET energy = excluded.energy, formality = excluded.formality,
           intimacy = excluded.intimacy, talk_ratio = excluded.talk_ratio, signal = excluded.signal,
           approachability = excluded.approachability, best_for_json = excluded.best_for_json,
           expect_json = excluded.expect_json, crowd_json = excluded.crowd_json, predicted_json = excluded.predicted_json,
           source = excluded.source, confidence = excluded.confidence, n_reports = excluded.n_reports,
           updated_at = excluded.updated_at`,
      )
      .bind(
        eventId,
        blend.axes.energy, blend.axes.formality, blend.axes.intimacy, blend.axes.talkRatio, blend.axes.signal, blend.axes.approachability,
        existing?.headline ?? null, existing?.blurb ?? null,
        JSON.stringify(bestFor), JSON.stringify(expect), JSON.stringify(blend.crowd), JSON.stringify(prediction),
        blend.source, blend.confidence, blend.nReports, existing?.model ?? null, nowIso(),
      )
      .run();
    return this.get(eventId);
  }

  /* ── internals ───────────────────────────────────────────────────────────── */

  private axesOf(r: Row): Partial<Record<VibeAxis, unknown>> {
    return { energy: r.energy, formality: r.formality, intimacy: r.intimacy, talkRatio: r.talk_ratio, signal: r.signal, approachability: r.approachability };
  }

  /** A stored prior, or a fresh deterministic one when there isn't a usable one. */
  private parsePrediction(json: unknown, facts: EventFacts): VibePrediction {
    const raw = safeObj(json) as Partial<VibePrediction>;
    const axes = raw.axes && typeof raw.axes === "object" ? raw.axes : null;
    if (!axes) return baselinePredict(facts);
    const fallback = baselinePredict(facts);
    return {
      axes: clampAxes(axes as any, fallback.axes),
      crowd: Object.keys(normalizeCrowd(raw.crowd)).length ? normalizeCrowd(raw.crowd) : fallback.crowd,
      bestFor: Array.isArray(raw.bestFor) ? raw.bestFor.filter((x) => typeof x === "string") : fallback.bestFor,
      expect: Array.isArray(raw.expect) ? raw.expect.filter((x) => typeof x === "string") : fallback.expect,
      archetype: typeof raw.archetype === "string" ? raw.archetype : fallback.archetype,
    };
  }

  /** Row → card. Prose falls back to the deterministic template when no model
   *  wrote it, so the sentence is always consistent with the numbers above it. */
  private hydrate(r: Row): VibeCard {
    const facts = rowFacts(r);
    const axes = clampAxes(this.axesOf(r), NEUTRAL);
    const bestFor = safeArr(r.best_for_json);
    return {
      eventId: r.event_id,
      axes,
      headline: r.headline || templateHeadline(axes, facts),
      blurb: r.blurb || templateBlurb(axes, facts, bestFor),
      bestFor,
      expect: safeArr(r.expect_json),
      crowd: normalizeCrowd(safeObj(r.crowd_json)),
      source: r.source,
      confidence: Number(r.confidence ?? 0.3),
      nReports: Number(r.n_reports ?? 0),
      model: r.model ?? null,
      updatedAt: r.updated_at,
    };
  }
}

/** Neutral fill for an axis a row never set. */
const NEUTRAL: VibeAxes = { energy: 50, formality: 50, intimacy: 50, talkRatio: 50, signal: 50, approachability: 50 };
