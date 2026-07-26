import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "./helpers/d1";
import { D1Repo } from "../src/storage/d1/d1-repo";
import { tagPending } from "../src/pipeline/pipeline";
import { loadCategories } from "../src/config/load";

let d1: any, raw: Database.Database, repo: D1Repo;
beforeEach(() => {
  ({ d1, raw } = makeTestDb());
  repo = new D1Repo(d1);
});

// far-future so eventsNeedingTags (which only tags upcoming) always picks them up
function seed(id: string, title: string, opts: { tagged?: boolean } = {}) {
  raw
    .prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, categories, content_hash, tag_source, tagged_hash, first_seen_at, last_seen_at, hidden)
       VALUES (?, ?, ?, '2099-08-01T18:00:00Z', 'America/Los_Angeles', 'sf-bay', ?, '[]', ?, ?, ?, '2026-07-01', '2026-07-01', 0)`,
    )
    .run(id, "fp-" + id, title, "https://x/" + id, "ch-" + id, opts.tagged ? "keyword" : null, opts.tagged ? "ch-" + id : null);
}

describe("pipeline tagPending — selects pending events, tags them, persists (the tag stage end-to-end)", () => {
  it("tags every pending event with the right categories and leaves already-tagged ones alone", async () => {
    seed("hw", "Hardware Robotics & FPGA Night");
    seed("vc", "Meet local angel investors");
    seed("done", "Already Tagged Coffee", { tagged: true }); // tagged_hash == content_hash → skipped

    const n = await tagPending({ repo, categories: loadCategories() });
    expect(n).toBe(2); // only the two pending events

    const cats = (id: string) => JSON.parse((raw.prepare("SELECT categories FROM events WHERE id=?").get(id) as any).categories);
    expect(cats("hw")).toContain("hardware");
    expect(cats("vc")).toContain("vc");
    expect(cats("done")).toEqual([]); // untouched — was already tagged

    // tag_source + tagged_hash are stamped so a re-run tags nothing new (idempotent)
    const row = raw.prepare("SELECT tag_source, tagged_hash, content_hash FROM events WHERE id='hw'").get() as any;
    expect(row.tag_source).toBe("keyword");
    expect(row.tagged_hash).toBe(row.content_hash);
    expect(await tagPending({ repo, categories: loadCategories() })).toBe(0);
  });
});
