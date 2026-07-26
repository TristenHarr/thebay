import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import {
  describeAttribution,
  monthsBetween,
  outcomeHeadline,
  upgradeEvidence,
  type CauseType,
  type Evidence,
} from "../../core/attribution/ledger";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = () => new Date().toISOString();
const CHUNK = 80; // D1 caps a statement at 100 bound parameters

export type OutcomeKind = "funding" | "hire" | "cofounder" | "customer" | "job";
export type Visibility = "private" | "network" | "public";

export interface AttributionView {
  id: string;
  causeType: CauseType;
  causeId: string;
  evidence: Evidence;
  weight: number;
  claimedBy: string | null;
  confirmedBy: string | null;
  claimedAt: string | null;
  confirmedAt: string | null;
  /** From the pure ledger — the four tiers render distinctly and never merge. */
  label: string;
  kind: "corroborated" | "claimed" | "correlation";
  causal: boolean;
  leadMonths: number | null;
}

export interface OutcomeView {
  id: string;
  kind: OutcomeKind;
  userId: string | null;
  handle: string | null;
  companyId: string | null;
  companySlug: string | null;
  companyName: string | null;
  roundId: string | null;
  amountUsd: number | null;
  roundSource: string | null;
  occurredAt: string | null;
  visibility: Visibility;
  headline: string;
  attributions: AttributionView[];
}

/**
 * Every attribution EXCEPT correlations, with the credit for its outcome split
 * evenly across them. One round attributed to an intro, an event and a community
 * is 1/3 each — otherwise the same $4.2M would appear three times on three boards
 * and the totals would be fiction.
 *
 * `platform` rows are excluded on purpose: a correlation earns no credit on any
 * track record. They are reported separately by {@link AttributionRepo.outcomeDensity}.
 */
const SHARES = `
  shares AS (
    SELECT a.id, a.outcome_id, a.cause_type, a.cause_id, a.evidence,
           1.0 / (SELECT COUNT(*) FROM attributions x WHERE x.outcome_id = a.outcome_id AND x.evidence <> 'platform') AS share
      FROM attributions a
     WHERE a.evidence <> 'platform'
  )`;

/** Public boards show public outcomes from members who have not opted out. */
const PUBLIC_FILTER = `o.visibility = 'public' AND COALESCE(ou.attribution_opt_out, 0) = 0`;

/**
 * AttributionRepo — outcomes, the evidence behind them, and the boards that read
 * them.
 *
 * The evidence ladder is enforced in three places at once and that is deliberate:
 * the SQL CHECKs (migration 0019) make an incoherent row unrepresentable, the
 * pure `core/attribution/ledger` decides which tier transitions are legal, and
 * this class is the only thing that performs them. Nothing here can promote a
 * `platform` correlation into a claim, because {@link upgradeEvidence} refuses.
 */
export class AttributionRepo {
  constructor(private db: D1Database) {}

  private async chunked<T>(ids: string[], run: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await run(ids.slice(i, i + CHUNK))));
    return out;
  }

  // ── outcomes ────────────────────────────────────────────────────────────────

  async recordOutcome(
    userId: string,
    o: { kind: OutcomeKind; companyId?: string | null; roundId?: string | null; occurredAt?: string | null; visibility?: Visibility },
  ): Promise<string> {
    const id = ulid();
    await this.db
      .prepare(
        `INSERT INTO outcomes (id, kind, user_id, company_id, round_id, occurred_at, visibility, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, o.kind, userId, o.companyId ?? null, o.roundId ?? null, o.occurredAt ?? null, o.visibility ?? "public", nowIso())
      .run();
    return id;
  }

  async setOptOut(userId: string, on: boolean): Promise<void> {
    await this.db.prepare("UPDATE users SET attribution_opt_out = ? WHERE id = ?").bind(on ? 1 : 0, userId).run();
  }
  async optedOut(userId: string): Promise<boolean> {
    const r = await this.db.prepare("SELECT attribution_opt_out AS o FROM users WHERE id = ?").bind(userId).first<Row>();
    return !!r?.o;
  }

  private async areFriends(a: string, b: string): Promise<boolean> {
    const [low, high] = a < b ? [a, b] : [b, a];
    return !!(await this.db.prepare("SELECT 1 FROM friendships WHERE user_low=? AND user_high=? AND status='accepted'").bind(low, high).first());
  }

  /**
   * Public by default with an opt-out — the deliberate product decision. The
   * owner always sees their own; an opt-out hides everything from everyone else,
   * whatever the per-outcome visibility says.
   */
  private async canSee(row: Row, viewerId?: string | null): Promise<boolean> {
    if (viewerId && row.user_id === viewerId) return true;
    if (row.user_id && (await this.optedOut(row.user_id))) return false;
    if (row.visibility === "public") return true;
    if (row.visibility === "network") return !!viewerId && !!row.user_id && (await this.areFriends(viewerId, row.user_id));
    return false;
  }

  /**
   * Where a cause sits in time and who its counterparty is — the connector of an
   * intro, the host of an event, the creator of a group or community, the mentor.
   * Both facts are needed: the timestamp proves a correlation predates an outcome,
   * and the counterparty is the only person who may corroborate a claim about it.
   */
  private async causeMeta(causeType: CauseType, causeId: string): Promise<{ at: string | null; counterpartyId: string | null } | null> {
    const q = async (sql: string) => this.db.prepare(sql).bind(causeId).first<Row>();
    switch (causeType) {
      case "intro": {
        const r = await q("SELECT created_at AS at, connector_id AS who FROM intro_forwards WHERE id = ?");
        return r ? { at: r.at, counterpartyId: r.who } : null;
      }
      case "event": {
        const r = await q("SELECT start_utc AS at, host_user_id AS who FROM events WHERE id = ?");
        return r ? { at: r.at, counterpartyId: r.who ?? null } : null;
      }
      case "group": {
        const r = await q("SELECT created_at AS at, created_by AS who FROM groups WHERE id = ?");
        return r ? { at: r.at, counterpartyId: r.who } : null;
      }
      case "community": {
        const r = await q("SELECT created_at AS at, created_by AS who FROM communities WHERE id = ?");
        return r ? { at: r.at, counterpartyId: r.who } : null;
      }
      case "mentor": {
        const r = await q("SELECT created_at AS at, mentor_id AS who FROM mentor_requests WHERE id = ?");
        return r ? { at: r.at, counterpartyId: r.who } : null;
      }
      default:
        return null;
    }
  }

  private async attributionsFor(outcomeId: string, occurredAt: string | null): Promise<AttributionView[]> {
    const res = await this.db
      .prepare(
        `SELECT a.id, a.cause_type AS causeType, a.cause_id AS causeId, a.evidence, a.weight,
                a.claimed_at AS claimedAt, a.confirmed_at AS confirmedAt,
                cu.handle AS claimedBy, fu.handle AS confirmedBy
           FROM attributions a
           LEFT JOIN users cu ON cu.id = a.claimed_by
           LEFT JOIN users fu ON fu.id = a.confirmed_by
          WHERE a.outcome_id = ?
          ORDER BY a.created_at`,
      )
      .bind(outcomeId)
      .all<Row>();

    const out: AttributionView[] = [];
    for (const r of res.results ?? []) {
      // The lead is only meaningful for a correlation, which is exactly the tier
      // that must state WHEN rather than WHY.
      let leadMonths: number | null = null;
      if (r.evidence === "platform") {
        const meta = await this.causeMeta(r.causeType, r.causeId);
        leadMonths = monthsBetween(meta?.at ?? null, occurredAt);
      }
      const rendering = describeAttribution({
        evidence: r.evidence,
        causeType: r.causeType,
        weight: r.weight,
        claimedByHandle: r.claimedBy,
        confirmedByHandle: r.confirmedBy,
        leadMonths,
      });
      out.push({
        id: r.id,
        causeType: r.causeType,
        causeId: r.causeId,
        evidence: r.evidence,
        weight: r.weight,
        claimedBy: r.claimedBy ?? null,
        confirmedBy: r.confirmedBy ?? null,
        claimedAt: r.claimedAt ?? null,
        confirmedAt: r.confirmedAt ?? null,
        label: rendering.label,
        kind: rendering.kind,
        causal: rendering.causal,
        leadMonths,
      });
    }
    return out;
  }

  private async hydrate(row: Row): Promise<OutcomeView> {
    return {
      id: row.id,
      kind: row.kind,
      userId: row.user_id ?? null,
      handle: row.handle ?? null,
      companyId: row.company_id ?? null,
      companySlug: row.companySlug ?? null,
      companyName: row.companyName ?? null,
      roundId: row.round_id ?? null,
      amountUsd: row.amountUsd ?? null,
      roundSource: row.roundSource ?? null,
      occurredAt: row.occurred_at ?? null,
      visibility: row.visibility,
      headline: outcomeHeadline({ kind: row.kind, amountUsd: row.amountUsd ?? null, roundSource: row.roundSource ?? null }),
      attributions: await this.attributionsFor(row.id, row.occurred_at ?? null),
    };
  }

  private readonly SELECT_OUTCOME = `
    SELECT o.*, u.handle, c.slug AS companySlug, c.name AS companyName,
           r.amount_usd AS amountUsd, r.source AS roundSource
      FROM outcomes o
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN companies c ON c.id = o.company_id
      LEFT JOIN funding_rounds r ON r.id = o.round_id`;

  async outcome(id: string, viewerId?: string | null): Promise<OutcomeView | null> {
    const row = await this.db.prepare(`${this.SELECT_OUTCOME} WHERE o.id = ?`).bind(id).first<Row>();
    if (!row || !(await this.canSee(row, viewerId))) return null;
    return this.hydrate(row);
  }

  async outcomesForUser(userId: string, viewerId?: string | null): Promise<OutcomeView[]> {
    const res = await this.db
      .prepare(`${this.SELECT_OUTCOME} WHERE o.user_id = ? ORDER BY (o.occurred_at IS NULL), o.occurred_at DESC, o.created_at DESC`)
      .bind(userId)
      .all<Row>();
    const out: OutcomeView[] = [];
    for (const row of res.results ?? []) if (await this.canSee(row, viewerId)) out.push(await this.hydrate(row));
    return out;
  }

  // ── the ladder ──────────────────────────────────────────────────────────────

  /**
   * A party to the outcome claims a cause for it. Tier `self`.
   *
   * If a `platform` correlation for the same cause already exists, this is the
   * legal `platform → self` transition — a person stepping forward turns a
   * co-occurrence into their claim. If the row is already `self` or better it is
   * LEFT ALONE: re-claiming must never quietly undo a corroboration.
   */
  async claimAttribution(
    userId: string,
    outcomeId: string,
    a: { causeType: CauseType; causeId: string; weight?: number },
  ): Promise<"claimed" | "forbidden" | "unknown"> {
    const outcome = await this.db.prepare("SELECT id, user_id FROM outcomes WHERE id = ?").bind(outcomeId).first<Row>();
    if (!outcome) return "unknown";
    if (outcome.user_id !== userId) return "forbidden";
    if (!(await this.causeMeta(a.causeType, a.causeId))) return "unknown";

    const ts = nowIso();
    const existing = await this.db
      .prepare("SELECT id, evidence FROM attributions WHERE outcome_id=? AND cause_type=? AND cause_id=?")
      .bind(outcomeId, a.causeType, a.causeId)
      .first<Row>();

    if (existing) {
      // Claiming is only ever an UPGRADE path, out of `platform`. Re-claiming an
      // already-corroborated link must not walk it back down to `self` — the
      // ledger permits a deliberate retraction, but a re-claim is not one.
      if (existing.evidence !== "platform") return "claimed";
      if (!upgradeEvidence({ from: "platform", to: "self", actor: "claimant" }).changed) return "claimed";
      await this.db
        .prepare("UPDATE attributions SET evidence='self', claimed_by=?, claimed_at=? WHERE id=?")
        .bind(userId, ts, existing.id)
        .run();
      return "claimed";
    }

    await this.db
      .prepare(
        `INSERT INTO attributions (id, outcome_id, cause_type, cause_id, weight, evidence, claimed_by, claimed_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'self', ?, ?, ?)`,
      )
      .bind(ulid(), outcomeId, a.causeType, a.causeId, Math.min(1, Math.max(0, a.weight ?? 1)), userId, ts, ts)
      .run();
    return "claimed";
  }

  /**
   * The counterparty of the cause corroborates the claim. Tier `counterparty`.
   *
   * Re-verified server-side: only the connector of that intro / host of that event
   * / creator of that community may confirm, and never the claimant themselves —
   * "confirmed by both" has to mean two people.
   */
  async confirmAttribution(userId: string, attributionId: string): Promise<"confirmed" | "forbidden" | "unknown"> {
    const a = await this.db
      .prepare("SELECT id, cause_type, cause_id, evidence, claimed_by, claimed_at FROM attributions WHERE id = ?")
      .bind(attributionId)
      .first<Row>();
    if (!a) return "unknown";
    if (a.claimed_by === userId) return "forbidden"; // nobody corroborates themselves

    const meta = await this.causeMeta(a.cause_type, a.cause_id);
    if (!meta || meta.counterpartyId !== userId) return "forbidden";

    if (a.evidence === "counterparty" || a.evidence === "sec") return "confirmed"; // already corroborated
    const step = upgradeEvidence({ from: a.evidence, to: "counterparty", actor: "counterparty" });
    if (!step.changed) return "forbidden"; // e.g. a bare correlation: nobody claimed it

    await this.db
      .prepare("UPDATE attributions SET evidence='counterparty', confirmed_by=?, confirmed_at=? WHERE id=?")
      .bind(userId, nowIso(), attributionId)
      .run();
    return "confirmed";
  }

  /**
   * A machine-derived co-occurrence: this edge provably predates the outcome.
   * CLAIMED BY NOBODY — the schema refuses a `platform` row with a claimant — and
   * refused outright unless we can actually show it came first.
   */
  async recordPlatformCorrelation(
    outcomeId: string,
    a: { causeType: CauseType; causeId: string; weight?: number },
  ): Promise<"recorded" | "not_before" | "unknown" | "exists"> {
    const outcome = await this.db.prepare("SELECT id, occurred_at FROM outcomes WHERE id = ?").bind(outcomeId).first<Row>();
    if (!outcome) return "unknown";
    const meta = await this.causeMeta(a.causeType, a.causeId);
    if (!meta) return "unknown";
    // "Provably predates" is the whole claim. No timestamps ⇒ no proof ⇒ no row.
    if (!meta.at || !outcome.occurred_at || new Date(meta.at) >= new Date(outcome.occurred_at)) return "not_before";

    const existing = await this.db
      .prepare("SELECT id FROM attributions WHERE outcome_id=? AND cause_type=? AND cause_id=?")
      .bind(outcomeId, a.causeType, a.causeId)
      .first<Row>();
    if (existing) return "exists"; // never downgrade an existing claim to a correlation

    await this.db
      .prepare(
        `INSERT INTO attributions (id, outcome_id, cause_type, cause_id, weight, evidence, claimed_by, claimed_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'platform', NULL, NULL, ?)`,
      )
      .bind(ulid(), outcomeId, a.causeType, a.causeId, Math.min(1, Math.max(0, a.weight ?? 1)), nowIso())
      .run();
    return "recorded";
  }

  /**
   * Raise every already-claimed attribution on a SEC-backed outcome to `sec`.
   * Correlations are untouched: the filing corroborates that the round happened,
   * which says nothing about a co-occurrence nobody has claimed.
   */
  async corroborateFromSec(outcomeId: string): Promise<number> {
    const o = await this.db
      .prepare(
        `SELECT o.id FROM outcomes o JOIN funding_rounds r ON r.id = o.round_id
          WHERE o.id = ? AND r.source = 'sec'`,
      )
      .bind(outcomeId)
      .first<Row>();
    if (!o) return 0;
    const rows = await this.db.prepare("SELECT id, evidence FROM attributions WHERE outcome_id = ?").bind(outcomeId).all<Row>();
    let n = 0;
    for (const a of rows.results ?? []) {
      if (!upgradeEvidence({ from: a.evidence, to: "sec", actor: "ingest" }).changed) continue;
      await this.db.prepare("UPDATE attributions SET evidence='sec' WHERE id=?").bind(a.id).run();
      n++;
    }
    return n;
  }

  /**
   * The ingest-side entry point for the `sec` tier: a filing has just landed for
   * `roundId`, so every outcome behind it can have its ALREADY-CLAIMED causes
   * marked SEC-corroborated. Called from the news cron, where the actor really is
   * `ingest`. Correlations are untouched, so the filing can never turn a
   * co-occurrence nobody claimed into the top tier.
   */
  async corroborateSecRound(roundId: string): Promise<number> {
    const res = await this.db.prepare("SELECT id FROM outcomes WHERE round_id = ?").bind(roundId).all<Row>();
    let n = 0;
    for (const o of res.results ?? []) n += await this.corroborateFromSec(o.id);
    return n;
  }

  // ── leaderboards ────────────────────────────────────────────────────────────

  /** Super-connectors: intros made, and the outcomes those intros are credited with. */
  async superConnectors(limit = 50): Promise<Array<{ id: string; displayName: string; handle: string; intros: number; outcomes: number; attributedUsd: number }>> {
    const res = await this.db
      .prepare(
        `WITH ${SHARES}
         SELECT u.id, u.display_name AS displayName, u.handle,
                (SELECT COUNT(*) FROM intro_forwards f WHERE f.connector_id = u.id AND f.status='accepted') AS intros,
                COALESCE(agg.outcomes, 0) AS outcomes,
                COALESCE(agg.usd, 0) AS attributedUsd
           FROM users u
           LEFT JOIN (
             SELECT f.connector_id AS uid, COUNT(DISTINCT o.id) AS outcomes,
                    SUM(COALESCE(r.amount_usd, 0) * s.share) AS usd
               FROM shares s
               JOIN outcomes o ON o.id = s.outcome_id
               LEFT JOIN users ou ON ou.id = o.user_id
               LEFT JOIN funding_rounds r ON r.id = o.round_id
               JOIN intro_forwards f ON f.id = s.cause_id
              WHERE s.cause_type = 'intro' AND ${PUBLIC_FILTER}
              GROUP BY f.connector_id
           ) agg ON agg.uid = u.id
          WHERE u.social_enabled = 1 AND COALESCE(u.attribution_opt_out, 0) = 0
          ORDER BY attributedUsd DESC, outcomes DESC, intros DESC, u.created_at
          LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return (res.results ?? []).map((r) => ({ ...r, outcomes: Number(r.outcomes) || 0, attributedUsd: Math.round(Number(r.attributedUsd) || 0) })) as any;
  }

  /**
   * "$X raised by attendees within 12 months." The window is the point: an
   * outcome three years later is not this event's track record, and a board that
   * counted it would be advertising a number nobody could defend.
   */
  async eventTrackRecord(limit = 50): Promise<Array<{ eventId: string; title: string; venue: string | null; startUtc: string; outcomes: number; attributedUsd: number }>> {
    const res = await this.db
      .prepare(
        `WITH ${SHARES}
         SELECT e.id AS eventId, e.title, e.venue_name AS venue, e.start_utc AS startUtc,
                COUNT(DISTINCT o.id) AS outcomes, SUM(COALESCE(r.amount_usd, 0) * s.share) AS attributedUsd
           FROM shares s
           JOIN events e ON e.id = s.cause_id
           JOIN outcomes o ON o.id = s.outcome_id
           LEFT JOIN users ou ON ou.id = o.user_id
           LEFT JOIN funding_rounds r ON r.id = o.round_id
          WHERE s.cause_type = 'event' AND ${PUBLIC_FILTER}
            AND o.occurred_at IS NOT NULL
            AND julianday(o.occurred_at) BETWEEN julianday(e.start_utc) AND julianday(e.start_utc) + 365
          GROUP BY e.id
          ORDER BY attributedUsd DESC, outcomes DESC
          LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return (res.results ?? []).map((r) => ({ ...r, outcomes: Number(r.outcomes) || 0, attributedUsd: Math.round(Number(r.attributedUsd) || 0) })) as any;
  }

  async communityTrackRecord(limit = 50): Promise<Array<{ communityId: string; name: string; outcomes: number; attributedUsd: number }>> {
    const res = await this.db
      .prepare(
        `WITH ${SHARES}
         SELECT cm.id AS communityId, cm.name, COUNT(DISTINCT o.id) AS outcomes,
                SUM(COALESCE(r.amount_usd, 0) * s.share) AS attributedUsd
           FROM shares s
           JOIN communities cm ON cm.id = s.cause_id
           JOIN outcomes o ON o.id = s.outcome_id
           LEFT JOIN users ou ON ou.id = o.user_id
           LEFT JOIN funding_rounds r ON r.id = o.round_id
          WHERE s.cause_type = 'community' AND ${PUBLIC_FILTER}
          GROUP BY cm.id
          ORDER BY attributedUsd DESC, outcomes DESC
          LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return (res.results ?? []).map((r) => ({ ...r, outcomes: Number(r.outcomes) || 0, attributedUsd: Math.round(Number(r.attributedUsd) || 0) })) as any;
  }

  async venueBoard(limit = 50): Promise<Array<{ venue: string; events: number; outcomes: number; attributedUsd: number }>> {
    const res = await this.db
      .prepare(
        `WITH ${SHARES}
         SELECT e.venue_name AS venue, COUNT(DISTINCT e.id) AS events, COUNT(DISTINCT o.id) AS outcomes,
                SUM(COALESCE(r.amount_usd, 0) * s.share) AS attributedUsd
           FROM shares s
           JOIN events e ON e.id = s.cause_id
           JOIN outcomes o ON o.id = s.outcome_id
           LEFT JOIN users ou ON ou.id = o.user_id
           LEFT JOIN funding_rounds r ON r.id = o.round_id
          WHERE s.cause_type = 'event' AND e.venue_name IS NOT NULL AND ${PUBLIC_FILTER}
          GROUP BY e.venue_name
          ORDER BY attributedUsd DESC, outcomes DESC
          LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return (res.results ?? []).map((r) => ({ ...r, events: Number(r.events) || 0, outcomes: Number(r.outcomes) || 0, attributedUsd: Math.round(Number(r.attributedUsd) || 0) })) as any;
  }

  async hostBoard(limit = 50): Promise<Array<{ id: string; displayName: string; handle: string; events: number; outcomes: number; attributedUsd: number }>> {
    const res = await this.db
      .prepare(
        `WITH ${SHARES}
         SELECT hu.id, hu.display_name AS displayName, hu.handle,
                COUNT(DISTINCT e.id) AS events, COUNT(DISTINCT o.id) AS outcomes,
                SUM(COALESCE(r.amount_usd, 0) * s.share) AS attributedUsd
           FROM shares s
           JOIN events e ON e.id = s.cause_id
           JOIN users hu ON hu.id = e.host_user_id
           JOIN outcomes o ON o.id = s.outcome_id
           LEFT JOIN users ou ON ou.id = o.user_id
           LEFT JOIN funding_rounds r ON r.id = o.round_id
          WHERE s.cause_type = 'event' AND ${PUBLIC_FILTER} AND COALESCE(hu.attribution_opt_out, 0) = 0
          GROUP BY hu.id
          ORDER BY attributedUsd DESC, outcomes DESC
          LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return (res.results ?? []).map((r) => ({ ...r, events: Number(r.events) || 0, outcomes: Number(r.outcomes) || 0, attributedUsd: Math.round(Number(r.attributedUsd) || 0) })) as any;
  }

  // ── E5: outcome density, for Track A's ranking ──────────────────────────────

  /**
   * Per-cause outcome density. Exposed here so a ranking elsewhere can consume it
   * without reaching into these tables.
   *
   * `claimed` / `corroborated` / `correlated` are reported SEPARATELY and never
   * summed into one "impact" number: a consumer that wants to rank on evidence
   * can, and a consumer that treats a correlation as a claim has to do so
   * explicitly. `attributedUsd` counts only non-correlations.
   */
  async outcomeDensity(
    causeType: CauseType,
    causeIds?: string[],
  ): Promise<Record<string, { outcomes: number; claimed: number; corroborated: number; correlated: number; attributedUsd: number }>> {
    const ids = causeIds ? [...new Set(causeIds.filter(Boolean))] : null;
    if (ids && ids.length === 0) return {};

    const select = (filter: string) => `
      WITH allattr AS (
        SELECT a.*, COALESCE((SELECT 1.0 / COUNT(*) FROM attributions x WHERE x.outcome_id = a.outcome_id AND x.evidence <> 'platform'), 0) AS share
          FROM attributions a
      )
      SELECT a.cause_id AS causeId,
             COUNT(DISTINCT a.outcome_id) AS outcomes,
             SUM(CASE WHEN a.evidence = 'self' THEN 1 ELSE 0 END) AS claimed,
             SUM(CASE WHEN a.evidence IN ('counterparty','sec') THEN 1 ELSE 0 END) AS corroborated,
             SUM(CASE WHEN a.evidence = 'platform' THEN 1 ELSE 0 END) AS correlated,
             SUM(CASE WHEN a.evidence = 'platform' THEN 0 ELSE COALESCE(r.amount_usd, 0) * a.share END) AS attributedUsd
        FROM allattr a
        JOIN outcomes o ON o.id = a.outcome_id
        LEFT JOIN users ou ON ou.id = o.user_id
        LEFT JOIN funding_rounds r ON r.id = o.round_id
       WHERE a.cause_type = ? AND o.visibility <> 'private' AND COALESCE(ou.attribution_opt_out, 0) = 0 ${filter}
       GROUP BY a.cause_id`;

    const rows = ids
      ? await this.chunked(ids, async (chunk) => {
          const r = await this.db
            .prepare(select(`AND a.cause_id IN (${chunk.map(() => "?").join(",")})`))
            .bind(causeType, ...chunk)
            .all<Row>();
          return r.results ?? [];
        })
      : ((await this.db.prepare(select("")).bind(causeType).all<Row>()).results ?? []);

    const out: Record<string, { outcomes: number; claimed: number; corroborated: number; correlated: number; attributedUsd: number }> = {};
    for (const r of rows) {
      out[r.causeId] = {
        outcomes: Number(r.outcomes) || 0,
        claimed: Number(r.claimed) || 0,
        corroborated: Number(r.corroborated) || 0,
        correlated: Number(r.correlated) || 0,
        attributedUsd: Math.round(Number(r.attributedUsd) || 0),
      };
    }
    return out;
  }
}
