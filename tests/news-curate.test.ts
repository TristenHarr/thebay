/**
 * The front page's editorial policy.
 *
 * This decides what a first-time visitor thinks the site is for, so the rules
 * are asserted directly rather than inferred from a rendered page.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { curateFrontPage, qualifies, quotaFor, QUOTA, QUALITY_BAR, LOCAL, SUBMISSION } from "../src/news/curate";
import { NewsRepo } from "../src/storage/d1/news-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { makeTestDb } from "./helpers/d1";

const s = (id: string, origin: any, externalPoints?: number) => ({ id, origin, externalPoints });

describe("curateFrontPage", () => {
  it("puts human submissions first, always, and never trims them for borrowed content", () => {
    const subs = [s("mine1", "bay"), s("mine2", "bay")];
    const rest = [s("hn1", "hn", 900), s("ev1", "event")];
    expect(curateFrontPage(subs, rest, 10).slice(0, 2).map((x) => x.id)).toEqual(["mine1", "mine2"]);
  });

  it("fills a page that would otherwise be all events with a real MIX", () => {
    // The actual production state: 140 events, 0 submissions. Unmixed, the front
    // page was a calendar.
    const events = Array.from({ length: 140 }, (_, i) => s(`ev${i}`, "event"));
    const rest = [
      ...events,
      ...Array.from({ length: 20 }, (_, i) => s(`hn${i}`, "hn", 500)),
      ...Array.from({ length: 20 }, (_, i) => s(`rss${i}`, "rss")),
      ...Array.from({ length: 10 }, (_, i) => s(`gh${i}`, "github", 300)),
      ...Array.from({ length: 10 }, (_, i) => s(`sec${i}`, "sec")),
      ...Array.from({ length: 10 }, (_, i) => s(`lo${i}`, "lobsters", 60)),
    ];
    const page = curateFrontPage([], rest, 30);
    expect(page).toHaveLength(30);

    const byOrigin = page.reduce<Record<string, number>>((m, x) => ({ ...m, [x.origin]: (m[x.origin] ?? 0) + 1 }), {});
    // Every source represented — that's the point.
    for (const o of ["event", "hn", "rss", "github", "sec", "lobsters"]) {
      expect(byOrigin[o], `expected some ${o}`).toBeGreaterThan(0);
    }
    // …and no single source owns the page.
    expect(Math.max(...Object.values(byOrigin))).toBeLessThan(15);
  });

  it("squeezes borrowed content out as real submissions arrive", () => {
    const rest = Array.from({ length: 50 }, (_, i) => s(`hn${i}`, "hn", 500));
    const withNone = curateFrontPage([], rest, 10).filter((x) => x.origin !== SUBMISSION).length;
    const withSome = curateFrontPage(
      Array.from({ length: 6 }, (_, i) => s(`mine${i}`, "bay")), rest, 10,
    ).filter((x) => x.origin !== SUBMISSION).length;
    expect(withSome).toBeLessThan(withNone);
  });

  it("becomes entirely ours once there are enough submissions", () => {
    const subs = Array.from({ length: 30 }, (_, i) => s(`mine${i}`, "bay"));
    const page = curateFrontPage(subs, [s("hn1", "hn", 9000)], 10);
    expect(page.every((x) => x.origin === "bay")).toBe(true);
  });

  it("keeps low-signal aggregated content off the front page", () => {
    const page = curateFrontPage([], [s("weak", "hn", 3), s("strong", "hn", 500)], 10);
    expect(page.map((x) => x.id)).toEqual(["strong"]);
  });

  it("treats Bay-local sources as ours — including SEC filings", () => {
    expect(LOCAL).toContain("sec");
    expect(qualifies(s("f", "sec"))).toBe(true);   // a Form D is a Bay company raising
    expect(qualifies(s("e", "event"))).toBe(true);
  });

  it("calibrates the bar per source rather than using one global number", () => {
    expect(qualifies(s("l", "lobsters", 20))).toBe(true);  // strong for Lobsters…
    expect(qualifies(s("h", "hn", 20))).toBe(false);       // …weak for HN
    expect(QUALITY_BAR.hn).toBeGreaterThan(QUALITY_BAR.lobsters!);
  });

  it("refuses a source it doesn't know", () => {
    expect(qualifies({ id: "x", origin: "martian" as any })).toBe(false);
  });

  it("backfills so a quiet source never leaves the page short", () => {
    // Only one source has anything today; the page should still fill up.
    const rest = Array.from({ length: 40 }, (_, i) => s(`hn${i}`, "hn", 500));
    expect(curateFrontPage([], rest, 25)).toHaveLength(25);
  });

  it("never returns more than the limit", () => {
    const rest = Array.from({ length: 200 }, (_, i) => s(`x${i}`, "rss"));
    expect(curateFrontPage([], rest, 12)).toHaveLength(12);
  });

  it("gives every source a nonzero quota", () => {
    for (const [origin, share] of Object.entries(QUOTA)) {
      expect(quotaFor(origin as any, 30), origin).toBeGreaterThan(0);
      expect(share).toBeGreaterThan(0);
    }
  });
});

describe("the front page through the repo", () => {
  let d1: any, repo: NewsRepo, social: SocialRepo;
  beforeEach(async () => {
    ({ d1 } = makeTestDb());
    repo = new NewsRepo(d1);
    social = new SocialRepo(d1);
  });

  const addStory = async (id: string, origin: string, points: number | null, title: string) => {
    await d1.prepare(
      `INSERT INTO stories (id,kind,title,url,url_hash,slug,origin,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(id, "link", title, `https://ex.com/${id}`, `h-${id}`, id, origin, new Date().toISOString()).run();
    await d1.prepare(
      `INSERT INTO story_sources (story_id,origin,external_id,external_points,fetched_at) VALUES (?,?,?,?,?)`,
    ).bind(id, origin, `e-${id}`, points, new Date().toISOString()).run();
  };

  it("mixes sources on the default view instead of showing only events", async () => {
    for (let i = 0; i < 30; i++) await addStory(`ev${i}`, "event", null, `Bay event ${i}`);
    for (let i = 0; i < 10; i++) await addStory(`hn${i}`, "hn", 400, `HN story ${i}`);
    for (let i = 0; i < 5; i++) await addStory(`gh${i}`, "github", 300, `repo/${i}`);
    for (let i = 0; i < 5; i++) await addStory(`sec${i}`, "sec", null, `Acme ${i} filed a Form D`);

    const { stories } = await repo.feed({ src: "bay", sort: "hot", limit: 20, offset: 0 });
    const origins = new Set(stories.map((x) => x.origin));
    expect(origins.size).toBeGreaterThan(1);
    expect(origins).toContain("hn");
    expect(origins).toContain("event");
  });

  it("still leads with a human submission when there is one", async () => {
    for (let i = 0; i < 20; i++) await addStory(`hn${i}`, "hn", 900, `HN story ${i}`);
    const u = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "Ann" });
    await repo.submit(u.id, { kind: "link", title: "A local person posted this", url: "https://ex.com/mine" } as any);

    const { stories } = await repo.feed({ src: "bay", sort: "hot", limit: 10, offset: 0 });
    expect(stories[0]!.title).toBe("A local person posted this");
  });

  it("leaves the explicit source filters alone", async () => {
    for (let i = 0; i < 5; i++) await addStory(`hn${i}`, "hn", 400, `HN ${i}`);
    for (let i = 0; i < 5; i++) await addStory(`ev${i}`, "event", null, `Event ${i}`);
    const hn = await repo.feed({ src: "hn", sort: "new", limit: 20, offset: 0 });
    expect(hn.stories.every((x) => x.origin === "hn")).toBe(true);
  });
});
