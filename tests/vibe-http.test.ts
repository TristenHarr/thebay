import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { POINTS } from "../shared/schema";

/* eslint-disable @typescript-eslint/no-explicit-any */
let t: TestApp;

const SLIDERS = { energy: 90, formality: 20, intimacy: 30, talkRatio: 10, signal: 85, approachability: 80 };

async function hostEvent(cookie: string, title = "Founders Happy Hour", startUtc = "2026-09-01T18:00:00Z") {
  const r = await call(t, "/api/host", { method: "POST", cookie, body: { title, startUtc } });
  expect(r.status).toBe(200);
  return r.json.id as string;
}
/** Real door check-in, through the real endpoints — that's what verifies a report. */
async function checkIn(hostCookie: string, goerCookie: string, eventId: string) {
  const tok = await call(t, `/api/events/${eventId}/checkin-token`, { method: "POST", cookie: hostCookie });
  const r = await call(t, `/api/events/${eventId}/checkin`, { method: "POST", cookie: goerCookie, body: { token: tok.json.token } });
  expect(r.json.result).toBe("ok");
}

beforeEach(() => { t = makeTestApp(); });
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/events/:id/vibe — the card always renders", () => {
  it("serves a full card with NO model configured at all", async () => {
    const h = await login(t, "host@x.com", "Host");
    const id = await hostEvent(h.cookie);

    const r = await call(t, `/api/events/${id}/vibe`);
    expect(r.status).toBe(200);
    const v = r.json.vibe;
    expect(v).toBeTruthy();
    for (const a of ["energy", "formality", "intimacy", "talkRatio", "signal", "approachability"]) {
      expect(typeof v.axes[a]).toBe("number");
      expect(v.axes[a]).toBeGreaterThanOrEqual(0);
      expect(v.axes[a]).toBeLessThanOrEqual(100);
    }
    expect(v.headline.length).toBeGreaterThan(5);
    expect(v.blurb.length).toBeGreaterThan(40);
    expect(v.bestFor.length).toBeGreaterThan(0);
    expect(v.expect.length).toBeGreaterThan(0);
    expect(v.model).toBeNull(); // the deterministic template wrote it
  });

  it("never calls a model on the read path when none is configured", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const h = await login(t, "host@x.com", "Host");
    const id = await hostEvent(h.cookie);
    expect((await call(t, `/api/events/${id}/vibe`)).status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is honest: a fresh room is 'predicted' with 0 reports, never fake agreement", async () => {
    const h = await login(t, "host@x.com", "Host");
    const id = await hostEvent(h.cookie);
    const v = (await call(t, `/api/events/${id}/vibe`)).json.vibe;
    expect(v.source).toBe("predicted");
    expect(v.nReports).toBe(0);
    expect(v.confidence).toBeCloseTo(0.3, 5);
  });

  it("round-trips source + nReports to the client once attendees report", async () => {
    const h = await login(t, "host@x.com", "Host");
    const id = await hostEvent(h.cookie);
    for (const who of ["a", "b"]) {
      const u = await login(t, `${who}@x.com`, who);
      await checkIn(h.cookie, u.cookie, id);
      await call(t, `/api/events/${id}/vibe/report`, { method: "POST", cookie: u.cookie, body: SLIDERS });
    }
    const v = (await call(t, `/api/events/${id}/vibe`)).json.vibe;
    expect(v.source).toBe("blended");
    expect(v.nReports).toBe(2);
    expect(v.confidence).toBeGreaterThan(0.3);
  });

  it("404s an event that doesn't exist rather than inventing a vibe for it", async () => {
    expect((await call(t, "/api/events/nope/vibe")).status).toBe(404);
  });

  it("tells a signed-in attendee whether they may report, and echoes their own report back", async () => {
    const h = await login(t, "host@x.com", "Host");
    const g = await login(t, "goer@x.com", "Goer");
    const id = await hostEvent(h.cookie);

    const before = await call(t, `/api/events/${id}/vibe`, { cookie: g.cookie });
    expect(before.json.canReport).toBe(false); // never showed up
    expect(before.json.myReport).toBeNull();

    await checkIn(h.cookie, g.cookie, id);
    expect((await call(t, `/api/events/${id}/vibe`, { cookie: g.cookie })).json.canReport).toBe(true);

    await call(t, `/api/events/${id}/vibe/report`, { method: "POST", cookie: g.cookie, body: { ...SLIDERS, worthIt: 5, tags: ["free food"] } });
    const after = await call(t, `/api/events/${id}/vibe`, { cookie: g.cookie });
    expect(after.json.myReport).toMatchObject({ energy: 90, worthIt: 5, verified: true });
  });
});

describe("POST /api/events/:id/vibe/report", () => {
  it("requires a session", async () => {
    const h = await login(t, "host@x.com", "Host");
    const id = await hostEvent(h.cookie);
    expect((await call(t, `/api/events/${id}/vibe/report`, { method: "POST", body: SLIDERS })).status).toBe(401);
  });

  it("rejects out-of-range sliders at the door", async () => {
    const h = await login(t, "host@x.com", "Host");
    const g = await login(t, "goer@x.com", "Goer");
    const id = await hostEvent(h.cookie);
    await checkIn(h.cookie, g.cookie, id);
    const bad = await call(t, `/api/events/${id}/vibe/report`, { method: "POST", cookie: g.cookie, body: { ...SLIDERS, energy: 500 } });
    expect(bad.status).toBe(400);
    const bad2 = await call(t, `/api/events/${id}/vibe/report`, { method: "POST", cookie: g.cookie, body: { ...SLIDERS, worthIt: 9 } });
    expect(bad2.status).toBe(400);
  });

  it("404s an unknown event", async () => {
    const { cookie } = await login(t, "goer@x.com", "Goer");
    expect((await call(t, "/api/events/ghost/vibe/report", { method: "POST", cookie, body: SLIDERS })).status).toBe(404);
  });

  it("accepts an unverified report but says so, and does NOT move the card or pay points", async () => {
    const h = await login(t, "host@x.com", "Host");
    const drive = await login(t, "drive@x.com", "DriveBy");
    const id = await hostEvent(h.cookie);
    const before = (await call(t, `/api/events/${id}/vibe`)).json.vibe;

    const r = await call(t, `/api/events/${id}/vibe/report`, { method: "POST", cookie: drive.cookie, body: SLIDERS });
    expect(r.status).toBe(200);
    expect(r.json.verified).toBe(false);
    expect(r.json.vibe.axes).toEqual(before.axes);
    expect(r.json.vibe.nReports).toBe(0);
    // no check-in, no points — otherwise the ledger is farmable from a laptop
    expect((await call(t, "/api/me/achievements", { cookie: drive.cookie })).json.points).toEqual([]);
  });

  it("pays a verified reporter exactly once, no matter how many times they resubmit", async () => {
    const h = await login(t, "host@x.com", "Host");
    const g = await login(t, "goer@x.com", "Goer");
    const id = await hostEvent(h.cookie);
    await checkIn(h.cookie, g.cookie, id);

    for (let i = 0; i < 3; i++) {
      const r = await call(t, `/api/events/${id}/vibe/report`, { method: "POST", cookie: g.cookie, body: SLIDERS });
      expect(r.status).toBe(200);
      expect(r.json.verified).toBe(true);
    }
    const pts = (await call(t, "/api/me/achievements", { cookie: g.cookie })).json.points;
    const row = pts.find((p: any) => p.kind === "vibe_report");
    expect(row).toBeTruthy();
    expect(row.points).toBe(POINTS.vibe_report); // the dedup_key makes double-award impossible
    expect(row.count).toBe(1);
    // and it's still one report, not three votes
    expect((await call(t, `/api/events/${id}/vibe`)).json.vibe.nReports).toBe(1);
  });
});

describe("GET /api/me/vibe-prompts — the collection loop", () => {
  it("lists the rooms you attended and owe a read on, then clears them", async () => {
    const h = await login(t, "host@x.com", "Host");
    const g = await login(t, "goer@x.com", "Goer");
    const e1 = await hostEvent(h.cookie, "Night One");
    const e2 = await hostEvent(h.cookie, "Night Two");
    await checkIn(h.cookie, g.cookie, e1);
    await checkIn(h.cookie, g.cookie, e2);

    const open = await call(t, "/api/me/vibe-prompts", { cookie: g.cookie });
    expect(open.status).toBe(200);
    expect(open.json.pending.map((p: any) => p.eventId).sort()).toEqual([e1, e2].sort());
    expect(open.json.pending[0].title).toBeTruthy();

    await call(t, `/api/events/${e1}/vibe/report`, { method: "POST", cookie: g.cookie, body: SLIDERS });
    expect((await call(t, "/api/me/vibe-prompts", { cookie: g.cookie })).json.pending.map((p: any) => p.eventId)).toEqual([e2]);
  });

  it("requires a session", async () => {
    expect((await call(t, "/api/me/vibe-prompts")).status).toBe(401);
  });
});

describe("GET /api/vibes — range filters + best-for tags (what search consumes)", () => {
  it("filters by axis range and by tag, and caps the page size", async () => {
    const h = await login(t, "host@x.com", "Host");
    const loud = await hostEvent(h.cookie, "Launch Party");
    const calm = await hostEvent(h.cookie, "Founders Dinner");
    // materialise both cards
    await call(t, `/api/events/${loud}/vibe`);
    await call(t, `/api/events/${calm}/vibe`);

    const energetic = await call(t, "/api/vibes?energyMin=80");
    expect(energetic.status).toBe(200);
    const ids = energetic.json.vibes.map((v: any) => v.eventId);
    expect(ids).toContain(loud);
    expect(ids).not.toContain(calm);

    const intimate = await call(t, "/api/vibes?intimacyMin=70");
    expect(intimate.json.vibes.map((v: any) => v.eventId)).toContain(calm);

    const tagged = await call(t, "/api/vibes?bestFor=real%20conversations");
    expect(tagged.json.vibes.map((v: any) => v.eventId)).toContain(calm);

    expect((await call(t, "/api/vibes?limit=99999")).json.vibes.length).toBeLessThanOrEqual(200);
  });

  it("ignores junk filter values instead of 500ing", async () => {
    const r = await call(t, "/api/vibes?energyMin=banana&signalMax=&limit=-3");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.vibes)).toBe(true);
  });
});

describe("POST /api/admin/vibes/enrich (bearer-gated)", () => {
  it("401s without the token", async () => {
    const t2 = makeTestApp({ INGEST_TOKEN: "secret" });
    expect((await call(t2, "/api/admin/vibes/enrich", { method: "POST", body: {} })).status).toBe(401);
  });

  it("nudge: 401s without the token, 503s when web push isn't configured", async () => {
    const t2 = makeTestApp({ INGEST_TOKEN: "secret" });
    expect((await call(t2, "/api/admin/vibes/nudge", { method: "POST", body: {} })).status).toBe(401);
    const noVapid = await call(t2, "/api/admin/vibes/nudge", { method: "POST", body: {}, headers: { authorization: "Bearer secret" } });
    expect(noVapid.status).toBe(503);
  });

  it("backfills cards deterministically when no model is configured", async () => {
    t = makeTestApp({ INGEST_TOKEN: "secret" });
    const h = await login(t, "host@x.com", "Host");
    const id = await hostEvent(h.cookie);
    const r = await call(t, "/api/admin/vibes/enrich", {
      method: "POST", body: { limit: 10 }, headers: { authorization: "Bearer secret" },
    });
    expect(r.status).toBe(200);
    expect(r.json.enriched).toBeGreaterThanOrEqual(1);
    const v = (await call(t, `/api/events/${id}/vibe`)).json.vibe;
    expect(v.model).toBeNull();
    expect(v.headline).toBeTruthy();
  });
});
