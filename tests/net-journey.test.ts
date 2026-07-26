/**
 * The whole thing, once, through the real Worker.
 *
 * Every other file in this set tests one mechanism in isolation, which is how you find out that
 * each part is right and learn nothing about whether they compose. This one walks the actual
 * journey a real deployment goes through, in order, with no shortcuts:
 *
 *   an empty database
 *     → the cron founds the network from config
 *     → the founder's phone plays a handshake
 *     → a stranger's camera watches it and they're in
 *     → they register a machine
 *     → the coordinator hands it work
 *     → it submits raw observations
 *     → a second, independent worker corroborates them
 *     → events appear in the public catalog
 *     → both workers are paid and scored
 *     → somebody proposes a better scraper and it gets trialled
 *
 * If this passes, the network works end to end. If a refactor breaks the seam between two
 * phases, this is what notices.
 */
import { describe, it, expect } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { ScrapeNetRepo } from "../src/storage/d1/scrape-net-repo";
import { NetworkRepo } from "../src/storage/d1/network-repo";
import { HANDSHAKE_STEP_MS } from "../src/core/net/handshake";
import citiesJson from "../config/cities.json";

const SF = { lat: 37.7879, lng: -122.4075 };
const NEAR = { lat: SF.lat + 0.0002, lng: SF.lng }; // ~22m away: standing together

/**
 * The catalog as a reader sees it — through the REAL Worker, not the route harness.
 *
 * `/api/events` is mounted on the Worker's own app rather than in `routeFactories`, so this has
 * to go through `worker.fetch`. That is the better check regardless: what matters is what a
 * stranger hitting the public API gets back.
 */
async function visibleCatalog(t: TestApp): Promise<string[]> {
  const worker = (await import("../src/worker/index")).default;
  const res = await worker.fetch(new Request("https://thebay.events/api/events?limit=100"), t.env as any, {} as any);
  const body: any = await res.json();
  return (body.events as any[]).map((e) => e.title).sort();
}

/** One event straight off the public API, for asserting on what the server derived. */
async function firstPublicEvent(t: TestApp): Promise<any> {
  const worker = (await import("../src/worker/index")).default;
  const res = await worker.fetch(new Request("https://thebay.events/api/events?limit=1"), t.env as any, {} as any);
  return ((await res.json()) as any).events[0];
}

/** One raw event, exactly as the `generic-json` adapter emits them. */
const TITLES = ["AI Infra Night", "Hardware Happy Hour", "Robotics Demo Day", "Photonics Meetup", "Rust Systems Salon"];
const raw = (n: number, over: Record<string, unknown> = {}) => ({
  sourceId: "cv",
  sourceType: "generic-json",
  externalId: `evt-${n}`,
  title: TITLES[n % TITLES.length]!,
  startRaw: `2026-08-0${(n % 8) + 1}T18:00:00-07:00`,
  url: `https://cerebralvalley.ai/e/${n}`,
  city: "San Francisco",
  venueName: `Venue ${n}`,
  description: "A room full of people who build things.",
  organizer: "Cerebral Valley",
  ...over,
});

describe("the whole journey", () => {
  it("goes from an empty database to a published catalog, scored contributors and a trialled scraper", async () => {
    // ── 0. a fresh deployment ──────────────────────────────────────────────────
    const t = makeTestApp({ HANDSHAKE_KEY: "deployment-key", ADMIN_HANDLES: "founder" });
    const members = new NetworkRepo(t.env.DB);
    const net = new ScrapeNetRepo(t.env.DB);
    const worker = (await import("../src/worker/index")).default;

    const cron = async () => {
      const pending: Promise<unknown>[] = [];
      await worker.scheduled({} as any, t.env as any, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as any);
      await Promise.allSettled(pending);
    };

    expect(await visibleCatalog(t)).toEqual([]);
    expect((await call(t, "/api/net/status")).json.members).toBe(0);

    // ── 1. the operator signs in, and the cron founds the network ──────────────
    const founder = await login(t, "founder@x.com", "Founder");
    await t.env.DB.prepare("UPDATE users SET handle = 'founder' WHERE id = ?").bind(founder.user.id).run();
    await cron();

    expect((await members.member(founder.user.id))!.tier).toBe("core");
    const status1 = (await call(t, "/api/net/status")).json;
    expect(status1.handshakeConfigured).toBe(true);
    expect(status1.recipes.active).toBeGreaterThan(0); // seeded from config/sources.json
    expect(status1.jobs.open).toBeGreaterThan(0); // and planned for this window

    // ── 2. the handshake: the founder shows, a stranger watches ────────────────
    const session = (await call(t, "/api/net/invite", { method: "POST", cookie: founder.cookie, body: SF })).json;
    const capture = (n = 4) => {
      const now = Math.floor(Date.now() / HANDSHAKE_STEP_MS);
      const i = Math.max(0, (session.frames as any[]).findIndex((f) => f.step === now));
      return (session.frames as any[]).slice(i, i + n).map((f) => ({ step: f.step, code: f.code }));
    };

    const ann = await login(t, "ann@x.com", "Ann");
    // One frame is not enough, however valid it is — that is the whole point of the film.
    const oneFrame = await call(t, "/api/net/join", {
      method: "POST",
      cookie: ann.cookie,
      body: { sessionId: session.sessionId, frames: capture(2), ...NEAR },
    });
    expect(oneFrame.status).toBe(403);
    expect(oneFrame.json.reason).toBe("too_few");

    const joined = await call(t, "/api/net/join", {
      method: "POST",
      cookie: ann.cookie,
      body: { sessionId: session.sessionId, frames: capture(), ...NEAR },
    });
    expect(joined.status).toBe(200);
    expect(joined.json.tier).toBe("probation");
    expect(joined.json.vouchedBy.handle).toBe("founder");

    // What actually happened is recorded as what it was: two people met.
    const [low, high] = [ann.user.id, founder.user.id].sort();
    const edge = await t.env.DB.prepare("SELECT status FROM friendships WHERE user_low=? AND user_high=?").bind(low, high).first();
    expect(edge.status).toBe("accepted");

    // ── 3. she registers a machine ─────────────────────────────────────────────
    const reg = await call(t, "/api/net/clients", {
      method: "POST",
      cookie: ann.cookie,
      body: { kind: "cli", label: "ann's laptop", capabilities: ["fetch", "browser"] },
    });
    expect(reg.status).toBe(200);
    const annToken = reg.json.token;
    // Shown once. Nothing can ever re-reveal it.
    expect(JSON.stringify((await call(t, "/api/net/me", { cookie: ann.cookie })).json)).not.toContain(annToken);

    // Politeness is real, and it would otherwise dominate a test that leases repeatedly in one
    // millisecond. Proven properly in tests/net-politeness.test.ts.
    await t.env.DB.prepare("UPDATE scrape_hosts SET min_gap_ms = 0, max_concurrent = 50").run();

    // ── 4. the coordinator hands out work, and she does it ─────────────────────
    const lease = async (token: string, ip: string) =>
      await call(t, "/api/net/lease", { method: "POST", body: { max: 1 }, headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": ip } });

    // Point her at one known source so the journey's assertions are about the network rather
    // than about which of 22 sources she happened to be given.
    await t.env.DB.prepare("UPDATE scrape_jobs SET status = 'done'").run();
    await net.seedRecipes([{ id: "cv", type: "generic-json", params: { url: "https://api.cerebralvalley.ai/v1/events" } }], (await import("../src/core/scrape/host")).recipeHost);
    await net.plan();
    await t.env.DB.prepare("UPDATE scrape_hosts SET min_gap_ms = 0, max_concurrent = 50, last_granted_at = NULL").run();

    const annWork = await lease(annToken, "203.0.113.10");
    expect(annWork.json.leases).toHaveLength(1);
    expect(annWork.json.tier).toBe("probation");
    const found = [raw(1), raw(2), raw(3)];

    const annSubmit = await call(t, "/api/net/submit", {
      method: "POST",
      body: {
        leaseId: annWork.json.leases[0].leaseId,
        items: found,
        receipts: [{ url: "https://api.cerebralvalley.ai/v1/events", status: 200, bytes: 9001, elapsedMs: 210 }],
      },
      headers: { authorization: `Bearer ${annToken}`, "cf-connecting-ip": "203.0.113.10" },
    });
    expect(annSubmit.status).toBe(200);
    expect(annSubmit.json.accepted).toBe(3);
    // Alone so far — so nothing is published, and nothing is held against her.
    expect(annSubmit.json.consensus).toEqual({ confirmed: 0, pending: 3, contradicted: 0 });
    expect(annSubmit.json.published).toBe(0);
    expect(await visibleCatalog(t)).toEqual([]);
    expect(annSubmit.json.backedOff).toBe(false);

    // ── 5. a second, independent worker corroborates her ──────────────────────
    // Bea joins the same way — the chain is human all the way down.
    // The founder must STILL be able to vouch after their first invitee did work. This caught a
    // real bug: rescoring recomputed the founder's tier from their own (nonexistent) observations
    // and demoted them to probation, so a network could admit exactly two people and then stop.
    const againRes = await call(t, "/api/net/invite", { method: "POST", cookie: founder.cookie, body: SF });
    expect(againRes.status, JSON.stringify(againRes.json)).toBe(200);
    expect((await members.member(founder.user.id))!.tier).toBe("core");
    const founderAgain = againRes.json;
    const bea = await login(t, "bea@x.com", "Bea");
    const beaJoin = await call(t, "/api/net/join", {
      method: "POST",
      cookie: bea.cookie,
      body: {
        sessionId: founderAgain.sessionId,
        frames: (() => {
          const now = Math.floor(Date.now() / HANDSHAKE_STEP_MS);
          const i = Math.max(0, (founderAgain.frames as any[]).findIndex((f) => f.step === now));
          return (founderAgain.frames as any[]).slice(i, i + 4).map((f) => ({ step: f.step, code: f.code }));
        })(),
        ...NEAR,
      },
    });
    expect(beaJoin.status).toBe(200);
    const beaToken = (await call(t, "/api/net/clients", { method: "POST", cookie: bea.cookie, body: { kind: "extension", capabilities: ["fetch", "dom"] } })).json.token;

    // A different household, so she is genuinely a second observer.
    const beaWork = await lease(beaToken, "198.51.100.20");
    expect(beaWork.json.leases).toHaveLength(1);
    const beaSubmit = await call(t, "/api/net/submit", {
      method: "POST",
      body: { leaseId: beaWork.json.leases[0].leaseId, items: found },
      headers: { authorization: `Bearer ${beaToken}`, "cf-connecting-ip": "198.51.100.20" },
    });
    expect(beaSubmit.json.consensus.confirmed).toBe(3);
    expect(beaSubmit.json.published).toBe(3);

    // ── 6. the catalog is real, and readable by anyone ─────────────────────────
    expect(await visibleCatalog(t)).toEqual([raw(1).title, raw(2).title, raw(3).title].sort());
    const event = await firstPublicEvent(t);
    // Server-derived, not client-supplied: she never computed any of this.
    expect(event.fingerprint).toMatch(/^[0-9a-f]+$/);
    expect(event.timezone).toBe("America/Los_Angeles");
    // Resolved against the real config/cities.json — the point is that the SERVER resolved it,
    // not which slug that file happens to use.
    expect(event.city).not.toBe("unknown");
    expect((citiesJson as any[]).map((c) => c.id)).toContain(event.city);
    expect(event.starred).toBe(false);

    // ── 7. both are paid, and both are scored ─────────────────────────────────
    const points = async (userId: string, kind: string) =>
      ((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = ? AND kind = ?").bind(userId, kind).first()) as any).n;

    expect(await points(ann.user.id, "scrape_find")).toBe(3); // she got there first
    expect(await points(bea.user.id, "scrape_confirm")).toBe(3); // she made it true
    expect(await points(ann.user.id, "scrape_job")).toBe(1);
    expect(await points(ann.user.id, "connection")).toBe(1); // and meeting the founder counted

    const annM = (await members.member(ann.user.id))!;
    expect(annM.confirms).toBe(3);
    expect(annM.contradictions).toBe(0);
    expect(annM.trust).toBeGreaterThan(0);
    expect(annM.tier).toBe("probation"); // three finds is not a career

    const board = (await call(t, "/api/net/leaderboard")).json.board;
    expect(board[0].handle).toBe("ann");
    expect(board[0].finds).toBe(3);
    expect(JSON.stringify(board)).not.toContain("@x.com"); // never leak an email

    // ── 8. somebody proposes a better scraper ─────────────────────────────────
    // Only trusted+ may propose, so this is the founder's to do.
    const proposal = await call(t, "/api/net/recipes", {
      method: "POST",
      cookie: founder.cookie,
      body: {
        sourceId: "cv",
        type: "generic-json",
        params: { url: "https://api.cerebralvalley.ai/v1/events?limit=200", itemsPath: "events", fieldMap: { title: "name", startRaw: "startDateTime", url: "url" } },
        notes: "the API accepts limit=200; we were leaving events on the table",
      },
    });
    expect(proposal.status).toBe(200);
    expect(proposal.json.version).toBe(2);
    expect(proposal.json.status).toBe("proposed"); // proposing is not shipping

    // A recipe cannot introduce code, however it is phrased.
    const hostile = await call(t, "/api/net/recipes", {
      method: "POST",
      cookie: founder.cookie,
      body: { sourceId: "cv", type: "eval", params: { url: "https://evil.example/x" } },
    });
    expect(hostile.status).toBe(400);

    // The next tick trials it beside the incumbent and judges it — `keep`, because one window
    // of evidence proves nothing. That non-answer is the correct one.
    await cron();
    const trialled = await t.env.DB.prepare("SELECT status FROM scrape_recipes WHERE id = ?").bind(proposal.json.recipeId).first();
    expect(trialled.status).toBe("shadow");
    const audit = await t.env.DB.prepare("SELECT verdict, reason FROM recipe_audits WHERE recipe_id = ?").bind(proposal.json.recipeId).first();
    expect(audit.verdict).toBe("keep");
    expect(audit.reason).toBeTruthy(); // and it says why, for anyone who asks later

    // The live recipe is untouched throughout.
    const live = await t.env.DB.prepare("SELECT COUNT(*) AS n FROM scrape_recipes WHERE source_id = 'cv' AND status = 'active'").first();
    expect(live.n).toBe(1);

    // ── 9. and the whole thing is visible to an operator ──────────────────────
    const final = (await call(t, "/api/net/status")).json;
    expect(final.members).toBe(3); // founder + ann + bea
    expect(final.workers).toBe(2);
    expect(final.observations.published).toBe(6); // three events, two observers each
    expect(final.recipes.shadow).toBe(1);
    expect(final.quarantined).toBe(0);
  });
});
