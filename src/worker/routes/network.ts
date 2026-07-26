import { Hono } from "hono";
import type { Env, Vars } from "../env";
import { requireAuth } from "../../auth/middleware";
import { requireWorker, egressOf, looksResidential, type NetVars } from "../middleware/worker-token";
import { checkRate, tooManyRequests } from "../middleware/ratelimit";
import { isRebuff } from "../net-tick";
import { NetworkRepo } from "../../storage/d1/network-repo";
import { ScrapeNetRepo } from "../../storage/d1/scrape-net-repo";
import { SocialRepo } from "../../storage/d1/social-repo";
import { PlatformRepo } from "../../storage/d1/platform-repo";
import { inBay } from "../../core/geo";
import { haversineKm } from "../../core/geofence";
import { mintSecret, hashSecret, checkRedeem, type RedeemCheck } from "../../core/net/invite";
import { nextTier } from "../../core/net/trust";
import {
  frameCodes,
  framePayload,
  verifyFrames,
  stepAt,
  stepStartMs,
  HANDSHAKE_STEP_MS,
  HANDSHAKE_SESSION_MS,
  HANDSHAKE_FRAMES_REQUIRED,
  type FrameVerdict,
} from "../../core/net/handshake";
import { ClientRegisterSchema, FixSchema, LeaseRequestSchema, NetJoinSchema, RecipeProposalSchema, SubmitSchema } from "../../../shared/schema";
import { D1Repo } from "../../storage/d1/d1-repo";
import { createNormalizer } from "../../core/normalize/normalize";
import { looksOutOfRegion } from "../../core/normalize/region";
import { UNKNOWN_CITY } from "../../core/models/source";
import { dedupeWithinRun } from "../../core/dedup";
import { RawEventSchema, type CanonicalEvent } from "../../core/models/event";
import { itemKey } from "../../core/scrape/itemkey";
import { recipeHost } from "../../core/scrape/host";
import { hasAdapter, getAdapter, listAdapterTypes } from "../../sources/registry";
import { observationDigest, resolve, type Verdict } from "../../core/scrape/consensus";
import citiesJson from "../../../config/cities.json";

/**
 * The scrape network's front door (migrations/0022).
 *
 * There is exactly one way into this network: meet a member, scan the code on their
 * phone while standing next to them. Not an email invite, not a referral link, not
 * an admin flipping a column. Everything downstream — consensus, reputation, the
 * right to publish to the public catalog — rests on accounts being expensive to
 * obtain, and a physical meeting with somebody who has standing to lose is the only
 * cost that doesn't scale for an attacker.
 *
 * Redemption creates a real `friendships` edge and pays both sides the existing
 * `connection` points, because that is what actually happened: two people met.
 *
 * Nothing here can reach an admin route. Worker tokens minted below are scoped to
 * /api/net/* — `INGEST_TOKEN`, which grants `renormalize`/`enrich`/`run-autopilot`
 * and would hand a volunteer the catalog, is never issued to anyone.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// Vars is the union of session-auth's `user` and worker-token's `client`/`member`:
// the two credential kinds never appear on the same route, but they share this router.
type App = Hono<{ Bindings: Env; Variables: Partial<NetVars> }>;
const repo = (c: { env: Env }) => new NetworkRepo(c.env.DB);

/** Metres between two fixes — the unit the proximity gate is written in. */
const distanceM = (aLat: number, aLng: number, bLat: number, bLng: number) => haversineKm(aLat, aLng, bLat, bLng) * 1000;

/** Where the QR should point. Falls back to the request's own origin in dev. */
const originOf = (c: any): string => c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin;

/** Only `trusted` and `core` may vouch. Probation is for doing work, not admitting people. */
const CAN_VOUCH = new Set(["trusted", "core"]);

/** Proposals a member may file per day. The audit queue is a shared resource: every
 *  candidate consumes shadow lease slots that would otherwise go to real coverage. */
const PROPOSALS_PER_DAY = 5;

/** Verdict counts for the submitting client, so it can show a human what happened. */
function tally(verdicts: Verdict[]): { confirmed: number; pending: number; contradicted: number } {
  const out = { confirmed: 0, pending: 0, contradicted: 0 };
  for (const v of verdicts) out[v.status]++;
  return out;
}

/** A human sentence per rejection — an honest user standing in the wrong place
 *  deserves to be told which thing was wrong, and the codes are not secret. */
const REDEEM_MESSAGE: Record<Exclude<RedeemCheck, "ok">, string> = {
  self: "you can't vouch for yourself",
  revoked: "that handshake has moved on — point your camera at their screen again",
  taken: "that handshake has already been used",
  expired: "that handshake has expired — ask them to start it again",
  out_of_region: "you have to be in the Bay to join the network",
  too_far: "stand next to each other and try again",
};

/** Why a capture didn't prove presence. `stale` is the one an honest user hits —
 *  they filmed it, then walked into a dead spot — so it says what to do about it. */
const FRAME_MESSAGE: Record<Exclude<FrameVerdict, "ok">, string> = {
  too_few: "hold the camera on their screen a moment longer",
  not_contiguous: "hold steady — some frames were missed",
  bad_code: "that handshake isn't valid",
  stale: "that took too long — point your camera at their screen again",
  future: "your clock is ahead — check your device's time",
  out_of_session: "that handshake has moved on — try again",
};

export function networkRoutes(): App {
  const app = new Hono<{ Bindings: Env; Variables: Partial<Vars> }>();

  // ── who am I in the network ─────────────────────────────────────────────────
  // 200 with `member: null` for a signed-in non-member rather than a 403: "you
  // aren't in the network" is the answer to the question, not a failure to answer.
  app.get("/api/net/me", requireAuth, async (c) => {
    const me = c.get("user")!.id;
    const r = repo(c);
    const member = await r.member(me);
    return c.json({
      member,
      canVouch: !!member && CAN_VOUCH.has(member.tier) && !member.quarantinedAt,
      // What it would take to level up, so the UI can say so instead of being mysterious
      // about why this person can't vouch yet.
      nextTier: member ? nextTier(member, Date.now()) : null,
      clients: member ? await r.listClients(me) : [],
    });
  });

  // ── play the film ───────────────────────────────────────────────────────────
  // Returns the whole ~30s frame list at once so the animation never stutters waiting
  // on the network, and opening a session revokes the one before it. The display calls
  // this again as the session runs out and rolls seamlessly into the next.
  app.post("/api/net/invite", requireAuth, async (c) => {
    const key = c.env.HANDSHAKE_KEY;
    // Fail closed. Joining is the one flow that must never quietly fall back to a
    // weaker check because a secret wasn't configured.
    if (!key) return c.json({ error: "the handshake isn't configured on this deployment" }, 503);

    const p = FixSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "a GPS fix is required to start a handshake" }, 400);

    const me = c.get("user")!;
    const member = await repo(c).member(me.id);
    if (!member || !CAN_VOUCH.has(member.tier)) return c.json({ error: "only trusted members can vouch for someone" }, 403);
    if (member.quarantinedAt) return c.json({ error: "your membership is under review" }, 403);
    if (!inBay(p.data.lat, p.data.lng)) return c.json({ error: "you have to be in the Bay to vouch for someone" }, 403);

    const rate = await checkRate(c.env, "net_invite", me.id);
    if (!rate.ok) return tooManyRequests(c, rate, "handshakes");

    const atMs = Date.now();
    const startStep = stepAt(atMs, HANDSHAKE_STEP_MS);
    const count = Math.ceil(HANDSHAKE_SESSION_MS / HANDSHAKE_STEP_MS);
    const endStep = startStep + count - 1;
    const expiresAt = new Date(stepStartMs(endStep + 1, HANDSHAKE_STEP_MS)).toISOString();

    const { sessionId } = await repo(c).openSession(
      me.id,
      p.data,
      { stepMs: HANDSHAKE_STEP_MS, framesRequired: HANDSHAKE_FRAMES_REQUIRED, startStep, endStep, expiresAt },
      atMs,
    );

    const frames = await frameCodes(key, sessionId, startStep, count);
    const origin = originOf(c);
    return c.json({
      ok: true,
      sessionId,
      expiresAt,
      stepMs: HANDSHAKE_STEP_MS,
      framesRequired: HANDSHAKE_FRAMES_REQUIRED,
      startStep,
      endStep,
      // Each frame's payload, pre-rendered: the display just walks the array in step
      // with the wall clock (stepStartMs), so two devices stay in phase with no
      // negotiation and no drift.
      frames: frames.map((f) => ({ ...f, at: stepStartMs(f.step, HANDSHAKE_STEP_MS), payload: framePayload({ origin, sessionId, ...f }) })),
    });
  });

  // ── watch the film ──────────────────────────────────────────────────────────
  app.post("/api/net/join", requireAuth, async (c) => {
    const key = c.env.HANDSHAKE_KEY;
    if (!key) return c.json({ error: "the handshake isn't configured on this deployment" }, 503);

    const p = NetJoinSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "invalid", reason: "invalid" }, 400);
    const me = c.get("user")!;
    const r = repo(c);

    if (await r.member(me.id)) return c.json({ error: "you're already in the network", reason: "already_member" }, 409);

    const rate = await checkRate(c.env, "net_join", me.id);
    if (!rate.ok) return tooManyRequests(c, rate, "attempts");

    const inv = await r.session(p.data.sessionId);
    // An unknown session and a bad capture are the same answer: probing session ids
    // teaches nothing, because the ids were never the secret — the frames are.
    if (!inv) return c.json({ error: "that handshake isn't valid", reason: "invalid" }, 403);

    const atMs = Date.now();
    const verdict = checkRedeem(
      { ambassadorId: inv.ambassador_id, lat: inv.lat, lng: inv.lng, expiresAt: inv.expires_at, revokedAt: inv.revoked_at, redeemedAt: inv.redeemed_at },
      { id: me.id, lat: p.data.lat, lng: p.data.lng },
      atMs,
      inBay,
      distanceM,
    );
    if (verdict !== "ok") return c.json({ error: REDEEM_MESSAGE[verdict], reason: verdict }, verdict === "taken" ? 409 : 403);

    // Did they actually watch it? Contiguous, recent, and correctly derived.
    const frames = await verifyFrames({
      key,
      sessionId: p.data.sessionId,
      frames: p.data.frames,
      startStep: inv.start_step,
      endStep: inv.end_step,
      nowMs: atMs,
      stepMs: inv.step_ms,
      framesRequired: inv.frames_required,
    });
    if (frames !== "ok") return c.json({ error: FRAME_MESSAGE[frames], reason: frames }, 403);

    // The race is settled here and nowhere else. Two phones filming the same screen
    // both reach this line; exactly one of them gets `true`.
    if (!(await r.claimInvite(p.data.sessionId, me.id))) return c.json({ error: "that handshake has already been used", reason: "taken" }, 409);

    const ambassadorId: string = inv.ambassador_id;
    await r.admit(me.id, ambassadorId, p.data.sessionId);

    // What actually happened: two people met. Record it as the connection it is —
    // accepted immediately (nobody accepts a handshake afterwards), and paid on both
    // sides through the existing idempotent ledger.
    const social = new SocialRepo(c.env.DB);
    await social.connectInPerson(me.id, ambassadorId);
    const plat = new PlatformRepo(c.env.DB);
    await plat.recordConnection(me.id, ambassadorId);
    await plat.recordConnection(ambassadorId, me.id);

    const vouchedBy = await social.getUserById(ambassadorId);
    return c.json({
      ok: true,
      tier: "probation",
      vouchedBy: vouchedBy ? { id: vouchedBy.id, handle: vouchedBy.handle, displayName: vouchedBy.displayName } : null,
    });
  });

  // ── clients (a machine or a browser, not a person) ──────────────────────────
  app.post("/api/net/clients", requireAuth, async (c) => {
    const p = ClientRegisterSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return c.json({ error: "invalid", issues: p.error.issues.slice(0, 5) }, 400);

    const me = c.get("user")!.id;
    const member = await repo(c).member(me);
    if (!member) return c.json({ error: "join the network before registering a client" }, 403);

    // Shown once, stored only as a hash. There is no endpoint that can re-reveal it.
    const token = mintSecret();
    const clientId = await repo(c).registerClient(me, p.data, await hashSecret(token));
    return c.json({ ok: true, clientId, token, note: "store this now — it is never shown again" });
  });

  app.delete("/api/net/clients/:id", requireAuth, async (c) => {
    const ok = await repo(c).revokeClient(c.get("user")!.id, c.req.param("id"));
    // Not-yours is indistinguishable from not-found: we don't confirm that an id
    // exists to someone with no business knowing it.
    return ok ? c.json({ ok: true }) : c.notFound();
  });

  // ── the work protocol (worker-token authed; see middleware/worker-token.ts) ──
  /**
   * Ask for work. The response is deliberately shaped as an answer either way: an empty
   * `leases` with a populated `skipped` tells an operator *why* the network was quiet,
   * which is the difference between "nothing to do" and "every host is blocked".
   */
  app.post("/api/net/lease", requireWorker, async (c) => {
    const body = LeaseRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid", issues: body.error.issues.slice(0, 5) }, 400);

    const client = c.get("client")!;
    const member = c.get("member")!;
    const net = new ScrapeNetRepo(c.env.DB);
    const egress = await egressOf(c);
    await repo(c).touchClient(client.id, egress);

    // `residential` is added here, never accepted from the client — it's a property of
    // where the request came from, which only we can see.
    const capabilities = [...new Set([...client.capabilities, ...(looksResidential(egress.asn) ? (["residential"] as const) : [])])];

    const { leases, skipped } = await net.lease({
      clientId: client.id,
      memberId: member.userId,
      capabilities: capabilities as any,
      egress,
      max: body.data.max,
      // Trust buys throughput: a core member is allowed to hold more of the queue at
      // once, which is a real perk that costs us nothing and cannot be faked.
      perWindowCap: member.tier === "core" ? 12 : member.tier === "trusted" ? 8 : 4,
    });

    return c.json({ ok: true, leases, skipped, tier: member.tier });
  });

  /**
   * Submit what you saw.
   *
   * The client sends `RawEvent[]` — adapter output, pre-normalisation — and the SERVER
   * derives everything that matters: timezone resolution, city, fingerprint, item key.
   * That is the single most important line in this file. `/api/admin/ingest` accepts a
   * client-computed fingerprint and uses it as the merge key, so a submitter there picks
   * which existing event their data lands on; moving the boundary back to RawEvent
   * deletes that whole attack class, and it means a worker cannot lie about a hash it
   * never computed. It's also *less* client code, not more.
   *
   * Nothing here writes to `events` unless consensus says so.
   */
  app.post("/api/net/submit", requireWorker, async (c) => {
    const p = SubmitSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "invalid", issues: p.error.issues.slice(0, 5) }, 400);

    const client = c.get("client")!;
    const member = c.get("member")!;
    const net = new ScrapeNetRepo(c.env.DB);
    const atMs = Date.now();

    const lease = await net.leaseById(p.data.leaseId);
    if (!lease || lease.client_id !== client.id) return c.notFound();
    if (lease.submitted_at || lease.released_at) return c.json({ error: "that lease is already settled", reason: "settled" }, 409);
    if (Date.parse(lease.expires_at) <= atMs) return c.json({ error: "that lease expired", reason: "expired" }, 409);

    // ── derive canon, with the same pure code the local pipeline uses ──────────
    const normalize = createNormalizer(citiesJson as any);
    const canon: CanonicalEvent[] = [];
    let rejected = 0;
    for (const raw of p.data.items) {
      const parsed = RawEventSchema.safeParse(raw);
      if (!parsed.success) {
        rejected++;
        continue;
      }
      const e = normalize(parsed.data, new Date(atMs));
      if (!e) {
        rejected++; // unparseable dates, empty title/url — skipped, never fatal
        continue;
      }
      // Same precision-first filter the local pipeline applies: only drop what we can
      // confidently place outside the region.
      if (e.city === UNKNOWN_CITY && looksOutOfRegion(e.address)) {
        rejected++;
        continue;
      }
      canon.push(e);
    }
    const deduped = dedupeWithinRun(canon);

    const observed = deduped.map((e) => {
      const ref = e.sources[0] ?? { sourceId: lease.source_id, url: e.url };
      return {
        itemKey: itemKey({ sourceId: lease.source_id, externalId: (ref as any).externalId, url: ref.url ?? e.url }, e.fingerprint),
        fingerprint: e.fingerprint,
        payload: e,
      };
    });

    await net.recordObservations({ leaseId: lease.id, jobId: lease.job_id, memberId: member.userId }, observed, atMs);
    if (p.data.receipts?.length) await net.saveReceipts(lease.id, p.data.receipts);
    await net.markSubmitted(lease.id, atMs);

    // The host's own words, relayed. A client cannot be trusted to slow itself down, but it can
    // tell us what it was told — and a 429 or a 403 is the one signal we never argue with. A 5xx
    // is deliberately NOT a refusal: blocking on it would take us off a source for an hour every
    // time somebody deployed.
    const refused = (p.data.receipts ?? []).some((r) => isRebuff(r.status));
    if (refused) await net.noteRebuff(lease.host, null, atMs);
    else await net.clearRebuffs(lease.host);

    // A client may send its own digest. We recompute ours and only ever compare them to
    // spot a CLIENT BUG — a mismatch is never scored as dishonesty, because the client's
    // digest has no authority over anything.
    const serverDigest = observationDigest(observed.map((o) => o.itemKey));
    const digestMatches = p.data.digest ? p.data.digest === serverDigest : null;

    // ── consensus, then promotion ─────────────────────────────────────────────
    const evidence = await net.jobEvidence(lease.job_id);
    const verdicts = resolve(evidence);
    const { retracted } = await net.applyVerdicts(verdicts, atMs);
    // Evidence arrived against something already public. Hide it — reversibly, and
    // without deleting the sighting that produced it.
    if (retracted.length) await net.retractEvents(retracted.map((r) => r.eventId), atMs);

    const promotable = await net.pendingPromotions(lease.job_id);
    let published = 0;
    if (promotable.length) {
      // The existing merge does the hard part: two observers of one item share a
      // fingerprint, so `upsertEvents` collapses them with the same richer-wins /
      // union-categories semantics the local pipeline has always used. Consensus decides
      // WHETHER to publish; it does not reimplement HOW to merge.
      await new D1Repo(c.env.DB).upsertEvents(promotable.map((o) => o.payload as CanonicalEvent));
      const ids = await net.eventIdsByFingerprint(promotable.map((o) => o.fingerprint));
      const pairs = promotable.flatMap((o) => {
        const eventId = ids.get(o.fingerprint);
        return eventId ? [{ id: o.id, eventId }] : [];
      });
      await net.markPublished(pairs, atMs);
      // Distinct EVENTS, not observation rows: two workers corroborating one event is
      // one thing reaching the catalog, and reporting "2" there would make every
      // confirmation look like a duplicate.
      published = new Set(pairs.map((p) => p.eventId)).size;
    }

    // ── settle: pay for the work, then rescore everyone it touched ────────────
    // Order matters. Points are awarded from the observation statuses consensus just
    // wrote, and rescoring reads those same statuses — so paying first and scoring second
    // means a member's standing and their ledger can never disagree about the same job.
    await net.awardLeaseCompletion(member.userId, lease.id, atMs);
    await net.awardJobPoints(lease.job_id, atMs);
    const touched = await net.jobMembers(lease.job_id);
    for (const id of touched) await net.rescoreMember(id, atMs);
    // Vouchers second, and only after their invitees' tiers have settled: the vouch debit
    // only counts an invitee who is STILL on probation, so scoring a voucher before their
    // invitee's promotion lands would charge them for someone who has since earned their
    // own standing.
    for (const id of await net.vouchersOf(touched)) if (!touched.includes(id)) await net.rescoreMember(id, atMs);

    const counts = tally(verdicts);
    const mine = await repo(c).member(member.userId);
    return c.json({
      ok: true,
      accepted: observed.length,
      rejected,
      digest: serverDigest,
      digestMatches,
      consensus: counts,
      published,
      backedOff: refused,
      // Echo their standing back, so a CLI can print "3 finds, trust 21.4 → trusted"
      // without a second round trip.
      standing: mine && { tier: mine.tier, trust: mine.trust, confirms: mine.confirms, contradictions: mine.contradictions },
    });
  });

  // ── recipes: improving the scrapers without a deploy ────────────────────────
  /**
   * Propose a better (or new) recipe.
   *
   * Three validations, and the shape of them is the whole safety argument:
   *
   *   1. `hasAdapter(type)` — a recipe may only configure an adapter that ALREADY EXISTS in
   *      src/sources/registry.ts. It cannot introduce code, so the worst a hostile proposal
   *      can do is produce bad data, which consensus already catches.
   *   2. the adapter's OWN `parseParams` — validation by the code that will actually consume
   *      the params, so there is no second schema to drift out of sync.
   *   3. `recipeHost` — we refuse to schedule what we cannot rate-limit.
   *
   * Accepted proposals land as `proposed`, not live. Promotion is earned in shadow mode
   * against the incumbent (see ScrapeNetRepo.auditShadows).
   */
  app.post("/api/net/recipes", requireAuth, async (c) => {
    const p = RecipeProposalSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "invalid", issues: p.error.issues.slice(0, 5) }, 400);

    const me = c.get("user")!.id;
    const member = await repo(c).member(me);
    if (!member || !CAN_VOUCH.has(member.tier)) return c.json({ error: "only trusted members can propose recipes" }, 403);
    if (member.quarantinedAt) return c.json({ error: "your membership is under review" }, 403);

    const net = new ScrapeNetRepo(c.env.DB);
    // Bounded so nobody can bury the audit queue: every proposal consumes shadow lease
    // slots that would otherwise go to real coverage.
    if ((await net.recentProposalCount(me, Date.now() - 24 * 3600_000)) >= PROPOSALS_PER_DAY) {
      return c.json({ error: `at most ${PROPOSALS_PER_DAY} proposals a day — the audit queue is a shared resource`, reason: "rate_limited" }, 429);
    }

    if (!hasAdapter(p.data.type)) {
      return c.json({ error: `no adapter of type '${p.data.type}' — a recipe configures existing code, it cannot add any`, known: listAdapterTypes() }, 400);
    }
    // The adapter validates its own params. A throw here is a malformed recipe, not a bug.
    try {
      getAdapter(p.data.type).parseParams(p.data.params);
    } catch (err) {
      return c.json({ error: `those params aren't valid for a '${p.data.type}' recipe: ${(err as Error).message}`.slice(0, 300) }, 400);
    }
    const host = recipeHost(p.data.type, p.data.params);
    if (!host) return c.json({ error: "could not determine which host this recipe crawls, so it cannot be rate-limited" }, 400);

    const { recipeId, version } = await net.proposeRecipe({
      sourceId: p.data.sourceId,
      type: p.data.type,
      params: p.data.params,
      host,
      windowMs: p.data.windowMs,
      notes: p.data.notes ?? null,
      authorId: me,
    });
    return c.json({ ok: true, recipeId, version, status: "proposed", host });
  });

  /**
   * "Is the network working?" — the question an operator has on a fresh deploy, answerable
   * without opening the database. Public, because none of it is sensitive and all of it is the
   * kind of thing a contributor deciding whether to bother should be able to see.
   *
   * `handshakeConfigured` is first among equals: a missing `HANDSHAKE_KEY` makes joining 503 and
   * is otherwise completely silent.
   */
  app.get("/api/net/status", async (c) => {
    const status = await new ScrapeNetRepo(c.env.DB).status();
    return c.json({ ...status, handshakeConfigured: !!c.env.HANDSHAKE_KEY });
  });

  /** What's live and what's being trialled. Public — the crowd should be able to see what
   *  is about to change about how its catalog gets built. */
  app.get("/api/net/recipes", async (c) => {
    return c.json({ recipes: await new ScrapeNetRepo(c.env.DB).listRecipes(Math.trunc(Number(c.req.query("limit")) || 100)) });
  });

  /**
   * The contributor board. Public: the work is public, the catalog it fills is public, and
   * credit for filling it should be too — minus anyone who asked not to be credited.
   */
  app.get("/api/net/leaderboard", async (c) => {
    const limit = Math.trunc(Number(c.req.query("limit")) || 50);
    return c.json({ board: await new ScrapeNetRepo(c.env.DB).leaderboard(limit) });
  });

  /** Give work back honestly — it failed, or the client is shutting down. Handing a job
   *  back is a good citizen's move, so it is never penalised. */
  app.post("/api/net/lease/:id/release", requireWorker, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { error?: string };
    const net = new ScrapeNetRepo(c.env.DB);
    const ok = await net.release(c.req.param("id"), c.get("client")!.id, body.error ? "failed" : "released", body.error);
    if (!ok) return c.notFound();

    // A client that hands work back saying the host refused it is doing us a favour — act on it
    // rather than waiting for the same refusal from the next four workers.
    if (body.error && /\b(429|403)\b|too many requests|forbidden/i.test(body.error)) {
      const lease = await net.leaseById(c.req.param("id"));
      if (lease?.host) await net.noteRebuff(lease.host);
    }
    return c.json({ ok: true });
  });

  return app;
}
