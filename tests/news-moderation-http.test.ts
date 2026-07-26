/**
 * Moderation through the real Worker.
 *
 * The load-bearing assertions are the ones that protect the policy: flags never
 * hide, the queue is invisible to non-admins, a ban stops writing but not
 * reading, and every action leaves an audit row.
 */
import { describe, it, expect, beforeEach } from "vitest";
import newsWorker from "../src/worker/news";
import { makeTestEnv } from "./helpers/app";
import { NewsRepo } from "../src/storage/d1/news-repo";
import { ModerationRepo } from "../src/storage/d1/moderation-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";

const SF = { lat: 37.7749, lng: -122.4194 };

describe("moderation over HTTP", () => {
  let env: any, repo: NewsRepo, mod: ModerationRepo, social: SocialRepo;
  let storyId: string, adminCookie: string, userCookie: string, userId: string;

  const req = (p: string, init: RequestInit = {}) =>
    newsWorker.fetch(new Request("https://thebay.news" + p, init), env, {} as any);
  const json = (p: string, body: any, cookie?: string) =>
    req(p, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const form = (p: string, body: Record<string, string>, cookie?: string) =>
    req(p, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body).toString() });

  async function signIn(email: string, name: string) {
    const r = await json("/auth/dev", { email, name });
    return (r.headers.get("set-cookie") || "").split(";")[0]!;
  }

  beforeEach(async () => {
    // "mod" is the admin; ADMIN_HANDLES is config, never a DB column.
    ({ env } = makeTestEnv({ NEWS_ORIGIN: "https://thebay.news", PUBLIC_ORIGIN: "https://thebay.events", ADMIN_HANDLES: "mod" }));
    repo = new NewsRepo(env.DB);
    mod = new ModerationRepo(env.DB);
    social = new SocialRepo(env.DB);

    const author = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "Author" });
    ({ id: storyId } = await repo.submit(author.id, { kind: "link", title: "A story", url: "https://ex.com/a" } as any));

    adminCookie = await signIn("mod@x.com", "Mod");
    await env.DB.prepare("UPDATE users SET handle = 'mod' WHERE email = 'mod@x.com'").run();
    userCookie = await signIn("reader@x.com", "Reader");
    userId = (await env.DB.prepare("SELECT id FROM users WHERE email='reader@x.com'").first()).id;
    await json("/api/news/attest", SF, userCookie);
  });

  // ── the policy ─────────────────────────────────────────────────────────────

  it("flags NEVER hide anything, at any count", async () => {
    // Ten different people flag the same story.
    for (let i = 0; i < 10; i++) {
      const u = await social.upsertByIdentity({ provider: "dev", providerUid: `f${i}@x.com`, email: `f${i}@x.com`, displayName: `F${i}` });
      await mod.flag("story", storyId, u.id, "spam");
    }
    expect(await mod.flagCount("story", storyId)).toBe(10);

    // …and it is still visible, still in the feed, still not dead.
    const story = await repo.getStory(storyId);
    expect(story).not.toBeNull();
    expect((await repo.feed({ src: "all", sort: "new", limit: 10, offset: 0 })).stories.map((s) => s.id)).toContain(storyId);
    const page = await req(`/item/${storyId}`);
    expect([200, 301]).toContain(page.status);
  });

  it("does not report a flag count back to the flagger", async () => {
    const res = await json("/api/news/flag", { targetType: "story", targetId: storyId, reason: "spam" }, userCookie);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.total).toBeUndefined(); // a visible count invites pile-ons
  });

  it("flagging is idempotent — one person, one flag", async () => {
    // Asserted at the repo, because over HTTP the second call is refused by the
    // flag cooldown first (which is itself correct, and covered below).
    await mod.flag("story", storyId, userId, "spam");
    const again = await mod.flag("story", storyId, userId, "abuse");
    expect(again.counted).toBe(false);
    expect(await mod.flagCount("story", storyId)).toBe(1);
  });

  it("rate-limits flagging, so it can't be used to brigade", async () => {
    const first = await json("/api/news/flag", { targetType: "story", targetId: storyId, reason: "spam" }, userCookie);
    expect(first.status).toBe(200);
    const other = await repo.submit(userId, { kind: "link", title: "Other", url: "https://ex.com/other" } as any);
    const rapid = await json("/api/news/flag", { targetType: "story", targetId: other.id, reason: "spam" }, userCookie);
    expect(rapid.status).toBe(429);
  });

  it("flagging requires auth and Bay presence, like any other write", async () => {
    expect((await json("/api/news/flag", { targetType: "story", targetId: storyId })).status).toBe(401);
    const outsider = await signIn("out@x.com", "Out");
    expect((await json("/api/news/flag", { targetType: "story", targetId: storyId }, outsider)).status).toBe(403);
  });

  // ── the queue ──────────────────────────────────────────────────────────────

  it("hides the moderation queue from everyone but admins — as a 404", async () => {
    expect((await req("/moderation")).status).toBe(404);                    // anonymous
    expect((await req("/moderation", { headers: { cookie: userCookie } })).status).toBe(404); // signed in, not admin
    expect((await req("/moderation", { headers: { cookie: adminCookie } })).status).toBe(200);
  });

  it("refuses moderation actions from non-admins", async () => {
    const before = (await repo.getStory(storyId))!;
    const res = await form("/moderation/act", { action: "hide", targetType: "story", targetId: storyId }, userCookie);
    expect(res.status).toBe(404);
    expect(await repo.getStory(storyId)).not.toBeNull(); // untouched
    expect(before.id).toBe(storyId);
  });

  it("lets an admin hide and then unhide, reversibly", async () => {
    await form("/moderation/act", { action: "hide", targetType: "story", targetId: storyId }, adminCookie);
    expect(await repo.getStory(storyId)).toBeNull(); // hidden from readers

    await form("/moderation/act", { action: "unhide", targetType: "story", targetId: storyId }, adminCookie);
    expect(await repo.getStory(storyId)).not.toBeNull(); // and back
  });

  it("writes an audit row for every action, attributed and ordered", async () => {
    await form("/moderation/act", { action: "hide", targetType: "story", targetId: storyId }, adminCookie);
    await form("/moderation/act", { action: "unhide", targetType: "story", targetId: storyId }, adminCookie);
    const log = await mod.actionLog();
    expect(log.map((a) => a.action)).toEqual(["unhide", "hide"]); // newest first
    expect(log.every((a) => a.actor === "mod")).toBe(true);
  });

  it("surfaces flagged items in the queue, most-flagged first", async () => {
    const other = await repo.submit(userId, { kind: "link", title: "Second", url: "https://ex.com/b" } as any);
    await mod.flag("story", other.id, userId, "spam");
    for (let i = 0; i < 3; i++) {
      const u = await social.upsertByIdentity({ provider: "dev", providerUid: `q${i}@x.com`, email: `q${i}@x.com`, displayName: `Q${i}` });
      await mod.flag("story", storyId, u.id, "abuse");
    }
    const q = await mod.queue();
    expect(q[0]!.targetId).toBe(storyId);
    expect(q[0]!.flagCount).toBe(3);
    expect(q.map((x) => x.targetId)).toContain(other.id);
  });

  it("shows a reviewer WHO flagged, so a pile-on is visible", async () => {
    await mod.flag("story", storyId, userId, "spam");
    const who = await mod.flaggers("story", storyId);
    expect(who).toHaveLength(1);
    expect(who[0]!.reason).toBe("spam");
  });

  // ── bans ───────────────────────────────────────────────────────────────────

  it("a ban blocks writing but never reading, and leaves old content up", async () => {
    const mine = await repo.submit(userId, { kind: "link", title: "Mine", url: "https://ex.com/mine" } as any);
    const adminId = (await env.DB.prepare("SELECT id FROM users WHERE handle='mod'").first()).id;
    await mod.ban(userId, adminId, "spam flood");

    // Writing is refused…
    const vote = await json("/api/news/vote", { storyId }, userCookie);
    expect(vote.status).toBe(403);
    expect((await vote.json() as any).error).toBe("banned");

    // …reading is not…
    expect((await req("/", { headers: { cookie: userCookie } })).status).toBe(200);
    // …and their existing story is still up, still theirs.
    const still = await repo.getStory(mine.id);
    expect(still).not.toBeNull();
    expect(still!.author).toBe("Reader");
  });

  it("a ban is reversible", async () => {
    const adminId = (await env.DB.prepare("SELECT id FROM users WHERE handle='mod'").first()).id;
    await mod.ban(userId, adminId);
    expect(await mod.isBanned(userId)).toBe(true);
    await mod.unban(userId, adminId);
    expect(await mod.isBanned(userId)).toBe(false);
    expect((await json("/api/news/vote", { storyId }, userCookie)).status).toBe(200);
  });

  // ── domains ────────────────────────────────────────────────────────────────

  it("blocking a domain hides its existing stories and logs the decision", async () => {
    const adminId = (await env.DB.prepare("SELECT id FROM users WHERE handle='mod'").first()).id;
    const hidden = await mod.blockDomain("ex.com", adminId, "spam farm");
    expect(hidden).toBeGreaterThan(0);
    expect(await repo.getStory(storyId)).toBeNull();
    expect(await mod.blockedDomains()).toContain("ex.com");
    expect((await mod.actionLog()).some((a) => a.action === "block_domain")).toBe(true);
  });

  // ── cooldown ───────────────────────────────────────────────────────────────

  it("enforces a cooldown between comments, with a specific wait", async () => {
    const first = await form(`/item/${storyId}/comment`, { body: "First comment here." }, userCookie);
    expect(first.status).toBe(303);
    const second = await form(`/item/${storyId}/comment`, { body: "Immediately after." }, userCookie);
    expect(second.status).toBe(429);
    const body: any = await second.json();
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.message).toMatch(/again in/);
    expect(second.headers.get("retry-after")).toBeTruthy();
  });
});
