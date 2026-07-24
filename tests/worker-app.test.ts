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
