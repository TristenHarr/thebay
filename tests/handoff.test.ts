/**
 * Cross-domain sign-in handoff. This mints something that grants a session, so
 * the tests are adversarial: replay, expiry, wrong host, open redirect, and
 * forced navigation (login CSRF / session fixation).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mintHandoff, claimHandoff, safeNextPath, isTopLevelNavigation } from "../src/auth/handoff";
import { makeTestEnv } from "./helpers/app";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { authRoutes } from "../src/worker/routes/auth";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const NEWS = "thebay.news";

describe("safeNextPath", () => {
  it("keeps ordinary site-relative paths", () => {
    expect(safeNextPath("/submit")).toBe("/submit");
    expect(safeNextPath("/item/abc/some-slug?x=1")).toBe("/item/abc/some-slug?x=1");
  });

  it("refuses anything that could leave the site", () => {
    for (const bad of [
      "//evil.com", "https://evil.com", "http://evil.com/x", "javascript:alert(1)",
      "/\\evil.com", "\\\\evil.com", "", null, undefined, "relative/path",
    ]) {
      expect(safeNextPath(bad)).toBe("/");
    }
  });

  it("bounds the length", () => {
    expect(safeNextPath("/" + "a".repeat(1000)).length).toBeLessThanOrEqual(300);
  });
});

describe("isTopLevelNavigation", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("accepts a real navigation", () => {
    expect(isTopLevelNavigation(h({ "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" }))).toBe(true);
  });
  it("rejects subresource and script-initiated loads", () => {
    expect(isTopLevelNavigation(h({ "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors" }))).toBe(false);
    expect(isTopLevelNavigation(h({ "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }))).toBe(false);
    // A positive tell in EITHER header is enough to reject.
    expect(isTopLevelNavigation(h({ "sec-fetch-dest": "image" }))).toBe(false);
    expect(isTopLevelNavigation(h({ "sec-fetch-mode": "cors" }))).toBe(false);
  });
  it("allows clients that send no fetch-metadata at all", () => {
    expect(isTopLevelNavigation(h({}))).toBe(true);
  });
  it("allows PARTIAL metadata, so ordinary HTTP clients can still sign in", () => {
    // Requiring both headers locked out real users: curl sends neither, and some
    // stacks send mode without dest. Neither is an attack.
    expect(isTopLevelNavigation(h({ "sec-fetch-mode": "navigate" }))).toBe(true);
    expect(isTopLevelNavigation(h({ "sec-fetch-dest": "document" }))).toBe(true);
  });
});

describe("handoff DIRECTION (which site /start sends you to)", () => {
  // The bug this guards: linking the events app's "news" button at
  // thebay.news/auth/handoff/start. /start always hands off to the SIBLING of the
  // host it runs on, so calling it on the news host sends you back to events —
  // the button appeared to do nothing but return you to the events homepage.
  const app = authRoutes();
  const env = () => makeTestEnv({ NEWS_ORIGIN: "https://thebay.news", PUBLIC_ORIGIN: "https://thebay.events" }).env;
  const start = (host: string, qs = "?next=%2F") =>
    app.fetch(new Request(`https://${host}/auth/handoff/start${qs}`), env());

  it("sends an events visitor TO thebay.news", async () => {
    const res = await start("thebay.events");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/thebay\.news\//);
  });

  it("sends a news visitor TO thebay.events", async () => {
    const res = await start("thebay.news", "?next=%2Fapp");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/thebay\.events\/app/);
  });

  it("never returns a visitor to the host they started on", async () => {
    for (const host of ["thebay.events", "thebay.news"]) {
      const loc = (await start(host)).headers.get("location")!;
      expect(new URL(loc).host).not.toBe(host);
    }
  });

  it("carries the reader's theme across the domain boundary", async () => {
    const loc = (await start("thebay.events", "?next=%2F&theme=light")).headers.get("location")!;
    expect(loc).toContain("theme=light");
    // …and ignores anything that isn't a real theme.
    const junk = (await start("thebay.events", "?next=%2F&theme=<script>")).headers.get("location")!;
    expect(junk).not.toContain("script");
  });
});

describe("handoff tokens", () => {
  let env: any, user: any;

  beforeEach(async () => {
    ({ env } = makeTestEnv());
    user = await new SocialRepo(env.DB).upsertByIdentity({
      provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "Ann",
    });
  });

  it("round-trips once and carries the destination", async () => {
    const t = await mintHandoff(env, user.id, NEWS, "/submit", NOW);
    const claim = await claimHandoff(env, t, NEWS, NOW + 1000);
    expect(claim).toEqual({ userId: user.id, nextPath: "/submit" });
  });

  it("cannot be replayed", async () => {
    const t = await mintHandoff(env, user.id, NEWS, "/", NOW);
    expect(await claimHandoff(env, t, NEWS, NOW + 1000)).not.toBeNull();
    expect(await claimHandoff(env, t, NEWS, NOW + 1000)).toBeNull();
  });

  it("expires after 30 seconds", async () => {
    const t = await mintHandoff(env, user.id, NEWS, "/", NOW);
    expect(await claimHandoff(env, t, NEWS, NOW + 31_000)).toBeNull();
  });

  it("is bound to the host it was minted for", async () => {
    const t = await mintHandoff(env, user.id, NEWS, "/", NOW);
    expect(await claimHandoff(env, t, "evil.com", NOW + 1000)).toBeNull();
    // …and is still unusable afterwards at the right host, since it wasn't claimed.
    expect(await claimHandoff(env, t, NEWS, NOW + 1000)).not.toBeNull();
  });

  it("rejects unknown and empty tokens", async () => {
    expect(await claimHandoff(env, "nope", NEWS, NOW)).toBeNull();
    expect(await claimHandoff(env, "", NEWS, NOW)).toBeNull();
  });

  it("stores the token hashed, never in the clear", async () => {
    const t = await mintHandoff(env, user.id, NEWS, "/", NOW);
    const row: any = await env.DB.prepare("SELECT token_hash FROM handoff_tokens").first();
    expect(row.token_hash).not.toBe(t);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sanitizes the destination at mint time, so a bad next can't be stored", async () => {
    const t = await mintHandoff(env, user.id, NEWS, "https://evil.com/steal", NOW);
    expect((await claimHandoff(env, t, NEWS, NOW + 1000))!.nextPath).toBe("/");
  });

  it("does not let two concurrent redemptions both succeed", async () => {
    const t = await mintHandoff(env, user.id, NEWS, "/", NOW);
    const [a, b] = await Promise.all([
      claimHandoff(env, t, NEWS, NOW + 100),
      claimHandoff(env, t, NEWS, NOW + 100),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});
