import { describe, it, expect } from "vitest";
import app from "../src/worker/index";
import { makeTestEnv } from "./helpers/app";

/** Drive the REAL Worker app (not just the route factories) so the global
 *  middleware — security headers, HTTPS redirect, onError — is covered. */
async function hit(path: string, init: RequestInit = {}, envOverrides: Record<string, any> = {}) {
  const { env } = makeTestEnv(envOverrides);
  const res = await app.fetch(new Request("https://thebay.events" + path, init), env as any);
  return { res, env };
}

describe("security hardening middleware", () => {
  it("stamps HSTS + hardening headers on API responses", async () => {
    const { res } = await hit("/api/me");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("301-redirects plain http to https (via cf-visitor) and hardens the redirect too", async () => {
    const { res } = await hit("/api/me", { headers: { "cf-visitor": '{"scheme":"http"}' } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://thebay.events/api/me");
    expect(res.headers.get("strict-transport-security")).toBeTruthy(); // hardened, not skipped
  });

  it("does NOT redirect when the client is already on https (no loop)", async () => {
    const { res } = await hit("/api/me", { headers: { "cf-visitor": '{"scheme":"https"}' } });
    expect(res.status).toBe(200);
  });
});

describe("onError maps DB constraint violations to a clean 409", () => {
  it("a foreign-key violation returns 409, not a raw 500", async () => {
    const { env } = makeTestEnv();
    // sign in, then befriend a user id that doesn't exist → FK violation inside the handler
    const reg = await app.fetch(
      new Request("https://thebay.events/auth/dev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@x.com", name: "Ann" }) }),
      env as any,
    );
    const cookie = (reg.headers.get("set-cookie") || "").split(";")[0]!;
    const res = await app.fetch(
      new Request("https://thebay.events/api/friends/does-not-exist/request", { method: "POST", headers: { cookie } }),
      env as any,
    );
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe("conflict");
    expect(res.headers.get("strict-transport-security")).toBeTruthy(); // error path is hardened
  });
});

describe("admin ingest bearer gate", () => {
  const ev = {
    id: "ing-1", fingerprint: "fp-ing-1", title: "Ingested Event", description: null,
    startUtc: "2026-09-01T18:00:00Z", endUtc: null, timezone: "America/Los_Angeles",
    venueName: null, address: null, city: "sf-bay", url: "https://x.test/e", organizer: null,
    isFree: null, priceText: null, imageUrl: null, categories: [], interestScore: null,
    interestReason: null, tagSource: null, contentHash: "ch-ing-1", taggedHash: null,
    sources: [], firstSeenAt: "2026-01-01", lastSeenAt: "2026-01-01", starred: false, hidden: false,
  };
  const payload = { events: [ev] };
  const json = { "content-type": "application/json" };

  it("rejects a missing or wrong bearer token", async () => {
    expect((await hit("/api/admin/ingest", { method: "POST", headers: json, body: JSON.stringify(payload) }, { INGEST_TOKEN: "secret" })).res.status).toBe(401);
    expect((await hit("/api/admin/ingest", { method: "POST", headers: { ...json, authorization: "Bearer wrong" }, body: JSON.stringify(payload) }, { INGEST_TOKEN: "secret" })).res.status).toBe(401);
  });

  it("accepts the correct bearer token and actually ingests the event", async () => {
    const { res } = await hit(
      "/api/admin/ingest",
      { method: "POST", headers: { ...json, authorization: "Bearer secret" }, body: JSON.stringify(payload) },
      { INGEST_TOKEN: "secret" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("rejects a malformed payload even with a valid token", async () => {
    const { res } = await hit("/api/admin/ingest", { method: "POST", headers: { ...json, authorization: "Bearer secret" }, body: JSON.stringify({ events: [] }) }, { INGEST_TOKEN: "secret" });
    expect(res.status).toBe(400);
  });
});

describe("intros autopilot admin trigger (/api/admin/run-autopilot)", () => {
  it("is bearer-gated and auto-forwards eligible requests for auto-mode connectors", async () => {
    const { env, d1, raw } = makeTestEnv({ INGEST_TOKEN: "secret" });
    const { SocialRepo } = await import("../src/storage/d1/social-repo");
    const { GraphRepo } = await import("../src/storage/d1/graph-repo");
    const social = new SocialRepo(d1 as any);
    const graph = new GraphRepo(d1 as any);
    const mk = async (email: string, name: string) => {
      const u = await social.upsertByIdentity({ provider: "dev", providerUid: email, email, displayName: name });
      await social.updateProfile(u.id, { socialEnabled: true });
      return u;
    };
    const bf = async (a: string, b: string) => { await social.requestFriend(a, b); await social.respondFriend(b, a, true); };
    const ann = await mk("ann@x.com", "Ann"), cid = await mk("cid@x.com", "Cid"), viv = await mk("viv@x.com", "Viv");
    await bf(ann.id, cid.id); await bf(cid.id, viv.id);
    await graph.createIntroRequest(ann.id, { targetDesc: "Viv", targetUserId: viv.id });
    raw.prepare(`INSERT INTO agent_settings (user_id, networking_enabled, guardrails_json, updated_at) VALUES (?,1,'{"mode":"auto"}','2026-01-01')`).run(cid.id);

    const url = "https://thebay.events/api/admin/run-autopilot";
    expect((await app.fetch(new Request(url, { method: "POST" }), env as any)).status).toBe(401);
    expect((await app.fetch(new Request(url, { method: "POST", headers: { authorization: "Bearer wrong" } }), env as any)).status).toBe(401);

    const ok = await app.fetch(new Request(url, { method: "POST", headers: { authorization: "Bearer secret" } }), env as any);
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).forwarded).toBe(1);
    // the warm intro is now pending for the target to accept
    expect((await graph.incomingForwards(viv.id)).length).toBe(1);
  });
});

describe("scrape observability endpoints", () => {
  it("scrape-report is bearer-gated; scrape-status then shows the run + freshness", async () => {
    const { env, raw } = makeTestEnv({ INGEST_TOKEN: "secret" });
    // seed one upcoming event so totals are meaningful
    raw.prepare(`INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at)
                 VALUES ('e1','fp1','A','2099-01-01T00:00:00Z','America/Los_Angeles','sf-bay','https://x','h1','2026-01-01','2026-01-01')`).run();

    const url = "https://thebay.events/api/admin/scrape-report";
    const report = JSON.stringify({ trigger: "scrape+push", eventsNew: 9, eventsUpdated: 2, sources: [{ sourceId: "luma", status: "ok", rawCount: 30 }] });

    // gate: no/incorrect bearer → 401
    expect((await app.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: report }), env as any)).status).toBe(401);
    // correct bearer → records the run
    const ok = await app.fetch(new Request(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret" }, body: report }), env as any);
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).runId).toBeTruthy();

    // public status now reflects it — no longer blind
    const status = await app.fetch(new Request("https://thebay.events/api/scrape-status"), env as any);
    expect(status.status).toBe(200);
    const s = await status.json() as any;
    expect(s.lastRunAt).toBeTruthy();
    expect(s.stale).toBe(false);          // just reported → fresh
    expect(s.lastRun.eventsNew).toBe(9);
    expect(s.totalEvents).toBe(1);
    expect(s.upcomingEvents).toBe(1);
    expect(s.lastRun.sources[0].sourceId).toBe("luma");
  });
});

describe("scrape renormalize admin trigger (/api/admin/renormalize)", () => {
  it("is bearer-gated and re-resolves stored events' city against cities.json", async () => {
    const { env, raw } = makeTestEnv({ INGEST_TOKEN: "secret" });
    // an "unknown" Santa Cruz event, as it would have been stored before the aliases
    raw.prepare(`INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, address, url, content_hash, first_seen_at, last_seen_at)
                 VALUES ('e1','oldfp','AI Meetup','2026-08-01T18:00:00Z','America/Los_Angeles','unknown','1415 Pacific Ave, Santa Cruz, CA 95060','https://x','ch1','2026-07-01','2026-07-01')`).run();

    const url = "https://thebay.events/api/admin/renormalize";
    expect((await app.fetch(new Request(url, { method: "POST" }), env as any)).status).toBe(401);

    const ok = await app.fetch(new Request(url, { method: "POST", headers: { authorization: "Bearer secret" } }), env as any);
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).updated).toBe(1);
    expect((raw.prepare("SELECT city FROM events WHERE id='e1'").get() as any).city).toBe("sf-bay");
  });
});

describe("prune out-of-region admin trigger (/api/admin/prune-out-of-region)", () => {
  it("is bearer-gated and removes only confidently non-Bay events", async () => {
    const { env, raw } = makeTestEnv({ INGEST_TOKEN: "secret" });
    const ev = (id: string, city: string, address: string) =>
      raw.prepare(`INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, address, url, content_hash, first_seen_at, last_seen_at)
                   VALUES (?, ?, 'T', '2026-08-01T18:00:00Z','America/Los_Angeles', ?, ?, 'https://x/'||?, 'c'||?, '2026-07-01','2026-07-01')`).run(id, "fp-" + id, city, address, id, id);
    ev("keep", "sf-bay", "447 Minna St, San Francisco, CA 94103");
    ev("ga", "unknown", "Savannah, GA 31401");
    ev("online", "unknown", "");

    const url = "https://thebay.events/api/admin/prune-out-of-region";
    expect((await app.fetch(new Request(url, { method: "POST" }), env as any)).status).toBe(401);
    const ok = await app.fetch(new Request(url, { method: "POST", headers: { authorization: "Bearer secret" } }), env as any);
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).removed).toBe(1); // only ga
    const ids = (raw.prepare("SELECT id FROM events ORDER BY id").all() as any[]).map((r) => r.id);
    expect(ids.sort()).toEqual(["keep", "online"]);
  });
});

describe("retag admin trigger (/api/admin/retag)", () => {
  it("is bearer-gated and REPLACES categories with the fixed word-boundary tagger", async () => {
    const { env, raw } = makeTestEnv({ INGEST_TOKEN: "secret" });
    // seed an event that the OLD substring tagger mis-tagged 'software' (from 'ai' in 'Email')
    raw.prepare(`INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, categories, content_hash, tag_source, tagged_hash, first_seen_at, last_seen_at)
                 VALUES ('e1','fp1','Email Marketing Workshop','2099-08-01T18:00:00Z','America/Los_Angeles','sf-bay','https://x', '["software","tech"]','ch1','keyword','ch1','2026-07-01','2026-07-01')`).run();
    raw.prepare(`INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, categories, content_hash, tag_source, tagged_hash, first_seen_at, last_seen_at)
                 VALUES ('e2','fp2','Hardware Robotics Night','2099-08-01T18:00:00Z','America/Los_Angeles','sf-bay','https://x2', '[]','ch2',NULL,NULL,'2026-07-01','2026-07-01')`).run();

    const url = "https://thebay.events/api/admin/retag";
    expect((await app.fetch(new Request(url, { method: "POST" }), env as any)).status).toBe(401);

    const ok = await app.fetch(new Request(url, { method: "POST", headers: { authorization: "Bearer secret" } }), env as any);
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).retagged).toBe(2);

    // the false 'software' tag is GONE (replaced, not unioned); real tags applied
    expect(JSON.parse((raw.prepare("SELECT categories FROM events WHERE id='e1'").get() as any).categories)).toEqual(["tech"]);
    expect(JSON.parse((raw.prepare("SELECT categories FROM events WHERE id='e2'").get() as any).categories)).toContain("hardware");
  });
});
