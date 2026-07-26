/**
 * The two shared guards: the operator's bearer token, and rate limiting.
 *
 * Both existed already, and both existed thirteen and two times respectively. The bearer check
 * was copy-pasted into `src/worker/index.ts` (seven times), four route modules and
 * `src/worker/news.ts`; the rate limiter lived in `src/news/` and could not be reached from the
 * events Worker. Duplicated security checks drift, and the drift that matters is silent — one
 * copy that forgets the `!token` guard turns an admin route into an open one the moment the
 * secret is unset.
 *
 * So these tests assert the properties across the WHOLE admin surface, discovered from the
 * routes themselves rather than from a list somebody has to remember to update.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { makeTestApp, makeTestEnv, call, login, type TestApp } from "./helpers/app";
import { timingSafeEqual, ingestTokenOk } from "../src/worker/middleware/bearer";
import { checkRate } from "../src/worker/middleware/ratelimit";
import { LIMITS, rateVerdict, waitMessage } from "../src/core/ratelimit";

const TOKEN = "s3cret-operator-token";

describe("middleware/bearer", () => {
  it("compares in constant time, and never throws on user input", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    // Length mismatch, empty, and non-strings are all false rather than a throw — every one of
    // these arrives straight from a header.
    expect(timingSafeEqual("abc", "ab")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(false);
    expect(timingSafeEqual(undefined as any, "x")).toBe(false);
    expect(timingSafeEqual("x", null as any)).toBe(false);
  });

  it("FAILS CLOSED when no token is configured", () => {
    // The whole reason to centralise this: an unset secret must never mean "no check needed".
    const req = (h?: string) => ({ header: () => h }) as any;
    expect(ingestTokenOk({ env: {} as any, req: req("Bearer anything") })).toBe(false);
    expect(ingestTokenOk({ env: { INGEST_TOKEN: "" } as any, req: req("Bearer ") })).toBe(false);
    expect(ingestTokenOk({ env: { INGEST_TOKEN: TOKEN } as any, req: req(`Bearer ${TOKEN}`) })).toBe(true);
    expect(ingestTokenOk({ env: { INGEST_TOKEN: TOKEN } as any, req: req(TOKEN) })).toBe(false); // scheme required
    expect(ingestTokenOk({ env: { INGEST_TOKEN: TOKEN } as any, req: req(undefined) })).toBe(false);
  });

  it("has exactly ONE implementation left in the source tree", () => {
    // Discovered, not remembered. Thirteen copies is thirteen chances to drift; if a new one
    // appears, this names the file.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = resolve(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) {
          const src = readFileSync(p, "utf8");
          if (src.includes("c.env.INGEST_TOKEN") && !p.endsWith("middleware/bearer.ts")) offenders.push(p.replace(process.cwd() + "/", ""));
        }
      }
    };
    walk(resolve(process.cwd(), "src"));
    expect(
      offenders,
      `These read INGEST_TOKEN directly instead of using requireIngestToken/ingestTokenOk ` +
        `(src/worker/middleware/bearer.ts): ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

describe("every admin route is still gated", () => {
  /**
   * The admin surface, discovered from the source rather than hand-listed — a route added
   * without a guard shows up here instead of in production.
   */
  const adminRoutes = (() => {
    const files = ["src/worker/index.ts", "src/worker/news.ts", ...readdirSync(resolve(process.cwd(), "src/worker/routes")).map((f) => `src/worker/routes/${f}`)];
    const found: Array<{ path: string; guarded: boolean; file: string }> = [];
    for (const f of files.filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(resolve(process.cwd(), f), "utf8");
      for (const m of src.matchAll(/app\.(post|get|put|delete)\(\s*"(\/api\/admin\/[^"]+)"\s*,\s*([^\s(]*)/g)) {
        found.push({ path: m[2]!, guarded: /requireIngestToken|requireAdmin/.test(m[3]!), file: f });
      }
    }
    return found;
  })();

  it("found the admin surface", () => {
    expect(adminRoutes.length).toBeGreaterThan(8);
  });

  it("guards every /api/admin route with the shared middleware or an inline check it declares", () => {
    // A route whose third argument isn't a guard must be checking inside the handler; the
    // behavioural test below is what actually proves the gate, route by route.
    const unguarded = adminRoutes.filter((r) => !r.guarded).map((r) => `${r.path} (${r.file})`);
    expect(unguarded, `these /api/admin routes declare no guard middleware: ${unguarded.join(", ")}`).toEqual([]);
  });

  it("401s every admin route with no token, a wrong token, and a raw token", async () => {
    const t = makeTestApp({ INGEST_TOKEN: TOKEN });
    // Only the ones mounted on the events Worker's own app; the news ones live on the other host.
    const paths = ["/api/admin/ingest", "/api/admin/scrape-report", "/api/admin/renormalize", "/api/admin/prune-out-of-region", "/api/admin/retag", "/api/admin/run-autopilot", "/api/admin/geocode", "/api/admin/enrich", "/api/admin/reindex", "/api/admin/tags", "/api/admin/places-import"];
    const worker = (await import("../src/worker/index")).default;
    const hit = (p: string, headers: Record<string, string> = {}) =>
      worker.fetch(new Request("https://thebay.events" + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" }), t.env as any, {} as any);

    for (const p of paths) {
      expect((await hit(p)).status, `${p} with no token`).toBe(401);
      expect((await hit(p, { authorization: "Bearer wrong" })).status, `${p} with a wrong token`).toBe(401);
      expect((await hit(p, { authorization: TOKEN })).status, `${p} with no Bearer scheme`).toBe(401);
      // With the right token it gets past auth — a 400 for a bogus body is the pass condition.
      expect([200, 400, 409], `${p} with the right token`).toContain((await hit(p, { authorization: `Bearer ${TOKEN}` })).status);
    }
  });

  it("401s every admin route when the deployment has NO token configured", async () => {
    const { env } = makeTestEnv(); // no INGEST_TOKEN
    const worker = (await import("../src/worker/index")).default;
    for (const p of ["/api/admin/ingest", "/api/admin/enrich", "/api/admin/places-import"]) {
      const res = await worker.fetch(
        new Request("https://thebay.events" + p, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer anything" }, body: "{}" }),
        env as any,
        {} as any,
      );
      expect(res.status, p).toBe(401);
    }
  });

  it("never issues a worker token that reaches an admin route", async () => {
    // The reason worker tokens exist at all. A volunteer's credential must not be able to
    // renormalize the catalog or run the autopilot.
    const t = makeTestApp({ INGEST_TOKEN: TOKEN, HANDSHAKE_KEY: "k" });
    const { cookie, user } = await login(t, "w@x.com", "W");
    await t.env.DB.prepare("INSERT INTO network_members (user_id, tier, joined_at) VALUES (?, 'core', ?)").bind(user.id, new Date().toISOString()).run();
    const { token } = (await call(t, "/api/net/clients", { method: "POST", cookie, body: { kind: "cli" } })).json;

    const worker = (await import("../src/worker/index")).default;
    for (const p of ["/api/admin/ingest", "/api/admin/renormalize", "/api/admin/run-autopilot", "/api/admin/enrich"]) {
      const res = await worker.fetch(
        new Request("https://thebay.events" + p, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}" }),
        t.env as any,
        {} as any,
      );
      expect(res.status, `worker token must not reach ${p}`).toBe(401);
    }
  });
});

describe("middleware/ratelimit", () => {
  let env: any;
  beforeEach(() => {
    ({ env } = makeTestEnv());
  });

  it("counts a permitted action and refuses past the cap", async () => {
    const limit = LIMITS.net_join;
    for (let i = 0; i < limit.max; i++) {
      expect((await checkRate(env, "net_join", "u1")).ok, `attempt ${i + 1}`).toBe(true);
    }
    const over = await checkRate(env, "net_join", "u1");
    expect(over.ok).toBe(false);
    expect(over.retryAfter).toBe(limit.windowSeconds);
    expect(over.wait).toBeTruthy();
  });

  it("does NOT consume quota on a refusal", async () => {
    // A refusal that also counted would let a blocked client hold itself blocked by retrying.
    for (let i = 0; i < LIMITS.net_join.max; i++) await checkRate(env, "net_join", "u1");
    const a = await checkRate(env, "net_join", "u1");
    const b = await checkRate(env, "net_join", "u1");
    expect([a.ok, b.ok]).toEqual([false, false]);
    // The counter stopped at the cap rather than climbing with every rejected retry.
    const key = [...(env.SESSIONS._map as Map<string, string>).entries()].find(([k]) => k.startsWith("rl:net_join:u1:"))!;
    expect(Number(key[1])).toBe(LIMITS.net_join.max);
  });

  it("keeps subjects and kinds separate", async () => {
    for (let i = 0; i < LIMITS.net_join.max; i++) await checkRate(env, "net_join", "u1");
    expect((await checkRate(env, "net_join", "u2")).ok).toBe(true); // a different person
    expect((await checkRate(env, "net_invite", "u1")).ok).toBe(true); // a different action
  });

  it("rolls over into the next window", async () => {
    const t0 = Date.parse("2026-07-26T12:00:00Z");
    for (let i = 0; i < LIMITS.net_join.max; i++) await checkRate(env, "net_join", "u1", t0);
    expect((await checkRate(env, "net_join", "u1", t0)).ok).toBe(false);
    expect((await checkRate(env, "net_join", "u1", t0 + LIMITS.net_join.windowSeconds * 1000)).ok).toBe(true);
  });

  it("honours a cooldown where one is defined, and has none where it would hurt", async () => {
    const t0 = Date.parse("2026-07-26T12:00:00Z");
    // `submit` (thebay.news) has a 60s cooldown — a loud, broadcast action.
    expect((await checkRate(env, "submit", "u1", t0)).ok).toBe(true);
    const soon = await checkRate(env, "submit", "u1", t0 + 1000);
    expect(soon.ok).toBe(false);
    expect(soon.retryAfter).toBeLessThanOrEqual(60);
    expect((await checkRate(env, "submit", "u1", t0 + 61_000)).ok).toBe(true);

    // The handshake pair has NO cooldown, on purpose: a joiner told to stand nearer must be
    // able to step closer and retry instantly, and the display re-mints every ~27 seconds.
    expect(LIMITS.net_join).not.toHaveProperty("cooldownSeconds");
    expect(LIMITS.net_invite).not.toHaveProperty("cooldownSeconds");
    expect((await checkRate(env, "net_join", "u2", t0)).ok).toBe(true);
    expect((await checkRate(env, "net_join", "u2", t0 + 1)).ok).toBe(true);
  });

  it("leaves the pure policy exactly where the news site left it", () => {
    // The move to core must be a move, not a rewrite: the news site's behaviour is unchanged.
    expect(rateVerdict({ inWindow: 0, limit: LIMITS.submit })).toMatchObject({ ok: true });
    expect(rateVerdict({ inWindow: 5, limit: LIMITS.submit })).toMatchObject({ ok: false, remaining: 0 });
    expect(rateVerdict({ inWindow: 0, limit: LIMITS.submit, sinceLastSeconds: 10 })).toMatchObject({ ok: false });
    expect(waitMessage(45)).toBe("45s");
    expect(waitMessage(120)).toBe("2 min");
    expect(waitMessage(0)).toBe("");
  });
});

describe("the network's own rate limits, over HTTP", () => {
  it("429s a member looping handshake sessions, with a retry-after", async () => {
    const t = makeTestApp({ HANDSHAKE_KEY: "k" });
    const { cookie, user } = await login(t, "amb@x.com", "Amb");
    await t.env.DB.prepare("INSERT INTO network_members (user_id, tier, joined_at) VALUES (?, 'core', ?)").bind(user.id, new Date().toISOString()).run();
    const SF = { lat: 37.7879, lng: -122.4075 };

    // Burn the hourly cap directly through the limiter, then prove the route honours it.
    for (let i = 0; i < LIMITS.net_invite.max; i++) await checkRate(t.env, "net_invite", user.id);
    const r = await call(t, "/api/net/invite", { method: "POST", cookie, body: SF });
    expect(r.status).toBe(429);
    expect(r.json.reason).toBe("rate_limited");
    expect(r.res.headers.get("retry-after")).toBeTruthy();
  });

  it("429s a client looping join attempts", async () => {
    const t = makeTestApp({ HANDSHAKE_KEY: "k" });
    const { cookie, user } = await login(t, "b@x.com", "B");
    for (let i = 0; i < LIMITS.net_join.max; i++) await checkRate(t.env, "net_join", user.id);
    const r = await call(t, "/api/net/join", {
      method: "POST",
      cookie,
      body: { sessionId: "01NOPE", frames: [{ step: 1, code: "aaaa" }, { step: 2, code: "bbbb" }], lat: 37.7879, lng: -122.4075 },
    });
    expect(r.status).toBe(429);
  });
});
