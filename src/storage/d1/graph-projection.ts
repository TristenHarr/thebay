import type { D1Database } from "@cloudflare/workers-types";
import { EDGE_SPEC, nodeId, orderPair, type GraphEdge, type GraphEdgeKind, type GraphNode, type GraphResult } from "../../core/graph/types";
import { evidenceOf } from "../../core/graph/evidence";
import { degrees, edgeStrength, mergeEdges, rankEdges } from "../../core/graph/strength";
import { ANON_VIEWER, canSeeUser, type UserFacts, type ViewerCtx } from "../../core/graph/visibility";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

/**
 * THE ONLY module that reads the tables to build a graph.
 *
 * ## Why a query-time projection and not a `graph_edges` table
 *
 * Every candidate edge is ALREADY a row, and that row IS the evidence.
 * `checkins(user_id, event_id, at, source)` under a composite primary key is the edge, its
 * citation and its timestamp, all at once. A materialized edge table would carry zero new
 * information — it would be 100% derived, which is exactly the category CLAUDE.md flags in
 * bold as having burned this repo twice.
 *
 * The `events_fts` precedent does not transfer, and the reason is the failure mode. A stale
 * FTS index is a search miss. A stale edge table publishes a relationship a user revoked.
 * Mirroring visibility into one would mean tracking `social_enabled`, `banned_at`,
 * `attribution_opt_out`, `friendships.status='blocked'`, `stories.dead`, `events.hidden`,
 * `places.hidden`, `shadows.mod_status`, `shadows.expires_at`, `company_people.user_id` and
 * `outcomes.visibility` — eleven UPDATE-driven columns across nine tables, where every
 * forgotten trigger is a privacy incident rather than a degraded index.
 *
 * And `shadows.expires_at` settles it outright: expiry is TIME-based, so **no trigger fires
 * when a shadow expires**. A trigger design is structurally incapable of staying correct
 * there, not merely risky. A projection reads `expires_at > ?` and is right to the
 * microsecond, for free.
 *
 * ## The cost, bounded on purpose
 *
 * Statement count is a function of hop depth and edge-kind count — never of graph size:
 * ~13 statements for a typical ego-net, ~40 worst case. Every multi-id predicate goes
 * through the ONE chunk helper below, at 90 (45 where the list is bound twice), because
 * `tests/helpers/d1.ts` enforces D1's 100-parameter cap and an unchunked `IN (…)` is a bug
 * that passes every small-fixture test and 500s in production. `GraphRepo.edgesTouching` is
 * the precedent; `ShadowsRepo.activeInCells` is the counter-example still on disk.
 *
 * Do NOT reach for `db.batch()` on reads: the test shim's `batch()` maps through
 * `execSync()`/`.run()` and cannot return SELECT rows, so batched reads would be silently
 * empty in tests and correct in production.
 */

/** Bind budget per statement. 90 for a single bind, 45 when the list is bound twice. */
const CHUNK = 90;
const CHUNK_DOUBLE = 45;

/** Hard ceilings. Bounded on the SERVER so a client cannot ask for the whole Bay. */
export const MAX_NODES = 300;
export const MAX_EDGES = 400;
/** How many hop-1 events we expand at hop 2. Beyond this the picture is unreadable anyway. */
export const MAX_ANCHORS = 60;

/**
 * Most attendee rows one hop-2 chunk may return.
 *
 * Without this the expansion is unbounded in the ONE dimension nothing else caps: a conference
 * with 5,000 check-ins returns 5,000 rows per query, all of which are then filtered, merged and
 * thrown away. The node cap is applied far too late to help. Ordered by `at DESC` so the rows
 * that survive are the most recent, which is also what recency-decayed strength would have kept.
 */
export const MAX_HOP2_ROWS = 600;

/**
 * Most attendees of a single event that `?collapse=1` will pair up.
 *
 * Collapsing is O(k²): a 300-person event is 44,850 synthetic edges, generated and then
 * truncated to 400 — tens of thousands of objects allocated to keep a fraction of one percent.
 * 40 caps it at 780 pairs per event, which is already more than the whole graph will draw.
 */
export const MAX_COLLAPSE_GROUP = 40;

const chunks = <T>(xs: readonly T[], size = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
};
const ph = (n: number) => Array(n).fill("?").join(",");

export interface ProjectionOpts {
  viewerId: string | null;
  /** 1 = me and what I touch. 2 = plus the people who touched the same things. */
  hops?: 1 | 2;
  include?: GraphEdgeKind[];
  /** Collapse user→event→user into a single `co_attended` edge carrying `evidence.via`. */
  collapse?: boolean;
  maxNodes?: number;
  maxEdges?: number;
  nowMs?: number;
}

const DEFAULT_KINDS: GraphEdgeKind[] = ["friendship", "vouched", "checkin", "rsvp", "hosted"];

export class GraphProjection {
  constructor(private db: D1Database) {}

  /**
   * Everything the viewer's own visibility depends on: are they banned, who are their
   * accepted friends, and who has blocked them (or been blocked by them).
   *
   * Computed FIRST and once. The block set in particular must exist before any edge is
   * built, because it is a hard cut that nothing else in the codebase enforces today.
   */
  async viewer(viewerId: string | null): Promise<ViewerCtx> {
    if (!viewerId) return ANON_VIEWER;
    const me = await this.db.prepare("SELECT id, banned_at FROM users WHERE id = ?").bind(viewerId).first<Row>();
    if (!me) return ANON_VIEWER;

    const rows = await this.db
      .prepare(
        `SELECT status, CASE WHEN user_low = ? THEN user_high ELSE user_low END AS other
           FROM friendships
          WHERE (user_low = ? OR user_high = ?) AND status IN ('accepted','blocked')`,
      )
      .bind(viewerId, viewerId, viewerId)
      .all<Row>();

    const friends = new Set<string>();
    const blocked = new Set<string>();
    for (const r of rows.results ?? []) (r.status === "blocked" ? blocked : friends).add(r.other);
    return { id: viewerId, banned: !!me.banned_at, friends, blocked };
  }

  /**
   * The viewer's ego-net as a typed, evidenced graph.
   *
   * Order of work: viewer context → hop-1 edges → hop-2 expansion → hydrate → FILTER →
   * merge → rank → truncate. The filter step is deliberately after hydration and before
   * anything is emitted, so there is exactly one place a hidden user can be dropped and no
   * way for an edge to outlive the node it points at.
   */
  async ego(opts: ProjectionOpts): Promise<GraphResult> {
    const nowMs = opts.nowMs ?? Date.now();
    const kinds = new Set(opts.include?.length ? opts.include : DEFAULT_KINDS);
    const hops = opts.hops ?? 2;
    const viewer = await this.viewer(opts.viewerId);

    const empty: GraphResult = { nodes: [], edges: [], omitted: { nodes: 0, edges: 0, noCoords: 0, outOfBay: 0, capped: false } };
    if (!viewer.id || viewer.banned) return empty;
    const me = viewer.id;

    const raw: GraphEdge[] = [];
    /** hop distance per node, so `canSeeUser` can apply the friend exemption correctly. */
    const hop = new Map<string, number>([[nodeId("user", me), 0]]);
    const noteHop = (id: string, h: number) => {
      const prev = hop.get(id);
      if (prev === undefined || h < prev) hop.set(id, h);
    };

    // ── hop 1: user ↔ user ────────────────────────────────────────────────────
    if (kinds.has("friendship")) {
      // Friendships among the WHOLE ego-net, not just the ones I'm an endpoint of. Drawing
      // only my own edges makes a star; including the edges between my friends makes the
      // triangle, and "my friends already know each other" is most of what an ego-net is for.
      //
      // Chunked at 45, not 90: the natural predicate binds the id list TWICE
      // (`user_low IN (…) OR user_high IN (…)`), which is the exact shape that used to 500 the
      // network graph in production while every small-fixture test passed. See
      // `GraphRepo.edgesTouching`.
      const egoIds = [me, ...viewer.friends];
      const inNet = new Set(egoIds);
      const seenPairs = new Set<string>();
      for (const c of chunks(egoIds, CHUNK_DOUBLE)) {
        const marks = ph(c.length);
        const r = await this.db
          .prepare(
            `SELECT user_low, user_high, updated_at FROM friendships
              WHERE status = 'accepted' AND (user_low IN (${marks}) OR user_high IN (${marks}))`,
          )
          .bind(...c, ...c)
          .all<Row>();
        for (const f of r.results ?? []) {
          // Both ends must be inside the ego-net, or we would leak a friend's other friends.
          if (!inNet.has(f.user_low) || !inNet.has(f.user_high)) continue;
          const key = `${f.user_low}|${f.user_high}`;
          if (seenPairs.has(key)) continue;
          seenPairs.add(key);
          for (const uid of [f.user_low, f.user_high]) if (uid !== me) noteHop(nodeId("user", uid), 1);
          const [a, b] = orderPair(nodeId("user", f.user_low), nodeId("user", f.user_high));
          raw.push({
            a,
            b,
            kind: "friendship",
            directed: false,
            strength: EDGE_SPEC.friendship.strength,
            evidence: [evidenceOf("stated", "friendships", { user_low: f.user_low, user_high: f.user_high }, f.updated_at ?? null)],
          });
        }
      }
    }

    if (kinds.has("vouched")) {
      // A redeemed invite is two phones in one place at one moment — the strongest edge in
      // the system, and the only one that arrives with real geometry attached.
      const r = await this.db
        .prepare(
          `SELECT id, ambassador_id, redeemed_by, redeemed_at, lat, lng
             FROM network_invites
            WHERE redeemed_by IS NOT NULL AND (ambassador_id = ? OR redeemed_by = ?)`,
        )
        .bind(me, me)
        .all<Row>();
      for (const v of r.results ?? []) {
        const other = v.ambassador_id === me ? v.redeemed_by : v.ambassador_id;
        if (!other || other === me) continue;
        noteHop(nodeId("user", other), 1);
        const [a, b] = orderPair(nodeId("user", me), nodeId("user", other));
        raw.push({
          a,
          b,
          kind: "vouched",
          directed: false,
          strength: edgeStrength(EDGE_SPEC.vouched.strength, v.redeemed_at, nowMs),
          evidence: [
            evidenceOf("attested", "network_invites", { id: v.id }, v.redeemed_at, {
              detail: { lat: v.lat ?? null, lng: v.lng ?? null },
            }),
          ],
        });
      }
    }

    // ── hop 1: me → events ────────────────────────────────────────────────────
    const myEvents = new Set<string>();
    for (const [kind, sql, table, tier] of [
      ["checkin", "SELECT event_id, at AS t, source FROM checkins WHERE user_id = ?", "checkins", "attested"],
      ["rsvp", "SELECT event_id, created_at AS t, status FROM rsvps WHERE user_id = ? AND status IN ('going','went','interested')", "rsvps", "stated"],
      ["hosted", "SELECT id AS event_id, start_utc AS t FROM events WHERE host_user_id = ? AND hidden = 0", "events", "attested"],
    ] as const) {
      if (!kinds.has(kind)) continue;
      const r = await this.db.prepare(sql).bind(me).all<Row>();
      for (const x of r.results ?? []) {
        myEvents.add(x.event_id);
        noteHop(nodeId("event", x.event_id), 1);
        raw.push({
          a: nodeId("user", me),
          b: nodeId("event", x.event_id),
          kind,
          directed: true,
          // An RSVP's strength depends on what it says: "went" is a claim of attendance,
          // "interested" barely a nod.
          strength: edgeStrength(rsvpStrength(kind, x.status), x.t, nowMs),
          evidence: [
            evidenceOf(tier, table, kind === "hosted" ? { id: x.event_id } : { user_id: me, event_id: x.event_id }, x.t, {
              detail: x.status ? { status: x.status } : x.source ? { source: x.source } : undefined,
            }),
          ],
        });
      }
    }

    // ── hop 2: who else was at those events ───────────────────────────────────
    // Anchors are capped: expanding 400 events would produce a hairball nobody can read and
    // a query count nobody can predict.
    const anchors = [...myEvents].slice(0, MAX_ANCHORS);
    const anchorsDropped = myEvents.size - anchors.length;
    let capped = anchorsDropped > 0;
    if (hops >= 2 && anchors.length) {
      for (const [kind, table, tier, sqlFor] of [
        [
          "checkin",
          "checkins",
          "attested",
          (n: number) =>
            `SELECT user_id, event_id, at AS t, source FROM checkins WHERE event_id IN (${ph(n)}) AND user_id <> ? ORDER BY at DESC LIMIT ${MAX_HOP2_ROWS}`,
        ],
        [
          "rsvp",
          "rsvps",
          "stated",
          (n: number) =>
            `SELECT user_id, event_id, created_at AS t, status FROM rsvps WHERE event_id IN (${ph(n)}) AND user_id <> ? AND status IN ('going','went','interested') ORDER BY created_at DESC LIMIT ${MAX_HOP2_ROWS}`,
        ],
      ] as const) {
        if (!kinds.has(kind)) continue;
        for (const c of chunks(anchors)) {
          const r = await this.db.prepare(sqlFor(c.length)).bind(...c, me).all<Row>();
          // A FULL page means the room was bigger than we fetched, so this graph is a sample.
          // Recorded distinctly from the truncation counts, because "trimmed for display" and
          // "we never had it all" are different claims.
          if ((r.results?.length ?? 0) >= MAX_HOP2_ROWS) capped = true;
          for (const x of r.results ?? []) {
            noteHop(nodeId("user", x.user_id), 2);
            raw.push({
              a: nodeId("user", x.user_id),
              b: nodeId("event", x.event_id),
              kind,
              directed: true,
              strength: edgeStrength(rsvpStrength(kind, x.status), x.t, nowMs),
              evidence: [
                evidenceOf(tier, table, { user_id: x.user_id, event_id: x.event_id }, x.t, {
                  detail: x.status ? { status: x.status } : x.source ? { source: x.source } : undefined,
                }),
              ],
            });
          }
        }
      }
    }

    // ── hydrate ───────────────────────────────────────────────────────────────
    const wantUsers = new Set<string>();
    const wantEvents = new Set<string>();
    for (const id of hop.keys()) {
      if (id.startsWith("user:")) wantUsers.add(id.slice(5));
      else if (id.startsWith("event:")) wantEvents.add(id.slice(6));
    }

    const userFacts = new Map<string, { facts: UserFacts; node: GraphNode }>();
    for (const c of chunks([...wantUsers])) {
      const r = await this.db
        .prepare(`SELECT id, display_name, handle, social_enabled, banned_at FROM users WHERE id IN (${ph(c.length)})`)
        .bind(...c)
        .all<Row>();
      for (const u of r.results ?? []) {
        userFacts.set(u.id, {
          facts: { id: u.id, socialEnabled: !!u.social_enabled, bannedAt: u.banned_at ?? null },
          node: { id: nodeId("user", u.id), type: "user", label: u.display_name, handle: u.handle, me: u.id === me },
        });
      }
    }

    const eventNodes = new Map<string, GraphNode>();
    for (const c of chunks([...wantEvents])) {
      const r = await this.db
        .prepare(`SELECT id, title, start_utc, latitude, longitude FROM events WHERE id IN (${ph(c.length)}) AND hidden = 0`)
        .bind(...c)
        .all<Row>();
      for (const e of r.results ?? []) {
        eventNodes.set(e.id, {
          id: nodeId("event", e.id),
          type: "event",
          label: e.title,
          at: e.start_utc,
          lat: e.latitude ?? null,
          lng: e.longitude ?? null,
        });
      }
    }

    // ── FILTER — the one place a node is allowed to disappear ─────────────────
    const visible = new Map<string, GraphNode>();
    let hiddenUsers = 0;
    for (const [uid, { facts, node }] of userFacts) {
      if (canSeeUser(viewer, facts, hop.get(nodeId("user", uid)) ?? 99)) visible.set(node.id, node);
      else hiddenUsers++;
    }
    for (const [, node] of eventNodes) visible.set(node.id, node);

    // An edge cannot outlive either of its endpoints. Doing this AFTER the node filter is
    // what makes "a hidden user leaves no trace" true rather than aspirational — otherwise
    // a dangling edge still reveals that somebody was there.
    let edges = mergeEdges(raw.filter((e) => visible.has(e.a) && visible.has(e.b)));

    if (opts.collapse) edges = collapseThroughEvents(edges, visible, nowMs);

    // ── rank, truncate, count what was dropped ────────────────────────────────
    const maxEdges = Math.min(opts.maxEdges ?? MAX_EDGES, MAX_EDGES);
    const maxNodes = Math.min(opts.maxNodes ?? MAX_NODES, MAX_NODES);
    const ranked = rankEdges(edges);
    const kept = ranked.slice(0, maxEdges);
    const edgesDropped = ranked.length - kept.length;

    // Keep only nodes an edge still touches, plus the viewer, so the picture has no orphans.
    const touched = new Set<string>([nodeId("user", me)]);
    for (const e of kept) {
      touched.add(e.a);
      touched.add(e.b);
    }
    const deg = degrees(kept);
    const allNodes = [...visible.values()].filter((n) => touched.has(n.id)).map((n) => ({ ...n, degree: deg.get(n.id) ?? 0 }));
    // Truncate by degree so the hubs survive — dropping the event everybody attended would
    // disconnect the graph it explains.
    allNodes.sort((x, y) => (y.me ? 1 : 0) - (x.me ? 1 : 0) || (y.degree ?? 0) - (x.degree ?? 0) || x.id.localeCompare(y.id));
    const nodes = allNodes.slice(0, maxNodes);
    const nodesDropped = allNodes.length - nodes.length;

    const nodeIds = new Set(nodes.map((n) => n.id));
    const finalEdges = kept.filter((e) => nodeIds.has(e.a) && nodeIds.has(e.b));

    return {
      nodes,
      edges: finalEdges,
      omitted: {
        nodes: nodesDropped + hiddenUsers,
        edges: edgesDropped + (kept.length - finalEdges.length) + anchorsDropped,
        noCoords: 0,
        outOfBay: 0,
        capped,
      },
    };
  }
}

/** An RSVP's weight depends on what it claims; every other kind uses its spec value. */
function rsvpStrength(kind: GraphEdgeKind, status?: string | null): number {
  if (kind !== "rsvp") return EDGE_SPEC[kind].strength;
  return status === "went" ? 0.6 : status === "going" ? 0.45 : 0.25;
}

/**
 * Collapse `user →event← user` into one `co_attended` edge, carrying the event as
 * `evidence.via`.
 *
 * Offered, never the default. The arithmetic is why: collapsing a 40-person event produces
 * 780 edges (k·(k−1)/2), and it is the EDGE count, not the node count, that kills both the
 * canvas renderer and the map's feature budget. Keeping the event as a visible node makes the
 * same information 40 edges — and the picture becomes legible precisely *because* the event
 * is the hub.
 *
 * Every synthesised edge must carry `via`. One without it has degenerated into the vague
 * similarity claim this whole feature exists to replace, and `tests/graph-projection.test.ts`
 * asserts it.
 */
export function collapseThroughEvents(edges: readonly GraphEdge[], nodes: Map<string, GraphNode>, nowMs: number): GraphEdge[] {
  const byEvent = new Map<string, GraphEdge[]>();
  const kept: GraphEdge[] = [];
  for (const e of edges) {
    if (e.b.startsWith("event:") && e.a.startsWith("user:")) {
      const g = byEvent.get(e.b);
      if (g) g.push(e);
      else byEvent.set(e.b, [e]);
    } else kept.push(e);
  }

  for (const [eventNodeId, all] of byEvent) {
    const via = nodes.get(eventNodeId);
    // O(k²), so `k` must be bounded here rather than by the edge cap downstream — that one is
    // applied after every pair has already been allocated. Strongest first, so the pairs kept
    // are the ones ranking would have chosen anyway.
    const group = all.length > MAX_COLLAPSE_GROUP ? [...all].sort((x, y) => y.strength - x.strength).slice(0, MAX_COLLAPSE_GROUP) : all;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = orderPair(group[i]!.a, group[j]!.a);
        const at = group[i]!.evidence[0]?.at ?? group[j]!.evidence[0]?.at ?? null;
        kept.push({
          a,
          b,
          kind: "co_attended",
          directed: false,
          strength: edgeStrength(EDGE_SPEC.co_attended.strength, at, nowMs),
          evidence: [
            evidenceOf("attested", "checkins", { event_id: eventNodeId.slice(6) }, at, {
              via: { id: eventNodeId, type: "event", label: via?.label ?? "an event" },
            }),
          ],
        });
      }
    }
  }
  return mergeEdges(kept);
}
