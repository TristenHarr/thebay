/**
 * Recipes as DATA, and the audit that promotes them.
 *
 * This is the self-improving half of the network, and the safety argument rests on one
 * decision: a recipe is `{ type, params }` for an adapter that already exists in
 * src/sources/registry.ts. It cannot introduce code. So the worst a hostile or incompetent
 * contribution can do is produce bad data — which consensus already catches — rather than
 * run something.
 *
 * The audit is deliberately hard to pass. A candidate runs in SHADOW mode beside the
 * incumbent on the same windows, and it is promoted only when it is better on every axis
 * that matters and worse on none: it must not report things consensus rejects, it must find
 * at least as much, its records must be at least as complete, and it must not cost the host
 * more requests. And it must do all of that over several windows spanning several days,
 * because a recipe that got lucky once is not an improvement.
 *
 * Promotion is reversible. That is the other half of being willing to automate it at all.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { makeTestDb } from "./helpers/d1";
import { ScrapeNetRepo } from "../src/storage/d1/scrape-net-repo";
import { recipeHost } from "../src/core/scrape/host";
import {
  auditVerdict,
  fieldCompleteness,
  AUDIT_RULES,
  type RecipeStats,
} from "../src/core/scrape/audit";
import { listAdapterTypes } from "../src/sources/registry";
import { proposeRecipe, buildMessages, trimSample, looksBroken } from "../src/ai/recipe-proposer";

const T0 = Date.parse("2026-07-26T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

/** A candidate that has done plenty of good work — the baseline the tests perturb. */
const good = (over: Partial<RecipeStats> = {}): RecipeStats => ({
  windows: AUDIT_RULES.minWindows,
  spanDays: AUDIT_RULES.minDays,
  items: 100,
  confirmed: 100,
  contradicted: 0,
  fieldCompleteness: 0.8,
  // Request cost is judged PER WINDOW, so a candidate observed over fewer windows isn't
  // penalised. Both fixtures therefore sit at 2 requests per window.
  requests: 2 * AUDIT_RULES.minWindows,
  ...over,
});

const incumbent = (over: Partial<RecipeStats> = {}): RecipeStats => ({
  windows: 20,
  spanDays: 30,
  items: 80,
  confirmed: 80,
  contradicted: 0,
  fieldCompleteness: 0.7,
  requests: 2 * 20,
  ...over,
});

describe("core/scrape/audit", () => {
  it("promotes a candidate that is better on every axis and worse on none", () => {
    const r = auditVerdict(good(), incumbent());
    expect(r.verdict).toBe("promote");
    expect(r.yieldRatio).toBeGreaterThan(1);
    expect(r.precision).toBe(1);
  });

  it("WAITS rather than deciding on thin evidence — luck is not an improvement", () => {
    expect(auditVerdict(good({ windows: 1 }), incumbent()).verdict).toBe("keep");
    expect(auditVerdict(good({ spanDays: 0 }), incumbent()).verdict).toBe("keep");
    // A candidate that has run enough windows but all within one afternoon.
    const burst = auditVerdict(good({ windows: 50, spanDays: AUDIT_RULES.minDays - 1 }), incumbent());
    expect(burst.verdict).toBe("keep");
    expect(burst.reason).toMatch(/day|span/i);
  });

  it("REJECTS a candidate that reports things consensus disbelieves", () => {
    // The important one. A recipe that scrapes more by hallucinating structure is worse
    // than the one it would replace, however impressive its yield looks.
    const r = auditVerdict(good({ items: 200, confirmed: 150, contradicted: 50 }), incumbent());
    expect(r.verdict).toBe("reject");
    expect(r.precision).toBeLessThan(AUDIT_RULES.minPrecision);
    expect(r.reason).toMatch(/precision|contradict/i);
  });

  it("rejects a candidate that finds materially less than the incumbent", () => {
    const r = auditVerdict(good({ items: 40, confirmed: 40 }), incumbent());
    expect(r.verdict).toBe("reject");
    expect(r.reason).toMatch(/yield|fewer|less/i);
  });

  it("keeps waiting on a candidate that merely ties — a replacement must EARN it", () => {
    const r = auditVerdict(good({ items: 80, confirmed: 80, fieldCompleteness: 0.7 }), incumbent());
    expect(r.verdict).toBe("keep");
  });

  it("refuses to promote a candidate whose records are less complete", () => {
    // Same count of events, but half the venues and descriptions missing. More rows is not
    // more information.
    const r = auditVerdict(good({ fieldCompleteness: 0.4 }), incumbent());
    expect(r.verdict).not.toBe("promote");
    expect(r.reason).toMatch(/complete/i);
  });

  it("refuses to promote a candidate that costs the host materially more requests", () => {
    // Politeness is not negotiable for a yield bump: a recipe that finds 25% more by
    // hitting the site three times as often is a worse citizen, and we are guests.
    const r = auditVerdict(good({ requests: 8 * AUDIT_RULES.minWindows }), incumbent({ requests: 2 * 20 }));
    expect(r.verdict).not.toBe("promote");
    expect(r.reason).toMatch(/request|polite/i);
  });

  it("promotes when the incumbent has collapsed — the case this exists for", () => {
    // A site changed shape and the live recipe now finds nothing. Anything that works is
    // an improvement, and waiting for a human is how a catalog goes stale.
    const r = auditVerdict(good({ items: 30, confirmed: 30 }), incumbent({ items: 0, confirmed: 0 }));
    expect(r.verdict).toBe("promote");
  });

  it("is total: no garbage stats produce a promotion", () => {
    for (const bad of [
      good({ items: 0, confirmed: 0 }),
      good({ items: NaN as any }),
      good({ confirmed: NaN as any }),
      good({ fieldCompleteness: NaN as any }),
      good({ windows: NaN as any }),
    ]) {
      const r = auditVerdict(bad, incumbent());
      expect(["keep", "reject"], JSON.stringify(bad)).toContain(r.verdict);
      expect(Number.isFinite(r.precision)).toBe(true);
      expect(Number.isFinite(r.yieldRatio)).toBe(true);
    }
    // A negative request count is coerced to zero rather than treated as evidence — it is
    // our bookkeeping that's broken, not the recipe.
    expect(auditVerdict(good({ requests: -5 }), incumbent()).requestRatio).toBe(0);
  });

  it("measures completeness over the fields a human actually reads", () => {
    const bare = { title: "x", url: "u", startRaw: "s" };
    const rich = {
      title: "x", url: "u", startRaw: "s",
      description: "d", endRaw: "e", venueName: "v", address: "a", city: "c",
      organizer: "o", imageUrl: "i", isFree: true, priceText: "Free", timezoneHint: "America/Los_Angeles",
    };
    expect(fieldCompleteness([bare])).toBeLessThan(fieldCompleteness([rich]));
    expect(fieldCompleteness([rich])).toBe(1);
    expect(fieldCompleteness([])).toBe(0);
    // Empty strings and nulls don't count as populated — a blank venue helps nobody.
    expect(fieldCompleteness([{ ...bare, venueName: "", address: null }])).toBe(fieldCompleteness([bare]));
  });
});

describe("proposing a recipe", () => {
  let t: TestApp;
  let net: ScrapeNetRepo;

  async function member(name: string, tier: "probation" | "trusted" | "core") {
    const { cookie, user } = await login(t, `${name}@x.com`, name);
    await t.env.DB.prepare("INSERT INTO network_members (user_id, tier, joined_at) VALUES (?, ?, ?)").bind(user.id, tier, iso(T0)).run();
    return { cookie, userId: user.id };
  }

  const propose = (cookie: string, body: unknown) => call(t, "/api/net/recipes", { method: "POST", cookie, body });

  beforeEach(async () => {
    t = makeTestApp({ HANDSHAKE_KEY: "k" });
    net = new ScrapeNetRepo(t.env.DB);
    await net.seedRecipes([{ id: "cv", type: "generic-json", params: { url: "https://api.cerebralvalley.ai/v1/x" } }], recipeHost);
  });

  it("401s a stranger and 403s a probation member — proposing is earned", async () => {
    expect((await call(t, "/api/net/recipes", { method: "POST", body: {} })).status).toBe(401);
    const noob = await member("noob", "probation");
    expect((await propose(noob.cookie, { sourceId: "cv", type: "generic-json", params: { url: "https://a/b" } })).status).toBe(403);
  });

  it("accepts a well-formed candidate from a trusted member, as a new VERSION", async () => {
    const m = await member("ann", "trusted");
    const r = await propose(m.cookie, {
      sourceId: "cv",
      type: "generic-json",
      params: { url: "https://api.cerebralvalley.ai/v1/x?limit=200", itemsPath: "events", fieldMap: { title: "name", startRaw: "startDateTime", url: "url" } },
      notes: "the API takes limit=200; we were leaving events on the table",
    });
    expect(r.status).toBe(200);
    expect(r.json.version).toBe(2);
    expect(r.json.status).toBe("proposed");

    const row = await t.env.DB.prepare("SELECT * FROM scrape_recipes WHERE id = ?").bind(r.json.recipeId).first();
    expect(row.author_id).toBe(m.userId);
    expect(row.host).toBe("api.cerebralvalley.ai"); // derived, never accepted from the caller
    expect(row.status).toBe("proposed"); // it does not go live by being proposed
    // The incumbent is untouched.
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM scrape_recipes WHERE status = 'active'").first()).n).toBe(1);
  });

  it("REFUSES a type that isn't a registered adapter — a recipe cannot introduce code", async () => {
    const m = await member("ann", "trusted");
    for (const type of ["eval", "shell", "javascript", "totally-new-adapter"]) {
      const r = await propose(m.cookie, { sourceId: "cv", type, params: { url: "https://a/b" } });
      expect(r.status, type).toBe(400);
      expect(String(r.json.error)).toMatch(/adapter|type/i);
    }
    // Only what the registry already knows is acceptable.
    expect(listAdapterTypes()).toContain("generic-json");
  });

  it("REFUSES params the adapter itself rejects, using the adapter's own schema", async () => {
    const m = await member("ann", "trusted");
    // generic-json requires a url and a fieldMap; ical requires urls. Validation is the
    // adapter's `parseParams`, so there is no second schema to keep in sync.
    const noUrl = await propose(m.cookie, { sourceId: "cv", type: "generic-json", params: { itemsPath: "events", fieldMap: {} } });
    expect(noUrl.status).toBe(400);
    const noFieldMap = await propose(m.cookie, { sourceId: "cv", type: "generic-json", params: { url: "https://a/b" } });
    expect(noFieldMap.status).toBe(400);
  });

  it("REFUSES a recipe whose host we cannot determine — we won't crawl what we can't pace", async () => {
    const m = await member("ann", "trusted");
    const r = await propose(m.cookie, { sourceId: "new-cal", type: "ical", params: { urls: [] } });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/host/i);
  });

  it("lets a member propose a brand new source, not just a fix to an existing one", async () => {
    const m = await member("ann", "core");
    const r = await propose(m.cookie, {
      sourceId: "sf-hardware-collective",
      type: "ical",
      params: { urls: ["https://hardware.sf/events.ics"] },
    });
    expect(r.status).toBe(200);
    expect(r.json.version).toBe(1);
    const row = await t.env.DB.prepare("SELECT host, status FROM scrape_recipes WHERE id = ?").bind(r.json.recipeId).first();
    expect(row.host).toBe("hardware.sf");
    expect(row.status).toBe("proposed");
  });

  it("rate-limits proposals so nobody can bury the audit queue", async () => {
    const m = await member("ann", "trusted");
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await propose(m.cookie, { sourceId: `s${i}`, type: "generic-json", params: { url: `https://h${i}.example.com/api`, fieldMap: { title: "n", startRaw: "s", url: "u" } } });
      results.push(r.status);
    }
    expect(results.filter((s) => s === 200).length).toBeLessThan(12);
    expect(results).toContain(429);
  });

  it("lists the audit queue so the crowd can see what's being trialled", async () => {
    const m = await member("ann", "trusted");
    await propose(m.cookie, { sourceId: "cv", type: "generic-json", params: { url: "https://a/b", fieldMap: { title: "n", startRaw: "s", url: "u" } }, notes: "why" });
    const r = await call(t, "/api/net/recipes");
    expect(r.status).toBe(200);
    const mine = r.json.recipes.find((x: any) => x.status === "proposed");
    expect(mine).toMatchObject({ sourceId: "cv", version: 2, notes: "why", author: "ann" });
    // Never leak the author's email onto a public list.
    expect(JSON.stringify(r.json)).not.toContain("@x.com");
  });
});

describe("the shadow → active lifecycle", () => {
  let d1: any;
  let net: ScrapeNetRepo;

  /** Give a recipe a body of work: `n` windows of confirmed observations. */
  async function history(
    recipeId: string,
    o: { windows: number; spanDays: number; confirmed: number; contradicted?: number; requests?: number; completeness?: number },
  ) {
    const rec = await d1.prepare("SELECT source_id, host FROM scrape_recipes WHERE id = ?").bind(recipeId).first();
    const uid = `u_${recipeId}`;
    await d1.prepare("INSERT OR IGNORE INTO users (id, email, email_verified, handle, display_name, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?)")
      .bind(uid, `${recipeId}@x.com`, recipeId.slice(0, 12).toLowerCase(), recipeId, iso(T0), iso(T0))
      .run();
    await d1.prepare("INSERT OR IGNORE INTO network_members (user_id, tier, joined_at) VALUES (?, 'core', ?)").bind(uid, iso(T0)).run();
    await d1.prepare("INSERT OR IGNORE INTO worker_clients (id, user_id, kind, capabilities_json, token_hash, created_at) VALUES (?, ?, 'cli', '[\"fetch\"]', ?, ?)")
      .bind(`c_${recipeId}`, uid, `h_${recipeId}`, iso(T0))
      .run();

    // A payload whose populated-field count encodes the completeness we want to assert on.
    const rich = { title: "T", url: "u", startRaw: "s", description: "d", venueName: "v", address: "a", city: "c", organizer: "o", imageUrl: "i", endRaw: "e" };
    const bare = { title: "T", url: "u", startRaw: "s" };
    const payload = (o.completeness ?? 1) >= 0.9 ? rich : bare;

    for (let w = 0; w < o.windows; w++) {
      const at = T0 + Math.floor((w * o.spanDays * DAY) / Math.max(1, o.windows));
      const jobId = `${recipeId}_j${w}`;
      await d1.prepare(
        `INSERT INTO scrape_jobs (id, recipe_id, source_id, host, window_start, window_ms, status, created_at)
         VALUES (?, ?, ?, ?, ?, 21600000, 'done', ?)`,
      )
        .bind(jobId, recipeId, rec.source_id, rec.host, iso(at), iso(at))
        .run();
      const leaseId = `${recipeId}_l${w}`;
      await d1.prepare(
        `INSERT INTO scrape_leases (id, job_id, client_id, member_id, granted_at, expires_at, submitted_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted')`,
      )
        .bind(leaseId, jobId, `c_${recipeId}`, uid, iso(at), iso(at + 600_000), iso(at + 1000))
        .run();

      for (let i = 0; i < o.confirmed; i++) {
        await d1.prepare(
          `INSERT INTO scrape_observations (id, lease_id, job_id, member_id, item_key, fingerprint, payload_json, status, resolved_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)`,
        )
          .bind(`${leaseId}_o${i}`, leaseId, jobId, uid, `${recipeId}_k${i}`, `fp_${recipeId}_${i}`, JSON.stringify(payload), iso(at), iso(at))
          .run();
      }
      for (let i = 0; i < (o.contradicted ?? 0); i++) {
        await d1.prepare(
          `INSERT INTO scrape_observations (id, lease_id, job_id, member_id, item_key, fingerprint, payload_json, status, resolved_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'contradicted', ?, ?)`,
        )
          .bind(`${leaseId}_x${i}`, leaseId, jobId, uid, `${recipeId}_bad${i}`, `fpx_${recipeId}_${i}`, JSON.stringify(payload), iso(at), iso(at))
          .run();
      }
      for (let i = 0; i < (o.requests ?? 1); i++) {
        await d1.prepare("INSERT INTO scrape_receipts (id, lease_id, url, status) VALUES (?, ?, ?, 200)")
          .bind(`${leaseId}_r${i}`, leaseId, `https://${rec.host}/p${i}`)
          .run();
      }
    }
  }

  const activeFor = async (sourceId: string) =>
    await d1.prepare("SELECT id, version FROM scrape_recipes WHERE source_id = ? AND status = 'active'").bind(sourceId).first();

  beforeEach(async () => {
    ({ d1 } = makeTestDb());
    net = new ScrapeNetRepo(d1);
    await net.seedRecipes([{ id: "cv", type: "generic-json", params: { url: "https://api.cerebralvalley.ai/v1/x" } }], recipeHost, T0);
  });

  it("moves a proposal into shadow so it runs BESIDE the incumbent, never instead of it", async () => {
    const cand = await net.proposeRecipe({
      sourceId: "cv",
      type: "generic-json",
      params: { url: "https://api.cerebralvalley.ai/v1/x?limit=200", fieldMap: { title: "n", startRaw: "s", url: "u" } },
      host: "api.cerebralvalley.ai",
      authorId: null,
    });
    expect(await net.startShadow(cand.recipeId)).toBe(true);

    const schedulable = await net.schedulableRecipes();
    expect(schedulable.map((r) => r.status).sort()).toEqual(["active", "shadow"]);
    // A shadow job wants MORE observers, because it is the thing under suspicion.
    await net.plan(T0);
    const jobs = await d1.prepare("SELECT r.status, j.target_observers FROM scrape_jobs j JOIN scrape_recipes r ON r.id = j.recipe_id").all();
    const shadowJob = (jobs.results as any[]).find((j) => j.status === "shadow");
    expect(shadowJob.target_observers).toBeGreaterThan(2);
  });

  it("promotes a candidate that earns it, retires the incumbent, and logs the decision", async () => {
    const before = await activeFor("cv");
    const cand = await net.proposeRecipe({
      sourceId: "cv",
      type: "generic-json",
      params: { url: "https://api.cerebralvalley.ai/v1/x?limit=200", fieldMap: { title: "n", startRaw: "s", url: "u" } },
      host: "api.cerebralvalley.ai",
      authorId: null,
    });
    await net.startShadow(cand.recipeId);
    await history(before.id, { windows: 6, spanDays: 10, confirmed: 8, requests: 2, completeness: 0.3 });
    await history(cand.recipeId, { windows: 6, spanDays: 10, confirmed: 20, requests: 2, completeness: 1 });

    const results = await net.auditShadows(T0 + 11 * DAY);
    expect(results).toHaveLength(1);
    expect(results[0]!.verdict).toBe("promote");

    // Exactly one active recipe, and it's the new one.
    const now = await activeFor("cv");
    expect(now.id).toBe(cand.recipeId);
    expect(now.version).toBe(2);
    const old = await d1.prepare("SELECT status, retired_at FROM scrape_recipes WHERE id = ?").bind(before.id).first();
    expect(old.status).toBe("retired");
    expect(old.retired_at).toBeTruthy();

    // Logged, with the numbers that justified it — a promotion nobody can reconstruct is
    // a promotion nobody can argue with.
    const audit = await d1.prepare("SELECT * FROM recipe_audits WHERE recipe_id = ?").bind(cand.recipeId).first();
    expect(audit.verdict).toBe("promote");
    expect(JSON.parse(audit.stats_json).candidate.confirmed).toBeGreaterThan(0);
    expect(audit.reason).toBeTruthy();
  });

  it("rejects a candidate that reports what consensus disbelieves, and keeps the incumbent", async () => {
    const before = await activeFor("cv");
    const cand = await net.proposeRecipe({
      sourceId: "cv",
      type: "generic-json",
      params: { url: "https://api.cerebralvalley.ai/v1/junk", fieldMap: { title: "n", startRaw: "s", url: "u" } },
      host: "api.cerebralvalley.ai",
      authorId: null,
    });
    await net.startShadow(cand.recipeId);
    await history(before.id, { windows: 6, spanDays: 10, confirmed: 20, requests: 2 });
    await history(cand.recipeId, { windows: 6, spanDays: 10, confirmed: 30, contradicted: 15, requests: 2 });

    const [r] = await net.auditShadows(T0 + 11 * DAY);
    expect(r!.verdict).toBe("reject");
    expect((await activeFor("cv")).id).toBe(before.id); // untouched
    const row = await d1.prepare("SELECT status FROM scrape_recipes WHERE id = ?").bind(cand.recipeId).first();
    expect(row.status).toBe("retired"); // rejected candidates stop consuming lease slots
  });

  it("leaves a candidate in shadow while the evidence is thin", async () => {
    const before = await activeFor("cv");
    const cand = await net.proposeRecipe({
      sourceId: "cv",
      type: "generic-json",
      params: { url: "https://api.cerebralvalley.ai/v1/x?limit=200", fieldMap: { title: "n", startRaw: "s", url: "u" } },
      host: "api.cerebralvalley.ai",
      authorId: null,
    });
    await net.startShadow(cand.recipeId);
    await history(before.id, { windows: 1, spanDays: 1, confirmed: 5 });
    await history(cand.recipeId, { windows: 1, spanDays: 1, confirmed: 9 });

    const [r] = await net.auditShadows(T0 + 2 * DAY);
    expect(r!.verdict).toBe("keep");
    const row = await d1.prepare("SELECT status FROM scrape_recipes WHERE id = ?").bind(cand.recipeId).first();
    expect(row.status).toBe("shadow"); // still being trialled
    expect((await activeFor("cv")).id).toBe(before.id);
  });

  it("is REVERSIBLE: a promotion that goes wrong is one call to undo", async () => {
    const before = await activeFor("cv");
    const cand = await net.proposeRecipe({
      sourceId: "cv",
      type: "generic-json",
      params: { url: "https://api.cerebralvalley.ai/v1/x?limit=200", fieldMap: { title: "n", startRaw: "s", url: "u" } },
      host: "api.cerebralvalley.ai",
      authorId: null,
    });
    await net.startShadow(cand.recipeId);
    await history(before.id, { windows: 6, spanDays: 10, confirmed: 8, requests: 2, completeness: 0.3 });
    await history(cand.recipeId, { windows: 6, spanDays: 10, confirmed: 20, requests: 2, completeness: 1 });
    await net.auditShadows(T0 + 11 * DAY);
    expect((await activeFor("cv")).id).toBe(cand.recipeId);

    expect(await net.rollbackRecipe("cv", T0 + 12 * DAY)).toBe(true);
    // The previous version is live again and the bad one is retired — no deploy, no
    // migration, and the audit trail keeps both.
    expect((await activeFor("cv")).id).toBe(before.id);
    expect((await d1.prepare("SELECT status FROM scrape_recipes WHERE id = ?").bind(cand.recipeId).first()).status).toBe("retired");
    const log = await d1.prepare("SELECT verdict FROM recipe_audits WHERE recipe_id = ? ORDER BY created_at DESC").bind(cand.recipeId).first();
    expect(log.verdict).toBe("rollback");
  });

  it("keeps exactly one active recipe per source, always", async () => {
    // The partial unique index makes the bad state unrepresentable rather than something
    // every writer has to remember.
    const before = await activeFor("cv");
    await expect(
      d1
        .prepare(
          `INSERT INTO scrape_recipes (id, source_id, version, type, params_json, host, status, created_at)
           VALUES ('dupe', 'cv', 99, 'generic-json', '{}', 'h', 'active', ?)`,
        )
        .bind(iso(T0))
        .run(),
    ).rejects.toThrow();
    expect((await activeFor("cv")).id).toBe(before.id);
  });

  it("awards the author when their recipe survives the audit", async () => {
    const uid = "author1";
    await d1.prepare("INSERT INTO users (id, email, email_verified, handle, display_name, created_at, updated_at) VALUES (?, 'a@x.com', 1, 'author1', 'A', ?, ?)")
      .bind(uid, iso(T0), iso(T0))
      .run();
    await d1.prepare("INSERT INTO network_members (user_id, tier, joined_at) VALUES (?, 'trusted', ?)").bind(uid, iso(T0)).run();

    const before = await activeFor("cv");
    const cand = await net.proposeRecipe({
      sourceId: "cv",
      type: "generic-json",
      params: { url: "https://api.cerebralvalley.ai/v1/x?limit=200", fieldMap: { title: "n", startRaw: "s", url: "u" } },
      host: "api.cerebralvalley.ai",
      authorId: uid,
    });
    await net.startShadow(cand.recipeId);
    await history(before.id, { windows: 6, spanDays: 10, confirmed: 8, requests: 2, completeness: 0.3 });
    await history(cand.recipeId, { windows: 6, spanDays: 10, confirmed: 20, requests: 2, completeness: 1 });
    await net.auditShadows(T0 + 11 * DAY);

    const pts = await d1.prepare("SELECT kind, points, dedup_key FROM points_ledger WHERE user_id = ? AND kind = 'recipe'").bind(uid).all();
    expect(pts.results).toHaveLength(1);
    // Idempotent: a second audit pass cannot pay twice.
    await net.auditShadows(T0 + 12 * DAY);
    const again = await d1.prepare("SELECT COUNT(*) AS n FROM points_ledger WHERE user_id = ? AND kind = 'recipe'").bind(uid).first();
    expect(again.n).toBe(1);
  });

  it("does nothing at all when there are no shadows to judge", async () => {
    expect(await net.auditShadows(T0)).toEqual([]);
  });
});

describe("promoting proposals into the trial", () => {
  let d1: any;
  let net: ScrapeNetRepo;

  beforeEach(async () => {
    ({ d1 } = makeTestDb());
    net = new ScrapeNetRepo(d1);
    await net.seedRecipes([{ id: "cv", type: "generic-json", params: { url: "https://api.cerebralvalley.ai/v1/x" } }], recipeHost, T0);
  });

  it("auto-shadows a candidate for a host we ALREADY crawl", async () => {
    const c = await net.proposeRecipe({
      sourceId: "cv",
      type: "generic-json",
      params: { url: "https://api.cerebralvalley.ai/v1/x?limit=200", fieldMap: { title: "n", startRaw: "s", url: "u" } },
      host: "api.cerebralvalley.ai",
      authorId: null,
    });
    const { shadowed, heldForReview } = await net.promoteProposals(T0);
    expect(shadowed).toEqual([c.recipeId]);
    expect(heldForReview).toEqual([]);
  });

  it("HOLDS a candidate that would aim the fleet at a brand-new host", async () => {
    // Rate limits bound how many of these a member can file; they don't make "point fifty
    // residential browsers at a stranger's small site" a decision a cron should take.
    const c = await net.proposeRecipe({
      sourceId: "someones-blog",
      type: "ical",
      params: { urls: ["https://a-small-site.example.org/events.ics"] },
      host: "a-small-site.example.org",
      authorId: null,
    });
    const { shadowed, heldForReview } = await net.promoteProposals(T0);
    expect(shadowed).toEqual([]);
    expect(heldForReview).toEqual([c.recipeId]);
    expect((await d1.prepare("SELECT status FROM scrape_recipes WHERE id = ?").bind(c.recipeId).first()).status).toBe("proposed");
    // A human moving it along is one call, and then it trials like anything else.
    expect(await net.startShadow(c.recipeId)).toBe(true);
  });

  it("does nothing when there is nothing proposed", async () => {
    expect(await net.promoteProposals(T0)).toEqual({ shadowed: [], heldForReview: [] });
  });
});

describe("the cron runs the scrapers' release cycle", () => {
  it("shadows, judges and plans on a single tick — no deploy in the loop", async () => {
    const worker = (await import("../src/worker/index")).default;
    const { env } = await import("./helpers/app").then((m) => m.makeTestEnv());
    const net = new ScrapeNetRepo(env.DB);

    const drive = async () => {
      const pending: Promise<unknown>[] = [];
      await worker.scheduled({} as any, env as any, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as any);
      await Promise.allSettled(pending);
    };

    await drive(); // seeds recipes from config + plans the first jobs
    const live = await d1Count(env, "SELECT COUNT(*) AS n FROM scrape_recipes WHERE status = 'active'");
    expect(live).toBeGreaterThan(0);

    // A candidate for a host we already crawl gets picked up by the next tick with nobody
    // touching it.
    const seed = await env.DB.prepare("SELECT source_id, type, params_json, host FROM scrape_recipes WHERE status = 'active' LIMIT 1").first();
    const cand = await net.proposeRecipe({
      sourceId: seed.source_id,
      type: seed.type,
      params: { ...JSON.parse(seed.params_json), maxPages: 3 },
      host: seed.host,
      authorId: null,
    });
    await drive();
    expect((await env.DB.prepare("SELECT status FROM scrape_recipes WHERE id = ?").bind(cand.recipeId).first()).status).toBe("shadow");

    // And it is judged — `keep` on thin evidence, which is the correct non-answer.
    const audit = await env.DB.prepare("SELECT verdict FROM recipe_audits WHERE recipe_id = ?").bind(cand.recipeId).first();
    expect(audit.verdict).toBe("keep");
  });
});

async function d1Count(env: any, sql: string): Promise<number> {
  const r = await env.DB.prepare(sql).first();
  return r.n;
}

describe("ai/recipe-proposer", () => {
  const input = {
    sourceId: "cv",
    type: "generic-json",
    currentParams: { url: "https://api.cerebralvalley.ai/v1/x", itemsPath: "events", fieldMap: { title: "name", startRaw: "startDateTime", url: "url" } },
    symptom: "found nothing across 6 windows",
    sample: [{ id: "1", eventName: "AI Infra Night", starts_at: "2026-08-01T18:00:00-07:00", permalink: "https://cv.ai/e/1" }],
  };

  /** A model that returns whatever `reply` says, with no network at all. Uses the Workers-AI
   *  branch of `chatComplete`, which takes an injected `env.AI` — so this exercises the real
   *  parse/validate path rather than stubbing the function under test. */
  const fakeModel = (reply: unknown) =>
    ({ openrouterKey: null, model: null, env: { AI: { run: async () => ({ response: JSON.stringify(reply) }) } } }) as any;

  it("keeps the prompt bounded and puts the real payload in front of the model", () => {
    const msgs = buildMessages(input);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.content).toContain("starts_at"); // the sample's ACTUAL key
    expect(msgs[1]!.content).toContain("startDateTime"); // and the mapping that stopped working
    expect(trimSample(Array.from({ length: 500 }, (_, i) => ({ i, pad: "x".repeat(200) }))).length).toBeLessThan(4200);
  });

  it("accepts a fix that the adapter itself validates", async () => {
    const p = await proposeRecipe(
      input,
      fakeModel({
        params: { url: "https://api.cerebralvalley.ai/v1/x", itemsPath: "events", fieldMap: { title: "eventName", startRaw: "starts_at", url: "permalink" } },
        reason: "the API renamed name→eventName, startDateTime→starts_at, url→permalink",
        confidence: 0.9,
      }),
    );
    expect(p).toMatchObject({ sourceId: "cv", type: "generic-json", host: "api.cerebralvalley.ai" });
    expect((p!.params as any).fieldMap.startRaw).toBe("starts_at");
  });

  it("REFUSES params the adapter rejects — a model gets no more trust than a stranger", async () => {
    // No url at all: `parseParams` throws, and that is the end of it.
    expect(await proposeRecipe(input, fakeModel({ params: { itemsPath: "events", fieldMap: { title: "eventName" } }, reason: "x", confidence: 1 }))).toBeNull();
  });

  it("refuses a proposal it cannot place on a host", async () => {
    expect(
      await proposeRecipe({ ...input, type: "ical", currentParams: { urls: ["https://a/b.ics"] } }, fakeModel({ params: { urls: [] }, reason: "x", confidence: 1 })),
    ).toBeNull();
  });

  it("refuses to burn a shadow slot re-proving the status quo", async () => {
    expect(await proposeRecipe(input, fakeModel({ params: input.currentParams, reason: "looks fine", confidence: 0.9 }))).toBeNull();
    // ...including when the same params arrive with their keys in a different order.
    const shuffled = { fieldMap: { url: "url", startRaw: "startDateTime", title: "name" }, itemsPath: "events", url: input.currentParams.url };
    expect(await proposeRecipe(input, fakeModel({ params: shuffled, reason: "same", confidence: 0.9 }))).toBeNull();
  });

  it("declines when the model isn't confident, and when there is no model at all", async () => {
    expect(await proposeRecipe(input, fakeModel({ params: { url: "https://a/b", fieldMap: { title: "t", startRaw: "s", url: "u" } }, reason: "guess", confidence: 0.1 }))).toBeNull();
    expect(await proposeRecipe(input, { openrouterKey: null, model: null } as any)).toBeNull(); // no model configured at all
  });

  it("never spends a call on an adapter type that doesn't exist", async () => {
    let called = false;
    const spy = { openrouterKey: null, model: null, env: { AI: { run: async () => { called = true; return { response: "{}" }; } } } } as any;
    expect(await proposeRecipe({ ...input, type: "not-an-adapter" }, spy)).toBeNull();
    expect(called).toBe(false);
  });

  it("calls a source broken on a DROP, not on being small", () => {
    // A calendar that has always returned two events a week is working fine, and a threshold
    // on volume would have us re-proposing its recipe forever.
    expect(looksBroken({ confirmed: 6, windows: 3 }, { confirmed: 20, windows: 10 })).toBeNull();
    expect(looksBroken({ confirmed: 0, windows: 6 }, { confirmed: 60, windows: 10 })).toMatch(/found nothing/);
    expect(looksBroken({ confirmed: 3, windows: 6 }, { confirmed: 60, windows: 10 })).toMatch(/fell from/);
    // Not enough evidence to call it either way.
    expect(looksBroken({ confirmed: 0, windows: 2 }, { confirmed: 60, windows: 10 })).toBeNull();
    // A source that never worked isn't newly broken.
    expect(looksBroken({ confirmed: 0, windows: 9 }, { confirmed: 0, windows: 9 })).toBeNull();
  });
});
