import type { D1Database } from "@cloudflare/workers-types";
import { ulid } from "ulid";
import type { PointKind, WorkerCapability } from "../../../shared/schema";
import { POINTS } from "../../../shared/schema";
import { effectiveGapMs, mayLease, dayKey, backoffUntilMs, LEASE_TTL_MS, type HostState, type LeaseVerdict } from "../../core/scrape/politeness";
import { recipePath } from "../../core/scrape/host";
import { pathAllowed } from "../../core/scrape/robots";
import { normalizeWindowMs, windowStart, windowIsOpen } from "../../core/scrape/window";
import { tierOf, trustScore, shouldQuarantine, type MemberStats } from "../../core/net/trust";
import { auditVerdict, fieldCompleteness, type RecipeStats } from "../../core/scrape/audit";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const nowIso = (ms: number) => new Date(ms).toISOString();

/** D1 caps bound parameters at 100; chunk anything that fans out. */
const CHUNK = 90;
const chunk = <T>(xs: T[], n = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export interface Recipe {
  id: string;
  sourceId: string;
  version: number;
  type: string;
  params: Record<string, unknown>;
  host: string;
  requires: WorkerCapability[];
  windowMs: number;
  status: "proposed" | "shadow" | "active" | "retired";
}

export interface GrantedLease {
  leaseId: string;
  jobId: string;
  sourceId: string;
  recipeId: string;
  windowStart: string;
  expiresAt: string;
  recipe: { type: string; params: Record<string, unknown>; host: string };
  /** What the client must honour on its own, between its own requests. */
  politeness: { host: string; minGapMs: number; disallow: string[] };
}

export interface LeaseRequest {
  clientId: string;
  memberId: string;
  capabilities: WorkerCapability[];
  egress: { ipHash?: string | null; asn?: number | null };
  max: number;
  /** Leases this member may hold per window — the fair-share cap. */
  perWindowCap?: number;
}

export interface LeaseOutcome {
  leases: GrantedLease[];
  /** Why we didn't hand out more, per host. Logged: "we scraped less today" and "we
   *  scraped less today because four hosts were blocked" are different facts. */
  skipped: Array<{ host: string; reason: LeaseVerdict | "capability" | "independence" | "fair_share" | "robots" }>;
}

const toRecipe = (r: Row): Recipe => ({
  id: r.id,
  sourceId: r.source_id,
  version: r.version,
  type: r.type,
  params: JSON.parse(r.params_json || "{}"),
  host: r.host,
  requires: JSON.parse(r.requires_json || '["fetch"]'),
  windowMs: normalizeWindowMs(r.window_ms),
  status: r.status,
});

const toHostState = (r: Row, liveLeases: number): HostState => ({
  host: r.host,
  minGapMs: r.min_gap_ms,
  maxConcurrent: r.max_concurrent,
  crawlDelayMs: r.crawl_delay_ms ?? null,
  liveLeases,
  lastGrantedAt: r.last_granted_at ?? null,
  blockedUntil: r.blocked_until ?? null,
  dailyCap: r.daily_cap ?? null,
  grantedToday: r.granted_today ?? 0,
});

/**
 * The coordinator (migrations/0024): recipes in, jobs out, leases as the only way to
 * get permission to crawl.
 *
 * The one thing to understand before changing `lease`: politeness is enforced by an
 * ATOMIC CONDITIONAL UPDATE on the host row, not by reading state and deciding. D1 has
 * no `SELECT … FOR UPDATE`, so two workers polling at the same millisecond would both
 * read "last granted 3s ago, gap is 1s, fine" and both be handed the same host. The
 * grant is therefore a token you take:
 *
 *   UPDATE scrape_hosts SET last_granted_at = :now …
 *    WHERE host = :host AND last_granted_at <= :nowMinusGap AND …
 *
 * Exactly one caller sees `changes === 1`. ISO-8601 UTC strings compare lexically in
 * the same order they compare chronologically, which is what lets the gap live in SQL
 * without storing epoch integers.
 */
export class ScrapeNetRepo {
  constructor(private db: D1Database) {}

  // ── recipes ─────────────────────────────────────────────────────────────────
  /**
   * Seed v1 recipes from config/sources.json. Idempotent — `INSERT OR IGNORE` on
   * (source_id, version) — so it can run from cron forever and never clobber a live
   * edit or resurrect a retired source.
   */
  async seedRecipes(
    sources: Array<{ id: string; type: string; enabled?: boolean; params?: Record<string, unknown>; note?: string }>,
    hostOf: (type: string, params: Record<string, unknown>) => string | null,
    atMs: number = Date.now(),
  ): Promise<{ created: number; unplaceable: string[] }> {
    const unplaceable: string[] = [];
    const stmts: any[] = [];
    for (const s of sources) {
      const params = s.params ?? {};
      const host = hostOf(s.type, params);
      if (!host) {
        // We refuse to schedule what we can't rate-limit. Named, not swallowed.
        unplaceable.push(s.id);
        continue;
      }
      stmts.push(
        this.db
          .prepare(
            `INSERT OR IGNORE INTO scrape_recipes
               (id, source_id, version, type, params_json, host, requires_json, status, notes, created_at, promoted_at)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            ulid(),
            s.id,
            s.type,
            JSON.stringify(params),
            host,
            JSON.stringify(requiresFor(s.type, params)),
            s.enabled === false ? "retired" : "active",
            s.note ?? null,
            nowIso(atMs),
            s.enabled === false ? null : nowIso(atMs),
          ),
      );
    }
    let created = 0;
    for (const batch of chunk(stmts, 50)) {
      const res: any[] = await this.db.batch(batch);
      created += res.reduce((n, r) => n + (r?.meta?.changes ?? 0), 0);
    }
    await this.ensureHosts([...new Set(sources.map((s) => hostOf(s.type, s.params ?? {})).filter(Boolean) as string[])]);
    return { created, unplaceable };
  }

  async schedulableRecipes(): Promise<Recipe[]> {
    const r = await this.db
      .prepare("SELECT * FROM scrape_recipes WHERE status IN ('active','shadow') ORDER BY source_id, version")
      .all<Row>();
    return (r.results || []).map(toRecipe);
  }

  // ── proposing, trialling and promoting recipes ───────────────────────────────
  /**
   * Add a candidate as a NEW VERSION of a source, status `proposed`. Never touches the live
   * recipe: versioning rather than editing in place is what makes promotion reversible, and
   * what lets a candidate be judged beside the thing it wants to replace.
   */
  async proposeRecipe(
    r: {
      sourceId: string;
      type: string;
      params: Record<string, unknown>;
      host: string;
      requires?: WorkerCapability[];
      windowMs?: number;
      notes?: string | null;
      authorId: string | null;
    },
    atMs: number = Date.now(),
  ): Promise<{ recipeId: string; version: number }> {
    const top = await this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM scrape_recipes WHERE source_id = ?")
      .bind(r.sourceId)
      .first<Row>();
    const version = (top?.v ?? 0) + 1;
    const recipeId = ulid();
    await this.db
      .prepare(
        `INSERT INTO scrape_recipes
           (id, source_id, version, type, params_json, host, requires_json, window_ms, status, author_id, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
      )
      .bind(
        recipeId,
        r.sourceId,
        version,
        r.type,
        JSON.stringify(r.params),
        r.host,
        JSON.stringify(r.requires ?? requiresFor(r.type, r.params)),
        normalizeWindowMs(r.windowMs),
        r.authorId,
        r.notes ?? null,
        nowIso(atMs),
      )
      .run();
    await this.ensureHosts([r.host]);
    return { recipeId, version };
  }

  /** Start the trial: `proposed` → `shadow`, at which point `plan()` schedules it too. */
  async startShadow(recipeId: string): Promise<boolean> {
    const res: any = await this.db
      .prepare("UPDATE scrape_recipes SET status = 'shadow' WHERE id = ? AND status = 'proposed'")
      .bind(recipeId)
      .run();
    return (res?.meta?.changes ?? 0) === 1;
  }

  /**
   * Move proposals into shadow so the daily cycle can actually judge them — but only where
   * doing so cannot point the fleet at somebody new.
   *
   * The line: a candidate for a host we ALREADY crawl auto-shadows, because it changes how we
   * read a site we're already reading and the audit is the review. A candidate that
   * introduces a brand-new host stays `proposed` until a human looks, because auto-shadowing
   * it would let any trusted member aim fifty residential browsers at a stranger's small
   * site. Rate limits bound the volume; they don't make that a decision a cron should take.
   */
  async promoteProposals(atMs: number = Date.now(), limit = 10): Promise<{ shadowed: string[]; heldForReview: string[] }> {
    const rows = await this.db
      .prepare(
        `SELECT p.id, p.host,
                (SELECT COUNT(*) FROM scrape_recipes o
                  WHERE o.host = p.host AND o.id <> p.id AND o.status IN ('active','shadow')) AS known_host
           FROM scrape_recipes p
          WHERE p.status = 'proposed'
          ORDER BY p.created_at
          LIMIT ?`,
      )
      .bind(Math.max(1, Math.min(100, limit)))
      .all<Row>();

    const shadowed: string[] = [];
    const heldForReview: string[] = [];
    for (const r of rows.results || []) {
      if ((r.known_host ?? 0) > 0 && (await this.startShadow(r.id))) shadowed.push(r.id);
      else heldForReview.push(r.id);
    }
    void atMs;
    return { shadowed, heldForReview };
  }

  async listRecipes(limit = 100): Promise<Array<Record<string, unknown>>> {
    const r = await this.db
      .prepare(
        `SELECT r.id, r.source_id, r.version, r.type, r.host, r.status, r.notes, r.created_at, r.promoted_at, u.handle AS author
           FROM scrape_recipes r LEFT JOIN users u ON u.id = r.author_id
          WHERE r.status <> 'retired'
          ORDER BY r.source_id, r.version DESC
          LIMIT ?`,
      )
      .bind(Math.max(1, Math.min(500, limit)))
      .all<Row>();
    return (r.results || []).map((x) => ({
      recipeId: x.id,
      sourceId: x.source_id,
      version: x.version,
      type: x.type,
      host: x.host,
      status: x.status,
      notes: x.notes ?? null,
      author: x.author ?? null,
      createdAt: x.created_at,
      promotedAt: x.promoted_at ?? null,
    }));
  }

  /** How many recipes this member has proposed recently — the anti-queue-flooding counter. */
  async recentProposalCount(authorId: string, sinceMs: number): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS n FROM scrape_recipes WHERE author_id = ? AND created_at >= ?")
      .bind(authorId, nowIso(sinceMs))
      .first<Row>();
    return r?.n ?? 0;
  }

  /**
   * The evidence a recipe has accumulated, shaped for `auditVerdict`.
   *
   * Counted by DISTINCT item_key for the same reason reputation is: re-finding the same event
   * next window is honest work but it is not a second discovery, and counting rows would let
   * a recipe win the audit purely by being scheduled more often.
   */
  async recipeStats(recipeId: string): Promise<RecipeStats> {
    const agg = await this.db
      .prepare(
        `SELECT
           COUNT(DISTINCT j.id) AS windows,
           MIN(j.window_start) AS first_window,
           MAX(j.window_start) AS last_window,
           COUNT(DISTINCT o.item_key) AS items,
           COUNT(DISTINCT CASE WHEN o.status IN ('confirmed','published') THEN o.item_key END) AS confirmed,
           COUNT(DISTINCT CASE WHEN o.status = 'contradicted' THEN o.item_key END) AS contradicted
         FROM scrape_jobs j
         LEFT JOIN scrape_observations o ON o.job_id = j.id
        WHERE j.recipe_id = ?`,
      )
      .bind(recipeId)
      .first<Row>();

    const req = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM scrape_receipts rc
           JOIN scrape_leases l ON l.id = rc.lease_id
           JOIN scrape_jobs j ON j.id = l.job_id
          WHERE j.recipe_id = ?`,
      )
      .bind(recipeId)
      .first<Row>();

    // Completeness is measured on the payloads themselves rather than stored, so it reflects
    // whatever the recipe is producing right now.
    const sample = await this.db
      .prepare(
        `SELECT o.payload_json FROM scrape_observations o
           JOIN scrape_jobs j ON j.id = o.job_id
          WHERE j.recipe_id = ? AND o.status IN ('confirmed','published')
          LIMIT 200`,
      )
      .bind(recipeId)
      .all<Row>();
    const payloads: Array<Record<string, unknown>> = [];
    for (const row of sample.results || []) {
      try {
        payloads.push(JSON.parse(row.payload_json));
      } catch {
        /* an unparseable payload counts as no fields, which is the honest reading */
      }
    }

    const first = Date.parse(agg?.first_window ?? "");
    const last = Date.parse(agg?.last_window ?? "");
    const spanDays = Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, (last - first) / 86_400_000) : 0;

    return {
      windows: agg?.windows ?? 0,
      spanDays,
      items: agg?.items ?? 0,
      confirmed: agg?.confirmed ?? 0,
      contradicted: agg?.contradicted ?? 0,
      fieldCompleteness: fieldCompleteness(payloads),
      requests: req?.n ?? 0,
    };
  }

  /**
   * Judge every candidate in shadow, act, and log. This is the daily release cycle for
   * scrapers: no deploy, no migration, and a decision anyone can read afterwards.
   */
  async auditShadows(atMs: number = Date.now()): Promise<Array<{ recipeId: string; sourceId: string; verdict: string; reason: string }>> {
    const shadows = await this.db
      .prepare("SELECT id, source_id, author_id FROM scrape_recipes WHERE status = 'shadow' ORDER BY source_id")
      .all<Row>();
    const out: Array<{ recipeId: string; sourceId: string; verdict: string; reason: string }> = [];

    for (const cand of shadows.results || []) {
      const incumbent = await this.db
        .prepare("SELECT id FROM scrape_recipes WHERE source_id = ? AND status = 'active'")
        .bind(cand.source_id)
        .first<Row>();

      const candidateStats = await this.recipeStats(cand.id);
      const incumbentStats: RecipeStats = incumbent
        ? await this.recipeStats(incumbent.id)
        : { windows: 0, spanDays: 0, items: 0, confirmed: 0, contradicted: 0, fieldCompleteness: 0, requests: 0 };

      const result = auditVerdict(candidateStats, incumbentStats);
      await this.recordAudit(cand.id, cand.source_id, incumbent?.id ?? null, result.verdict, result.reason, { candidate: candidateStats, incumbent: incumbentStats, ...result }, atMs);

      if (result.verdict === "promote") {
        await this.swapActive(cand.source_id, cand.id, incumbent?.id ?? null, atMs);
        // The highest-leverage contribution anyone can make, paid once, keyed on the recipe
        // so re-auditing cannot pay twice.
        if (cand.author_id) await this.awardStmt(cand.author_id, "recipe", `recipe:${cand.id}`, null, atMs).run();
      } else if (result.verdict === "reject") {
        // Retire it so it stops consuming lease slots that could go to real coverage.
        await this.db.prepare("UPDATE scrape_recipes SET status = 'retired', retired_at = ? WHERE id = ?").bind(nowIso(atMs), cand.id).run();
      }
      out.push({ recipeId: cand.id, sourceId: cand.source_id, verdict: result.verdict, reason: result.reason });
    }
    return out;
  }

  /**
   * Undo the last promotion for a source: retire what's live, restore the highest-versioned
   * recipe that was previously active. One call, no deploy — which is the price of being
   * willing to promote automatically at all.
   */
  async rollbackRecipe(sourceId: string, atMs: number = Date.now()): Promise<boolean> {
    const live = await this.db.prepare("SELECT id FROM scrape_recipes WHERE source_id = ? AND status = 'active'").bind(sourceId).first<Row>();
    if (!live) return false;
    const previous = await this.db
      .prepare(
        `SELECT id FROM scrape_recipes
          WHERE source_id = ? AND id <> ? AND status = 'retired' AND promoted_at IS NOT NULL
          ORDER BY version DESC LIMIT 1`,
      )
      .bind(sourceId, live.id)
      .first<Row>();
    if (!previous) return false;

    await this.swapActive(sourceId, previous.id, live.id, atMs);
    await this.recordAudit(live.id, sourceId, previous.id, "rollback", "promotion rolled back by hand", {}, atMs);
    return true;
  }

  /**
   * Retire the incumbent, then activate the winner — in that order, because the partial
   * unique index `idx_recipe_active` makes two live recipes for one source unrepresentable.
   * The constraint dictating the order is the point: nothing has to remember it.
   */
  private async swapActive(sourceId: string, winnerId: string, loserId: string | null, atMs: number): Promise<void> {
    if (loserId) {
      await this.db.prepare("UPDATE scrape_recipes SET status = 'retired', retired_at = ? WHERE id = ?").bind(nowIso(atMs), loserId).run();
    }
    await this.db
      .prepare("UPDATE scrape_recipes SET status = 'active', promoted_at = COALESCE(promoted_at, ?), retired_at = NULL WHERE id = ?")
      .bind(nowIso(atMs), winnerId)
      .run();
    void sourceId;
  }

  private async recordAudit(
    recipeId: string,
    sourceId: string,
    incumbentId: string | null,
    verdict: string,
    reason: string,
    stats: unknown,
    atMs: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO recipe_audits (id, recipe_id, source_id, incumbent_id, verdict, reason, stats_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(ulid(), recipeId, sourceId, incumbentId, verdict, reason.slice(0, 500), JSON.stringify(stats), nowIso(atMs))
      .run();
  }

  // ── hosts ───────────────────────────────────────────────────────────────────
  /** Every host we touch needs a budget row before it can be leased. */
  async ensureHosts(hosts: string[]): Promise<void> {
    if (!hosts.length) return;
    for (const batch of chunk(hosts, 50)) {
      await this.db.batch(
        batch.map((h) =>
          this.db.prepare("INSERT OR IGNORE INTO scrape_hosts (host, min_gap_ms, max_concurrent) VALUES (?, ?, ?)").bind(h, defaultGapMs(h), 1),
        ),
      );
    }
  }

  async hostState(host: string, atMs: number): Promise<HostState | null> {
    const r = await this.db.prepare("SELECT * FROM scrape_hosts WHERE host = ?").bind(host).first<Row>();
    if (!r) return null;
    const live = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM scrape_leases l JOIN scrape_jobs j ON j.id = l.job_id
          WHERE j.host = ? AND l.expires_at > ? AND l.submitted_at IS NULL AND l.released_at IS NULL`,
      )
      .bind(host, nowIso(atMs))
      .first<Row>();
    return toHostState(r, live?.n ?? 0);
  }

  /** Record what robots.txt told us. `crawl_delay_ms` only ever widens the gap we honour. */
  async setRobots(
    host: string,
    r: { crawlDelayMs: number | null; disallow: string[]; allow?: string[]; status: number | null },
    atMs: number = Date.now(),
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE scrape_hosts SET crawl_delay_ms = ?, disallow_json = ?, allow_json = ?, robots_status = ?, robots_fetched_at = ? WHERE host = ?`,
      )
      .bind(r.crawlDelayMs, JSON.stringify(r.disallow.slice(0, 200)), JSON.stringify((r.allow ?? []).slice(0, 200)), r.status, nowIso(atMs), host)
      .run();
  }

  /** A host told us to back off. The one signal we never argue with. */
  async blockHost(host: string, untilMs: number): Promise<void> {
    await this.db.prepare("UPDATE scrape_hosts SET blocked_until = ? WHERE host = ?").bind(nowIso(untilMs), host).run();
  }

  /**
   * A worker reported that this host refused us. Escalates: `rebuffs` climbs, and the block
   * doubles with it (see `backoffUntilMs`), because one 429 is noise and four in a row is a
   * message.
   *
   * Only a REFUSAL counts — a 500 is the host having a bad day, not asking us to stop, and
   * treating it as one would take us off a source for an hour every time somebody deployed.
   */
  async noteRebuff(host: string, retryAfterMs: number | null = null, atMs: number = Date.now()): Promise<{ blockedUntil: string }> {
    await this.db.prepare("UPDATE scrape_hosts SET rebuffs = rebuffs + 1 WHERE host = ?").bind(host).run();
    const row = await this.db.prepare("SELECT rebuffs FROM scrape_hosts WHERE host = ?").bind(host).first<Row>();
    const until = backoffUntilMs(row?.rebuffs ?? 1, atMs, retryAfterMs);
    await this.blockHost(host, until);
    return { blockedUntil: nowIso(until) };
  }

  /** A clean run. Forgets the streak so one bad afternoon can't hold a source hostage. */
  async clearRebuffs(host: string): Promise<void> {
    await this.db
      .prepare("UPDATE scrape_hosts SET rebuffs = 0, blocked_until = NULL WHERE host = ? AND rebuffs > 0")
      .bind(host)
      .run();
  }

  /**
   * "Is the network working?", answerable without opening the database.
   *
   * Shaped around the questions an operator actually has on a fresh deploy, in the order they
   * bite: is anybody a member, is anybody running a worker, is there work planned, is a host
   * refusing us — and is the handshake key even configured, which is the failure that otherwise
   * looks like nothing at all.
   */
  async status(atMs: number = Date.now()): Promise<Record<string, unknown>> {
    const one = async (sql: string, ...binds: any[]) => ((await this.db.prepare(sql).bind(...binds).first<Row>())?.n ?? 0) as number;
    const byStatus = async (table: string, column = "status") => {
      const r = await this.db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${column}`).all<Row>();
      return Object.fromEntries((r.results || []).map((x) => [x.k, x.n]));
    };
    const recipes = await byStatus("scrape_recipes");
    const obs = await byStatus("scrape_observations");
    const now = nowIso(atMs);
    return {
      members: await one("SELECT COUNT(*) AS n FROM network_members WHERE quarantined_at IS NULL"),
      quarantined: await one("SELECT COUNT(*) AS n FROM network_members WHERE quarantined_at IS NOT NULL"),
      workers: await one("SELECT COUNT(*) AS n FROM worker_clients WHERE revoked_at IS NULL"),
      workersSeenToday: await one("SELECT COUNT(*) AS n FROM worker_clients WHERE revoked_at IS NULL AND last_seen_at >= ?", nowIso(atMs - 86_400_000)),
      recipes: { active: recipes.active ?? 0, shadow: recipes.shadow ?? 0, proposed: recipes.proposed ?? 0, retired: recipes.retired ?? 0 },
      jobs: {
        open: await one("SELECT COUNT(*) AS n FROM scrape_jobs WHERE status = 'open'"),
        leasedNow: await one("SELECT COUNT(*) AS n FROM scrape_leases WHERE expires_at > ? AND submitted_at IS NULL AND released_at IS NULL", now),
        submittedToday: await one("SELECT COUNT(*) AS n FROM scrape_leases WHERE submitted_at >= ?", nowIso(atMs - 86_400_000)),
      },
      observations: {
        pending: obs.pending ?? 0,
        confirmed: obs.confirmed ?? 0,
        published: obs.published ?? 0,
        contradicted: obs.contradicted ?? 0,
        quarantined: obs.quarantined ?? 0,
      },
      hosts: {
        total: await one("SELECT COUNT(*) AS n FROM scrape_hosts"),
        blocked: await one("SELECT COUNT(*) AS n FROM scrape_hosts WHERE blocked_until > ?", now),
        robotsChecked: await one("SELECT COUNT(*) AS n FROM scrape_hosts WHERE robots_fetched_at IS NOT NULL"),
      },
    };
  }

  /** Hosts whose robots.txt is stale, for the refresh cron. */
  async hostsNeedingRobots(olderThanMs: number, limit = 25): Promise<string[]> {
    const r = await this.db
      .prepare("SELECT host FROM scrape_hosts WHERE robots_fetched_at IS NULL OR robots_fetched_at < ? ORDER BY robots_fetched_at IS NOT NULL, host LIMIT ?")
      .bind(nowIso(olderThanMs), Math.max(1, Math.min(100, limit)))
      .all<Row>();
    return (r.results || []).map((x) => x.host);
  }

  // ── jobs ────────────────────────────────────────────────────────────────────
  /**
   * Materialise one job per schedulable recipe for the current window. `UNIQUE (recipe_id,
   * window_start)` makes this idempotent, so cron can call it as often as it likes and a
   * double-fire creates nothing.
   */
  async plan(atMs: number = Date.now(), targetFor?: (r: Recipe) => number): Promise<{ created: number }> {
    const recipes = await this.schedulableRecipes();
    if (!recipes.length) return { created: 0 };
    const stmts = recipes.map((r) =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO scrape_jobs
             (id, recipe_id, source_id, host, window_start, window_ms, target_observers, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .bind(
          ulid(),
          r.id,
          r.sourceId,
          r.host,
          windowStart(atMs, r.windowMs),
          r.windowMs,
          targetFor ? targetFor(r) : r.status === "shadow" ? 3 : 2,
          nowIso(atMs),
        ),
    );
    let created = 0;
    for (const batch of chunk(stmts, 50)) {
      const res: any[] = await this.db.batch(batch);
      created += res.reduce((n, x) => n + (x?.meta?.changes ?? 0), 0);
    }
    return { created };
  }

  /**
   * Reclaim leases whose holder went away. A laptop that closes its lid must not hold a
   * source hostage — but the TTL is generous (LEASE_TTL_MS), because handing the same job
   * to a second worker while the first is still politely paginating would double our load
   * on the host, which is the exact thing leases exist to prevent.
   */
  async expireLeases(atMs: number = Date.now()): Promise<number> {
    const res: any = await this.db
      .prepare(
        `UPDATE scrape_leases SET released_at = ?, outcome = 'expired'
          WHERE expires_at <= ? AND submitted_at IS NULL AND released_at IS NULL`,
      )
      .bind(nowIso(atMs), nowIso(atMs))
      .run();
    return res?.meta?.changes ?? 0;
  }

  // ── leasing ─────────────────────────────────────────────────────────────────
  /**
   * Hand out work, or explain why not.
   *
   * Candidate jobs are ordered by fewest observers first, then oldest window: coverage
   * before freshness, so a job nobody has looked at beats a second opinion on one that
   * already has two. Within that, four filters apply — capability, independence, fair
   * share, politeness — and only the last one can consume a host's grant token.
   */
  async lease(req: LeaseRequest, atMs: number = Date.now()): Promise<LeaseOutcome> {
    const max = Math.max(1, Math.min(10, Math.trunc(req.max) || 1));
    const perWindowCap = Math.max(1, Math.trunc(req.perWindowCap ?? 6));
    const now = nowIso(atMs);
    const leases: GrantedLease[] = [];
    const skipped: LeaseOutcome["skipped"] = [];

    const rows = await this.db
      .prepare(
        `SELECT j.id AS job_id, j.recipe_id, j.source_id, j.host, j.window_start, j.window_ms, j.target_observers,
                r.type, r.params_json, r.requires_json,
                (SELECT COUNT(*) FROM scrape_leases l WHERE l.job_id = j.id AND l.outcome IS NOT 'expired') AS taken,
                (SELECT COUNT(*) FROM scrape_leases l WHERE l.job_id = j.id AND l.member_id = ?) AS mine
           FROM scrape_jobs j
           JOIN scrape_recipes r ON r.id = j.recipe_id
          WHERE j.status = 'open' AND r.status IN ('active','shadow')
          ORDER BY taken ASC, j.window_start ASC
          LIMIT 200`,
      )
      .bind(req.memberId)
      .all<Row>();

    // Fair share: how much this member already holds in the current window. Ordering by
    // `taken` protects coverage; this protects newcomers from a whale that polls in a
    // tight loop and farms every job before anyone else wakes up.
    const held = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM scrape_leases WHERE member_id = ? AND granted_at >= ? AND (outcome IS NULL OR outcome = 'submitted')`,
      )
      .bind(req.memberId, nowIso(atMs - 60 * 60_000))
      .first<Row>();
    let budget = Math.max(0, perWindowCap - (held?.n ?? 0));

    const caps = new Set(req.capabilities || []);

    for (const row of rows.results || []) {
      if (leases.length >= max) break;
      if (budget <= 0) {
        skipped.push({ host: row.host, reason: "fair_share" });
        break;
      }
      if (!windowIsOpen(row.window_start, row.window_ms, atMs)) continue;
      if ((row.taken ?? 0) >= (row.target_observers ?? 2)) continue;
      if ((row.mine ?? 0) > 0) continue; // one observation per member per job, ever

      const requires: WorkerCapability[] = JSON.parse(row.requires_json || '["fetch"]');
      if (!requires.every((cap) => caps.has(cap))) {
        skipped.push({ host: row.host, reason: "capability" });
        continue;
      }

      if (await this.sharesEgress(row.job_id, req.egress)) {
        // Two accounts behind one NAT are one observer wearing two hats; letting them
        // corroborate each other is precisely how a Sybil publishes whatever it likes.
        skipped.push({ host: row.host, reason: "independence" });
        continue;
      }

      const state = await this.hostState(row.host, atMs);
      if (!state) {
        await this.ensureHosts([row.host]);
        skipped.push({ host: row.host, reason: "too_soon" });
        continue;
      }
      const verdict = mayLease(state, atMs);
      if (verdict !== "ok") {
        skipped.push({ host: row.host, reason: verdict });
        continue;
      }
      // Storing the disallow list and then leasing anyway would be theatre. This is the
      // enforcement point: the coordinator refuses the work, rather than trusting fifty
      // volunteer clients to each refuse it themselves.
      const rules = await this.robotsFor(row.host);
      if (!pathAllowed(rules.disallow, rules.allow, recipePath(row.type, JSON.parse(row.params_json || "{}")))) {
        skipped.push({ host: row.host, reason: "robots" });
        continue;
      }
      if (!(await this.takeHostGrant(state, atMs))) {
        // Someone beat us to this host by microseconds. Not an error — the gap held.
        skipped.push({ host: row.host, reason: "too_soon" });
        continue;
      }

      const leaseId = ulid();
      const expiresAt = nowIso(atMs + LEASE_TTL_MS);
      try {
        await this.db
          .prepare(
            `INSERT INTO scrape_leases (id, job_id, client_id, member_id, egress_ip_hash, egress_asn, granted_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(leaseId, row.job_id, req.clientId, req.memberId, req.egress.ipHash ?? null, req.egress.asn ?? null, now, expiresAt)
          .run();
      } catch {
        // UNIQUE (job_id, client_id) — this client already holds this job. The grant
        // token is spent either way, which is the conservative direction to err in.
        continue;
      }

      budget--;
      leases.push({
        leaseId,
        jobId: row.job_id,
        sourceId: row.source_id,
        recipeId: row.recipe_id,
        windowStart: row.window_start,
        expiresAt,
        recipe: { type: row.type, params: JSON.parse(row.params_json || "{}"), host: row.host },
        politeness: { host: row.host, minGapMs: effectiveGapMs(state), disallow: rules.disallow },
      });
    }

    return { leases, skipped };
  }

  /** Has anyone on this egress already taken this job? */
  private async sharesEgress(jobId: string, egress: { ipHash?: string | null; asn?: number | null }): Promise<boolean> {
    if (!egress.ipHash && egress.asn == null) return false;
    const r = await this.db
      .prepare(
        `SELECT 1 FROM scrape_leases WHERE job_id = ? AND outcome IS NOT 'expired'
           AND ((? IS NOT NULL AND egress_ip_hash = ?) OR (? IS NOT NULL AND egress_asn = ?)) LIMIT 1`,
      )
      .bind(jobId, egress.ipHash ?? null, egress.ipHash ?? null, egress.asn ?? null, egress.asn ?? null)
      .first();
    return !!r;
  }

  /** A host's resolved robots rules, as stored. */
  private async robotsFor(host: string): Promise<{ disallow: string[]; allow: string[] }> {
    const r = await this.db.prepare("SELECT disallow_json, allow_json FROM scrape_hosts WHERE host = ?").bind(host).first<Row>();
    const parse = (v: unknown) => {
      try {
        const x = JSON.parse(String(v ?? "[]"));
        return Array.isArray(x) ? x : [];
      } catch {
        return [];
      }
    };
    return { disallow: parse(r?.disallow_json), allow: parse(r?.allow_json) };
  }

  /**
   * Take this host's grant token, atomically. See the class doc: this is where the
   * fleet-wide gap is actually enforced, and `changes === 1` is the whole guarantee.
   */
  private async takeHostGrant(state: HostState, atMs: number): Promise<boolean> {
    const now = nowIso(atMs);
    const threshold = nowIso(atMs - effectiveGapMs(state));
    const day = dayKey(atMs);
    const res: any = await this.db
      .prepare(
        `UPDATE scrape_hosts
            SET last_granted_at = ?,
                granted_today = CASE WHEN granted_day = ? THEN granted_today + 1 ELSE 1 END,
                granted_day = ?
          WHERE host = ?
            AND (blocked_until IS NULL OR blocked_until <= ?)
            AND (last_granted_at IS NULL OR last_granted_at <= ?)
            AND (daily_cap IS NULL OR granted_day IS NOT ? OR granted_today < daily_cap)`,
      )
      .bind(now, day, day, state.host, now, threshold, day)
      .run();
    return (res?.meta?.changes ?? 0) === 1;
  }

  // ── lease lifecycle ─────────────────────────────────────────────────────────
  async leaseById(leaseId: string): Promise<Row | null> {
    return await this.db
      .prepare(
        `SELECT l.*, j.recipe_id, j.source_id, j.host, j.window_start, j.window_ms, j.target_observers
           FROM scrape_leases l JOIN scrape_jobs j ON j.id = l.job_id WHERE l.id = ?`,
      )
      .bind(leaseId)
      .first<Row>();
  }

  async markSubmitted(leaseId: string, atMs: number = Date.now()): Promise<boolean> {
    const res: any = await this.db
      .prepare("UPDATE scrape_leases SET submitted_at = ?, outcome = 'submitted' WHERE id = ? AND submitted_at IS NULL AND released_at IS NULL")
      .bind(nowIso(atMs), leaseId)
      .run();
    return (res?.meta?.changes ?? 0) === 1;
  }

  /** A client giving work back honestly — it failed, or it's shutting down. */
  async release(leaseId: string, clientId: string, outcome: "failed" | "released", error?: string, atMs: number = Date.now()): Promise<boolean> {
    const res: any = await this.db
      .prepare(
        `UPDATE scrape_leases SET released_at = ?, outcome = ?, error = ?
          WHERE id = ? AND client_id = ? AND submitted_at IS NULL AND released_at IS NULL`,
      )
      .bind(nowIso(atMs), outcome, error?.slice(0, 500) ?? null, leaseId, clientId)
      .run();
    return (res?.meta?.changes ?? 0) === 1;
  }

  // ── observations & consensus ─────────────────────────────────────────────────
  /**
   * Record what a worker reported. `item_key` and `fingerprint` are computed by the
   * caller from the SERVER's own normalisation — never accepted from the client — and
   * `UNIQUE (lease_id, item_key)` makes a client listing the same event twice one
   * sighting rather than two, without the route having to dedupe defensively.
   */
  async recordObservations(
    o: { leaseId: string; jobId: string; memberId: string },
    items: Array<{ itemKey: string; fingerprint: string; payload: unknown }>,
    atMs: number = Date.now(),
  ): Promise<number> {
    if (!items.length) return 0;
    let n = 0;
    for (const batch of chunk(items, 20)) {
      const res: any[] = await this.db.batch(
        batch.map((it) =>
          this.db
            .prepare(
              `INSERT OR IGNORE INTO scrape_observations
                 (id, lease_id, job_id, member_id, item_key, fingerprint, payload_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(ulid(), o.leaseId, o.jobId, o.memberId, it.itemKey, it.fingerprint, JSON.stringify(it.payload), nowIso(atMs)),
        ),
      );
      n += res.reduce((acc, r) => acc + (r?.meta?.changes ?? r?.changes ?? 0), 0);
    }
    return n;
  }

  /** Everything consensus needs about one job: who looked, and what they each reported. */
  async jobEvidence(jobId: string): Promise<{
    leases: Array<{ leaseId: string; memberId: string; cluster: string; tier: "probation" | "trusted" | "core"; completed: boolean }>;
    observations: Array<{ id: string; leaseId: string; itemKey: string; status: string }>;
  }> {
    const ls = await this.db
      .prepare(
        `SELECT l.id, l.member_id, l.egress_ip_hash, l.egress_asn, l.submitted_at, COALESCE(m.tier, 'probation') AS tier
           FROM scrape_leases l LEFT JOIN network_members m ON m.user_id = l.member_id
          WHERE l.job_id = ?`,
      )
      .bind(jobId)
      .all<Row>();
    const os = await this.db
      .prepare("SELECT id, lease_id, item_key, status FROM scrape_observations WHERE job_id = ?")
      .bind(jobId)
      .all<Row>();
    return {
      leases: (ls.results || []).map((r) => ({
        leaseId: r.id,
        memberId: r.member_id,
        // Independence key. Falling back to the lease id means "assume independent",
        // which is the right default: a missing egress is our gap in observability, not
        // evidence that two workers are the same person.
        cluster: r.egress_ip_hash || (r.egress_asn != null ? `asn:${r.egress_asn}` : `lease:${r.id}`),
        tier: r.tier,
        completed: !!r.submitted_at,
      })),
      observations: (os.results || []).map((r) => ({ id: r.id, leaseId: r.lease_id, itemKey: r.item_key, status: r.status })),
    };
  }

  /**
   * Write consensus verdicts back. Only moves rows whose status actually changes, and
   * never touches one that already `published` — a promoted event is a fact about the
   * catalog, and re-deciding it would flap the public data on every submission.
   *
   * A contradicted item that a later independent worker confirms DOES move back, which is
   * the retroactive fairness the reputation model depends on.
   */
  async applyVerdicts(
    verdicts: Array<{ observationIds: string[]; status: "pending" | "confirmed" | "contradicted" }>,
    atMs: number = Date.now(),
  ): Promise<{ changed: number; retracted: Array<{ id: string; eventId: string }> }> {
    // A published row may still be CONTRADICTED. Without this the tiered-publish rule
    // would quietly become unfalsifiable: a trusted member publishes alone, and the
    // evidence that arrives afterwards can never touch it. Earning the right to publish
    // alone means nobody has to corroborate you; it cannot mean nobody may disagree.
    //
    // It may not be walked back to `pending`, though — "we're no longer sure" is not a
    // reason to yank live data. Only positive evidence against it is.
    const contradicted = new Set(verdicts.filter((v) => v.status === "contradicted").flatMap((v) => v.observationIds));
    const retracted: Array<{ id: string; eventId: string }> = [];
    if (contradicted.size) {
      for (const idBatch of chunk([...contradicted], 40)) {
        const r = await this.db
          .prepare(
            `SELECT id, event_id FROM scrape_observations
              WHERE status = 'published' AND event_id IS NOT NULL AND id IN (${idBatch.map(() => "?").join(",")})`,
          )
          .bind(...idBatch)
          .all<Row>();
        for (const row of r.results || []) retracted.push({ id: row.id, eventId: row.event_id });
      }
    }

    const stmts: any[] = [];
    for (const v of verdicts) {
      const allowPublished = v.status === "contradicted";
      for (const idBatch of chunk(v.observationIds, 40)) {
        stmts.push(
          this.db
            .prepare(
              `UPDATE scrape_observations SET status = ?, resolved_at = ?
                WHERE id IN (${idBatch.map(() => "?").join(",")})
                  AND status <> 'quarantined' AND status <> ?
                  ${allowPublished ? "" : "AND status <> 'published'"}`,
            )
            .bind(v.status, nowIso(atMs), ...idBatch, v.status),
        );
      }
    }
    let changed = 0;
    for (const batch of chunk(stmts, 25)) {
      const res: any[] = await this.db.batch(batch);
      changed += res.reduce((n, r) => n + (r?.meta?.changes ?? r?.changes ?? 0), 0);
    }
    return { changed, retracted };
  }

  /**
   * Pull a retracted event out of the public catalog by HIDING it, never by deleting it.
   *
   * A contradiction means the only worker who ever reported this event is now disbelieved,
   * so nothing supports its being public. But `hidden` is the reversible action this repo
   * already uses everywhere for exactly this situation — the row, its provenance and the
   * observation that produced it all survive for a human to look at, and un-hiding is one
   * UPDATE if the contradiction turns out to have been the wrong call.
   */
  async retractEvents(eventIds: string[], atMs: number = Date.now()): Promise<number> {
    const ids = [...new Set(eventIds)];
    if (!ids.length) return 0;
    let n = 0;
    for (const batch of chunk(ids, 40)) {
      const res: any = await this.db
        .prepare(`UPDATE events SET hidden = 1, last_seen_at = last_seen_at WHERE hidden = 0 AND id IN (${batch.map(() => "?").join(",")})`)
        .bind(...batch)
        .run();
      n += res?.meta?.changes ?? 0;
    }
    void atMs;
    return n;
  }

  /** Who vouched for these members — the people whose standing their behaviour touches. */
  async vouchersOf(memberIds: string[]): Promise<string[]> {
    const out = new Set<string>();
    for (const batch of chunk(memberIds, 40)) {
      const r = await this.db
        .prepare(`SELECT DISTINCT vouched_by FROM network_members WHERE vouched_by IS NOT NULL AND user_id IN (${batch.map(() => "?").join(",")})`)
        .bind(...batch)
        .all<Row>();
      for (const row of r.results || []) out.add(row.vouched_by);
    }
    return [...out];
  }

  /** Confirmed observations that haven't reached the catalog yet. */
  async pendingPromotions(jobId: string): Promise<Array<{ id: string; fingerprint: string; payload: any; memberId: string }>> {
    const r = await this.db
      .prepare("SELECT id, fingerprint, payload_json, member_id FROM scrape_observations WHERE job_id = ? AND status = 'confirmed'")
      .bind(jobId)
      .all<Row>();
    return (r.results || []).map((x) => ({ id: x.id, fingerprint: x.fingerprint, payload: JSON.parse(x.payload_json), memberId: x.member_id }));
  }

  /** Attach promoted observations to the events they became. */
  async markPublished(pairs: Array<{ id: string; eventId: string }>, atMs: number = Date.now()): Promise<void> {
    if (!pairs.length) return;
    for (const batch of chunk(pairs, 30)) {
      await this.db.batch(
        batch.map((p) =>
          this.db
            .prepare("UPDATE scrape_observations SET status = 'published', event_id = ?, resolved_at = ? WHERE id = ?")
            .bind(p.eventId, nowIso(atMs), p.id),
        ),
      );
    }
  }

  /** Map fingerprints to the event rows they now live in (post-upsert). */
  async eventIdsByFingerprint(fingerprints: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const batch of chunk([...new Set(fingerprints)])) {
      const r = await this.db
        .prepare(`SELECT id, fingerprint FROM events WHERE fingerprint IN (${batch.map(() => "?").join(",")})`)
        .bind(...batch)
        .all<Row>();
      for (const row of r.results || []) out.set(row.fingerprint, row.id);
    }
    return out;
  }

  // ── scoring ─────────────────────────────────────────────────────────────────
  /**
   * Rescore a member from their observations, and write the tier the evidence supports.
   *
   * RECOMPUTED, never incremented. That is the whole design of this method and it buys
   * three things that a running delta cannot: consensus can re-run any number of times
   * without double-counting, a contradiction that a later worker overturns is refunded
   * automatically (the row simply isn't `contradicted` any more, so it stops being
   * counted), and a bug in one submission can't leave a permanent scar on somebody's
   * reputation — the next pass heals it.
   *
   * Counted by DISTINCT item_key, not by row: re-scraping the same event tomorrow is
   * honest work but it is not a second contribution, and paying for it would make
   * re-scraping the most profitable thing a member could do.
   */
  async rescoreMember(userId: string, atMs: number = Date.now()): Promise<void> {
    const own = await this.db
      .prepare(
        `SELECT
           COUNT(DISTINCT CASE WHEN status IN ('confirmed','published') THEN item_key END) AS confirms,
           COUNT(DISTINCT CASE WHEN status = 'contradicted' THEN item_key END) AS contradictions,
           COUNT(DISTINCT CASE WHEN status IN ('confirmed','published') THEN substr(COALESCE(resolved_at, created_at), 1, 10) END) AS days
         FROM scrape_observations WHERE member_id = ?`,
      )
      .bind(userId)
      .first<Row>();

    // What this member owes for people they vouched for. Only while the invitee is still
    // on probation: vouching covers somebody's first steps, not their whole career.
    const vouch = await this.db
      .prepare(
        `SELECT COUNT(DISTINCT o.member_id || '|' || o.item_key) AS n
           FROM scrape_observations o
           JOIN network_members m ON m.user_id = o.member_id
          WHERE m.vouched_by = ? AND m.tier = 'probation' AND o.status = 'contradicted'`,
      )
      .bind(userId)
      .first<Row>();

    const row = await this.db.prepare("SELECT joined_at, last_scored_at, founding FROM network_members WHERE user_id = ?").bind(userId).first<Row>();
    if (!row) return;

    const stats: MemberStats = {
      confirms: own?.confirms ?? 0,
      contradictions: own?.contradictions ?? 0,
      distinctDays: own?.days ?? 0,
      vouchDebits: vouch?.n ?? 0,
      joinedAt: row.joined_at,
      // Score against NOW, not against the stale anchor: a member who just had work
      // judged is active by definition, and decaying them for the gap before it would
      // punish them for the network having been quiet.
      lastScoredAt: nowIso(atMs),
    };

    const earned = tierOf(stats, atMs);
    // A founding member keeps `core` as a FLOOR. They have no observations of their own — they
    // were never vouched for, they were configured — so recomputing their tier from evidence
    // would demote the operator the first time one of their invitees did any work, and vouching
    // requires `trusted`. The network would then be unable to admit a third person. See the
    // `founding` column's comment in migrations/0023.
    const tier = row.founding ? "core" : earned;
    const trust = trustScore(stats, atMs);
    // Quarantine still applies to a founder: it holds unresolved data rather than lowering
    // standing, and the operator is exactly who should notice their own machine misbehaving.
    const quarantine = shouldQuarantine(stats, atMs);

    await this.db
      .prepare(
        `UPDATE network_members
            SET confirms = ?, contradictions = ?, distinct_days = ?, vouch_debits = ?,
                trust = ?, tier = ?, last_scored_at = ?
          WHERE user_id = ?`,
      )
      .bind(stats.confirms, stats.contradictions, stats.distinctDays, stats.vouchDebits ?? 0, trust, tier, nowIso(atMs), userId)
      .run();

    if (quarantine) await this.quarantineMember(userId, atMs);
  }

  /** Everyone who has a lease on this job — the set whose standing just moved. */
  async jobMembers(jobId: string): Promise<string[]> {
    const r = await this.db.prepare("SELECT DISTINCT member_id FROM scrape_leases WHERE job_id = ?").bind(jobId).all<Row>();
    return (r.results || []).map((x) => x.member_id);
  }

  /**
   * Pay for the work a job settled. First to report an item is the finder; everyone else
   * corroborated. Both are worth something, and `dedup_key UNIQUE` on the ledger means
   * running this on every submission — which we do, because consensus re-runs — pays each
   * contribution exactly once, forever.
   */
  async awardJobPoints(jobId: string, atMs: number = Date.now()): Promise<{ finds: number; confirms: number }> {
    const r = await this.db
      .prepare(
        `SELECT item_key, member_id, event_id FROM scrape_observations
          WHERE job_id = ? AND status IN ('confirmed','published')
          ORDER BY item_key, created_at, id`,
      )
      .bind(jobId)
      .all<Row>();

    const stmts: any[] = [];
    let finds = 0;
    let confirms = 0;
    let currentItem = "";
    for (const o of r.results || []) {
      const isFinder = o.item_key !== currentItem;
      currentItem = o.item_key;
      if (isFinder) {
        finds++;
        // Keyed on the ITEM, not on the member: an item is discovered once, by whoever
        // got there first, and no later observer can also be paid as its finder.
        stmts.push(this.awardStmt(o.member_id, "scrape_find", `scrape_find:${o.item_key}`, o.event_id, atMs));
      } else {
        confirms++;
        stmts.push(this.awardStmt(o.member_id, "scrape_confirm", `scrape_confirm:${o.item_key}:${o.member_id}`, o.event_id, atMs));
      }
    }
    for (const batch of chunk(stmts, 20)) await this.db.batch(batch);
    return { finds, confirms };
  }

  /** Paid for turning up and completing a job, whatever consensus later decides. */
  async awardLeaseCompletion(memberId: string, leaseId: string, atMs: number = Date.now()): Promise<void> {
    await this.awardStmt(memberId, "scrape_job", `scrape_job:${leaseId}`, null, atMs).run();
  }

  /**
   * The house pattern for points: the server picks the value from `POINTS`, the caller
   * supplies only a dedup key, and `INSERT OR IGNORE` against the UNIQUE key makes every
   * award idempotent. Never accepts a point value from anywhere.
   */
  private awardStmt(userId: string, kind: PointKind, dedupKey: string, eventId: string | null, atMs: number): any {
    return this.db
      .prepare("INSERT OR IGNORE INTO points_ledger (id, user_id, kind, points, event_id, dedup_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(ulid(), userId, kind, POINTS[kind], eventId, dedupKey, nowIso(atMs));
  }

  /**
   * The contributor board. Ranked by confirmed finds rather than by raw points, because
   * points also accrue from turning up — and the question the board answers is "who is
   * actually filling the catalog?".
   *
   * Honours `users.attribution_opt_out`: someone who has asked not to be credited
   * publicly is not credited publicly, including here.
   */
  async leaderboard(limit = 50): Promise<Array<{ id: string; handle: string; displayName: string; tier: string; trust: number; finds: number; confirms: number; points: number }>> {
    const r = await this.db
      .prepare(
        `SELECT u.id, u.handle, u.display_name, m.tier, m.trust, m.confirms,
                COALESCE((SELECT COUNT(*) FROM points_ledger p WHERE p.user_id = u.id AND p.kind = 'scrape_find'), 0) AS finds,
                COALESCE((SELECT SUM(p.points) FROM points_ledger p WHERE p.user_id = u.id
                           AND p.kind IN ('scrape_find','scrape_confirm','scrape_job','recipe')), 0) AS points
           FROM network_members m
           JOIN users u ON u.id = m.user_id
          WHERE u.attribution_opt_out = 0 AND u.banned_at IS NULL
          ORDER BY finds DESC, m.trust DESC, u.handle ASC
          LIMIT ?`,
      )
      .bind(Math.max(1, Math.min(200, limit)))
      .all<Row>();
    return (r.results || []).map((x) => ({
      id: x.id,
      handle: x.handle,
      displayName: x.display_name,
      tier: x.tier,
      trust: x.trust,
      finds: x.finds ?? 0,
      confirms: x.confirms ?? 0,
      points: x.points ?? 0,
    }));
  }

  /**
   * Hold everything a member has pending. Held, never deleted and never published —
   * quarantine is a pause on trust, not a verdict on the data, and a human unquarantining
   * them lets the next consensus pass judge it on the evidence.
   */
  async quarantineMember(memberId: string, atMs: number = Date.now()): Promise<{ held: number }> {
    await this.db
      .prepare("UPDATE network_members SET quarantined_at = COALESCE(quarantined_at, ?) WHERE user_id = ?")
      .bind(nowIso(atMs), memberId)
      .run();
    const res: any = await this.db
      .prepare("UPDATE scrape_observations SET status = 'quarantined', resolved_at = ? WHERE member_id = ? AND status IN ('pending','confirmed')")
      .bind(nowIso(atMs), memberId)
      .run();
    return { held: res?.meta?.changes ?? 0 };
  }

  async saveReceipts(leaseId: string, receipts: Array<{ url: string; status?: number | null; bytes?: number | null; serverDate?: string | null; etag?: string | null; elapsedMs?: number | null }>): Promise<void> {
    if (!receipts.length) return;
    for (const batch of chunk(receipts.slice(0, 200), 30)) {
      await this.db.batch(
        batch.map((r) =>
          this.db
            .prepare("INSERT INTO scrape_receipts (id, lease_id, url, status, bytes, server_date, etag, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(ulid(), leaseId, r.url.slice(0, 2000), r.status ?? null, r.bytes ?? null, r.serverDate ?? null, r.etag?.slice(0, 200) ?? null, r.elapsedMs ?? null),
        ),
      );
    }
  }
}

/**
 * Our own floor per host, before robots.txt gets a say. Eventbrite's 900ms is inherited
 * from HOST_MIN_GAP_MS in src/sources/util/http.ts — it was tuned against the real site
 * and there's no reason to relearn it.
 */
export function defaultGapMs(host: string): number {
  if (host.endsWith("eventbrite.com")) return 900;
  return 1000;
}

/**
 * What a recipe needs from a client. Derived rather than declared, so nobody has to
 * remember: a source configured to drive a real browser can only run where there is one.
 */
export function requiresFor(type: string, params: Record<string, unknown> = {}): WorkerCapability[] {
  if (params.useBrowser === true || params.mode === "browser") return ["fetch", "browser"];
  if (type === "airtable" && params.mode === "share") return ["fetch", "browser"];
  return ["fetch"];
}
