/**
 * The trophy read surface. The point of this endpoint is that it returns the WHOLE
 * catalog — earned, locked and in-progress — so the client stops carrying a
 * hard-coded trophy table and can never again promise a trophy no server code grants.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { TROPHIES } from "../src/core/trophies/catalog";

let t: TestApp;
beforeEach(() => {
  t = makeTestApp();
});

function mkEvent(id: string, hostId: string | null = null) {
  t.raw
    .prepare(
      `INSERT INTO events (id, fingerprint, title, start_utc, timezone, city, url, categories,
                           content_hash, host_user_id, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'America/Los_Angeles', 'sf-bay', ?, '[]', ?, ?, ?, ?)`,
    )
    .run(id, `fp-${id}`, `Event ${id}`, "2026-07-01T18:00:00Z", `https://x/${id}`, `ch-${id}`, hostId, "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
}

describe("GET /api/trophies", () => {
  it("401s anonymously", async () => {
    const r = await call(t, "/api/trophies");
    expect(r.status).toBe(401);
  });

  it("returns the whole catalog with nothing earned for a new account", async () => {
    const { cookie } = await login(t);
    const r = await call(t, "/api/trophies", { cookie });
    expect(r.status).toBe(200);
    expect(r.json.progress.length).toBe(TROPHIES.length);
    expect(r.json.earnedCount).toBe(0);
    expect(r.json.total).toBe(TROPHIES.length);
    // Locked rungs carry the numbers a progress bar needs.
    const first = r.json.progress[0];
    expect(first).toHaveProperty("threshold");
    expect(first).toHaveProperty("pct");
    expect(first).toHaveProperty("remaining");
    expect(first).toHaveProperty("rarity");
    expect(first).toHaveProperty("icon");
    expect(first).toHaveProperty("name");
  });

  it("reconciles on read: earning a trophy grants it and reports it as just unlocked", async () => {
    const { cookie, user } = await login(t);
    mkEvent("e1");
    t.raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?,?,?,'qr')").run(user.id, "e1", "2026-07-01T19:00:00Z");

    const r = await call(t, "/api/trophies", { cookie });
    expect(r.status).toBe(200);
    expect(r.json.justUnlocked).toContain("first_checkin");
    const row = r.json.progress.find((p: any) => p.id === "first_checkin");
    expect(row.earned).toBe(true);
    expect(row.awardedAt).toBeTruthy();

    // Second read is stable — no re-grant, nothing "just" unlocked any more.
    const again = await call(t, "/api/trophies", { cookie });
    expect(again.json.justUnlocked).toEqual([]);
    expect(again.json.earnedCount).toBe(1);
  });

  it("pays trophy XP into the level track, visible through /api/me/xp", async () => {
    const { cookie, user } = await login(t);
    mkEvent("e1");
    t.raw.prepare("INSERT INTO checkins (user_id, event_id, at, source) VALUES (?,?,?,'qr')").run(user.id, "e1", "t");

    await call(t, "/api/trophies", { cookie });
    const xp = await call(t, "/api/me/xp", { cookie });
    expect(xp.status).toBe(200);
    expect(xp.json.xp).toBeGreaterThan(0);
    expect(xp.json.breakdown.some((b: any) => b.kind === "trophy")).toBe(true);
  });

  it("blanks out an unearned secret so it reads as a mystery slot", async () => {
    const { cookie } = await login(t);
    const r = await call(t, "/api/trophies", { cookie });
    const ghost = r.json.progress.find((p: any) => p.id === "ghost");
    expect(ghost.hidden).toBe(true);
    // Its name and flavor must NOT be shipped while hidden, or the secret is only
    // secret to someone who doesn't open devtools.
    expect(ghost.name).toBeNull();
    expect(ghost.flavor).toBeNull();
    expect(ghost.icon).toBeNull();
  });

  it("never suggests a secret in nextUp", async () => {
    const { cookie } = await login(t);
    const r = await call(t, "/api/trophies", { cookie });
    for (const n of r.json.nextUp) expect(n.hidden).toBe(false);
    expect(r.json.nextUp.length).toBeLessThanOrEqual(3);
  });
});

describe("POST /api/trophies/sync", () => {
  it("401s anonymously and reconciles for a signed-in user", async () => {
    expect((await call(t, "/api/trophies/sync", { method: "POST" })).status).toBe(401);

    const { cookie, user } = await login(t);
    mkEvent("e1", user.id);
    const r = await call(t, "/api/trophies/sync", { method: "POST", cookie });
    expect(r.status).toBe(200);
    expect(r.json.granted).toContain("first_host");
    expect(r.json.xp).toBeGreaterThan(0);
  });
});
