import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { D1Repo } from "../src/storage/d1/d1-repo";

let d1: any;
let raw: Database.Database;
let repo: D1Repo;

beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  repo = new D1Repo(d1);
});

function insertEvent(id: string, startUtc: string) {
  raw
    .prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, content_hash, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'sf-bay', 'https://x', ?, '2026-01-01', '2026-01-01')`,
    )
    .run(id, "fp-" + id, "Event " + id, startUtc, "ch-" + id);
}

describe("scrape observability — recordRun + scrapeStatus", () => {
  it("records a run and reports last-run counts, per-source breakdown, totals, and freshness", async () => {
    insertEvent("future", "2099-01-01T00:00:00Z"); // upcoming
    insertEvent("past", "2020-01-01T00:00:00Z");   // already happened

    const runId = await repo.recordRun({
      startedAt: "2026-07-25T07:00:00.000Z",
      finishedAt: "2026-07-25T07:05:00.000Z",
      trigger: "scrape+push",
      eventsNew: 12,
      eventsUpdated: 3,
      sources: [
        { sourceId: "luma", status: "ok", rawCount: 40, durationMs: 1200 },
        { sourceId: "eventbrite", status: "error", error: "HTTP 429" },
      ],
    });
    expect(runId).toBeTruthy();

    const s = await repo.scrapeStatus({ now: new Date("2026-07-25T07:10:00Z"), staleHours: 26 });
    expect(s.lastRunAt).toBe("2026-07-25T07:00:00.000Z");
    expect(s.stale).toBe(false);
    expect(s.ageHours).toBeCloseTo(0.17, 1);
    expect(s.totalEvents).toBe(2);
    expect(s.upcomingEvents).toBe(1); // only the future one counts as usable
    expect(s.lastRun?.eventsNew).toBe(12);
    expect(s.lastRun?.eventsUpdated).toBe(3);
    expect(s.lastRun?.okSources).toBe(1);
    expect(s.lastRun?.failedSources).toBe(1);
    expect(s.lastRun?.sources.find((x) => x.sourceId === "luma")?.rawCount).toBe(40);
    expect(s.lastRun?.sources.find((x) => x.sourceId === "eventbrite")?.status).toBe("error");

    // listRuns now sees it too (prod /api/runs stops being empty)
    expect((await repo.listRuns(5)).length).toBe(1);
  });

  it("reports stale when never run, and stale when the last run is older than the threshold", async () => {
    const never = await repo.scrapeStatus({ now: new Date("2026-07-25T00:00:00Z"), staleHours: 26 });
    expect(never.lastRunAt).toBeNull();
    expect(never.lastRun).toBeNull();
    expect(never.stale).toBe(true); // never scraped ⇒ definitely stale
    expect(never.ageHours).toBeNull();

    await repo.recordRun({ startedAt: "2026-07-01T00:00:00.000Z", finishedAt: "2026-07-01T00:05:00.000Z", trigger: "scrape", eventsNew: 5, eventsUpdated: 0 });
    const old = await repo.scrapeStatus({ now: new Date("2026-07-25T00:00:00Z"), staleHours: 26 });
    expect(old.stale).toBe(true);
    expect(old.ageHours!).toBeGreaterThan(26);

    // a fresh run clears staleness
    await repo.recordRun({ startedAt: "2026-07-24T23:30:00.000Z", finishedAt: "2026-07-24T23:35:00.000Z", trigger: "scrape", eventsNew: 1, eventsUpdated: 1 });
    const fresh = await repo.scrapeStatus({ now: new Date("2026-07-25T00:00:00Z"), staleHours: 26 });
    expect(fresh.stale).toBe(false);
    expect(fresh.lastRun?.trigger).toBe("scrape");
  });
});
