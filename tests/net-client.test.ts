/**
 * The worker protocol client — the thing volunteers actually install.
 *
 * It exists once and is shared by every client shape (CLI, Chrome extension, a page you
 * leave open), because the protocol is the product: if each client re-implemented
 * lease/submit/release they would drift, and the one that drifted would look like a bad
 * actor rather than a bad build.
 *
 * So the loop is tested here, with a fake coordinator, against the behaviours that decide
 * whether a stranger's laptop is a good citizen: it honours the politeness the lease
 * carries, it hands work back when a source fails instead of holding it hostage, it never
 * normalises (that is the server's job, and doing it here would let a client aim its data),
 * and a crash in one job doesn't abandon the rest.
 */
import { describe, it, expect, vi } from "vitest";
import { NetClient, runWorker, type LeaseFromServer } from "../src/net/client";

const BASE = "https://thebay.events";

/** A coordinator that hands out `queue` in order, and records everything it was told. */
function fakeCoordinator(opts: { queue?: LeaseFromServer[][]; failSubmit?: boolean; tier?: string } = {}) {
  const calls: Array<{ path: string; body: any; auth?: string }> = [];
  const queue = [...(opts.queue ?? [])];
  const fetchImpl = (async (url: any, init: any = {}) => {
    const path = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body, auth: init.headers?.authorization });
    const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

    if (path === "/api/net/lease") return json({ ok: true, leases: queue.shift() ?? [], skipped: [], tier: opts.tier ?? "probation" });
    if (path === "/api/net/submit") {
      if (opts.failSubmit) return json({ error: "nope" }, 500);
      return json({ ok: true, accepted: body.items.length, consensus: { confirmed: 0, pending: body.items.length, contradicted: 0 }, published: 0 });
    }
    if (path.endsWith("/release")) return json({ ok: true });
    if (path === "/api/net/me") return json({ member: { tier: "trusted" }, clients: [] });
    return json({ error: "unexpected " + path }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const lease = (over: Partial<LeaseFromServer> = {}): LeaseFromServer => ({
  leaseId: "L1",
  jobId: "J1",
  sourceId: "cv",
  recipeId: "R1",
  windowStart: "2026-07-26T12:00:00.000Z",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  recipe: { type: "generic-json", params: { url: "https://api.cerebralvalley.ai/v1/x" }, host: "api.cerebralvalley.ai" },
  politeness: { host: "api.cerebralvalley.ai", minGapMs: 0, disallow: [] },
  ...over,
});

const raw = (n: number) => ({
  sourceId: "cv",
  sourceType: "generic-json",
  externalId: `e${n}`,
  title: `Event ${n}`,
  startRaw: "2026-08-01T18:00:00-07:00",
  url: `https://cerebralvalley.ai/e/${n}`,
});

describe("NetClient", () => {
  it("authenticates every call with the worker token, and never a cookie", async () => {
    const { fetchImpl, calls } = fakeCoordinator();
    const c = new NetClient({ baseUrl: BASE, token: "tok_abc", fetchImpl });
    await c.lease(3);
    expect(calls[0]!.auth).toBe("Bearer tok_abc");
    expect(calls[0]!.body).toEqual({ max: 3 });
  });

  it("tolerates a base url with a trailing slash", async () => {
    const { fetchImpl, calls } = fakeCoordinator();
    await new NetClient({ baseUrl: BASE + "///", token: "t", fetchImpl }).lease(1);
    expect(calls[0]!.path).toBe("/api/net/lease");
  });

  it("submits RAW events — never normalised ones", async () => {
    const { fetchImpl, calls } = fakeCoordinator();
    const c = new NetClient({ baseUrl: BASE, token: "t", fetchImpl });
    await c.submit("L1", [raw(1)], [{ url: "https://x/y", status: 200 }]);
    const sent = calls[0]!.body;
    expect(sent.items[0]).toHaveProperty("startRaw"); // adapter output, pre-normalisation
    expect(sent.items[0]).not.toHaveProperty("fingerprint"); // the server derives this
    expect(sent.items[0]).not.toHaveProperty("startUtc");
    expect(sent.receipts).toHaveLength(1);
  });

  it("surfaces a coordinator error instead of pretending it worked", async () => {
    const { fetchImpl } = fakeCoordinator({ failSubmit: true });
    const c = new NetClient({ baseUrl: BASE, token: "t", fetchImpl });
    await expect(c.submit("L1", [raw(1)])).rejects.toThrow(/500/);
  });
});

describe("runWorker", () => {
  it("does a whole job: lease, execute, submit", async () => {
    const { fetchImpl, calls } = fakeCoordinator({ queue: [[lease()]] });
    const client = new NetClient({ baseUrl: BASE, token: "t", fetchImpl });
    const seen: LeaseFromServer[] = [];
    const execute = async (l: LeaseFromServer) => {
      seen.push(l);
      return { raws: [raw(1), raw(2)], receipts: [] };
    };

    const summary = await runWorker({ client, execute, once: true });
    expect(summary).toMatchObject({ leased: 1, submitted: 1, failed: 0, items: 2 });
    expect(seen).toHaveLength(1);
    // The executor is handed the recipe and the politeness it must obey.
    expect(seen[0]).toMatchObject({ recipe: { type: "generic-json" }, politeness: { host: "api.cerebralvalley.ai" } });
    expect(calls.map((c) => c.path)).toEqual(["/api/net/lease", "/api/net/submit"]);
  });

  it("HANDS WORK BACK when a source fails, rather than holding it hostage", async () => {
    const { fetchImpl, calls } = fakeCoordinator({ queue: [[lease()]] });
    const client = new NetClient({ baseUrl: BASE, token: "t", fetchImpl });
    const execute = async () => {
      throw new Error("site returned 503");
    };

    const summary = await runWorker({ client, execute, once: true });
    expect(summary).toMatchObject({ leased: 1, submitted: 0, failed: 1 });
    // Released with the reason, so the coordinator can back the host off and re-offer
    // the job to somebody else immediately instead of waiting out the lease TTL.
    const release = calls.find((c) => c.path.endsWith("/release"))!;
    expect(release.body.error).toContain("503");
  });

  it("keeps going after one job fails — a bad source is not a bad night", async () => {
    const { fetchImpl } = fakeCoordinator({ queue: [[lease({ leaseId: "L1" }), lease({ leaseId: "L2", jobId: "J2" })]] });
    const client = new NetClient({ baseUrl: BASE, token: "t", fetchImpl });
    let n = 0;
    const execute = async () => {
      if (++n === 1) throw new Error("first one broke");
      return { raws: [raw(9)], receipts: [] };
    };
    const summary = await runWorker({ client, execute, once: true });
    expect(summary).toMatchObject({ leased: 2, submitted: 1, failed: 1, items: 1 });
  });

  it("submits an empty result honestly rather than dropping the lease", async () => {
    // "I looked and there was nothing" is evidence, and the coordinator needs it — a
    // silent client is indistinguishable from a dead one.
    const { fetchImpl, calls } = fakeCoordinator({ queue: [[lease()]] });
    const client = new NetClient({ baseUrl: BASE, token: "t", fetchImpl });
    const summary = await runWorker({ client, execute: async () => ({ raws: [], receipts: [] }), once: true });
    expect(summary).toMatchObject({ leased: 1, submitted: 1, items: 0 });
    expect(calls.some((c) => c.path === "/api/net/submit")).toBe(true);
  });

  it("stops cleanly when there is no work", async () => {
    const { fetchImpl, calls } = fakeCoordinator({ queue: [[]] });
    const client = new NetClient({ baseUrl: BASE, token: "t", fetchImpl });
    const summary = await runWorker({ client, execute: async () => ({ raws: [], receipts: [] }), once: true });
    expect(summary).toMatchObject({ leased: 0, submitted: 0, idle: true });
    expect(calls).toHaveLength(1);
  });

  it("waits out the politeness gap between jobs on the same host", async () => {
    // An hour, not 900ms: the assertion is about the DECISION, and a gap short enough for a
    // loaded machine's own elapsed time to satisfy would make this test pass or fail
    // depending on how busy the box was.
    const GAP = 3_600_000;
    const slept: number[] = [];
    const { fetchImpl } = fakeCoordinator({
      queue: [
        [
          lease({ leaseId: "L1", politeness: { host: "h", minGapMs: GAP, disallow: [] } }),
          lease({ leaseId: "L2", jobId: "J2", politeness: { host: "h", minGapMs: GAP, disallow: [] } }),
        ],
      ],
    });
    const client = new NetClient({ baseUrl: BASE, token: "t", fetchImpl });
    await runWorker({
      client,
      execute: async () => ({ raws: [raw(1)], receipts: [] }),
      once: true,
      sleep: async (ms) => void slept.push(ms),
    });
    // The coordinator already spaces GRANTS; this is the client's own belt-and-braces pass
    // so two jobs it holds for one host don't overlap.
    expect(slept.some((ms) => ms > GAP / 2)).toBe(true);
  });

  it("does not sleep between jobs on different hosts — polite is not slow", async () => {
    const slept: number[] = [];
    const { fetchImpl } = fakeCoordinator({
      queue: [[lease({ leaseId: "L1", politeness: { host: "a", minGapMs: 900, disallow: [] } }), lease({ leaseId: "L2", jobId: "J2", politeness: { host: "b", minGapMs: 900, disallow: [] } })]],
    });
    const client = new NetClient({ baseUrl: BASE, token: "t", fetchImpl });
    await runWorker({ client, execute: async () => ({ raws: [], receipts: [] }), once: true, sleep: async (ms) => void slept.push(ms) });
    expect(slept.filter((ms) => ms > 0)).toHaveLength(0);
  });

  it("reports progress so a human can watch it work", async () => {
    const lines: string[] = [];
    const { fetchImpl } = fakeCoordinator({ queue: [[lease()]] });
    const client = new NetClient({ baseUrl: BASE, token: "t", fetchImpl });
    await runWorker({ client, execute: async () => ({ raws: [raw(1)], receipts: [] }), once: true, onLog: (m) => lines.push(m) });
    expect(lines.join("\n")).toMatch(/cv/); // names the source it worked on
  });

  it("skips a lease that has already expired rather than wasting the fetch", async () => {
    const { fetchImpl, calls } = fakeCoordinator({ queue: [[lease({ expiresAt: new Date(Date.now() - 1000).toISOString() })]] });
    const client = new NetClient({ baseUrl: BASE, token: "t", fetchImpl });
    const execute = vi.fn(async () => ({ raws: [raw(1)], receipts: [] }));
    const summary = await runWorker({ client, execute, once: true });
    expect(execute).not.toHaveBeenCalled();
    expect(summary.failed).toBe(1);
    expect(calls.some((c) => c.path.endsWith("/release"))).toBe(true);
  });

  it("loops until told to stop, and respects a poll interval", async () => {
    const { fetchImpl } = fakeCoordinator({ queue: [[lease({ leaseId: "L1" })], [lease({ leaseId: "L2", jobId: "J2" })], []] });
    const client = new NetClient({ baseUrl: BASE, token: "t", fetchImpl });
    let rounds = 0;
    const summary = await runWorker({
      client,
      execute: async () => ({ raws: [raw(1)], receipts: [] }),
      pollMs: 5,
      sleep: async () => void 0,
      shouldContinue: () => ++rounds < 3,
    });
    expect(summary.submitted).toBe(2);
    expect(rounds).toBe(3);
  });
});
