/**
 * Edge cases and hostile input across both products.
 *
 * Grouped around the failure modes that actually reached production here:
 * bound-parameter overflow at scale, feeds that must stay machine-parseable,
 * and write endpoints that must refuse the wrong caller.
 */
import { describe, it, expect, beforeEach } from "vitest";
import newsWorker from "../src/worker/news";
import { makeTestEnv } from "./helpers/app";
import { NewsRepo } from "../src/storage/d1/news-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";
import { GraphRepo } from "../src/storage/d1/graph-repo";
import { makeTestDb } from "./helpers/d1";

const SF = { lat: 37.7749, lng: -122.4194 };
const LA = { lat: 34.0522, lng: -118.2437 };

describe("scale: bound-parameter limits", () => {
  // The test shim enforces D1's 100-parameter cap, so these fail loudly if any
  // query stops chunking. Both of these shapes 500'd (or would have) in prod.
  it("GraphRepo survives a user with more connections than fit in one statement", async () => {
    const { d1 } = makeTestDb();
    const social = new SocialRepo(d1);
    const graph = new GraphRepo(d1);
    const me = await social.upsertByIdentity({ provider: "dev", providerUid: "me@x.com", email: "me@x.com", displayName: "Me" });

    // 60 accepted friendships — the edge query binds the id list TWICE, so this
    // is 120 parameters unchunked.
    for (let i = 0; i < 60; i++) {
      const f = await social.upsertByIdentity({ provider: "dev", providerUid: `f${i}@x.com`, email: `f${i}@x.com`, displayName: `F${i}` });
      await social.requestFriend(me.id, f.id);
      await social.respondFriend(f.id, me.id, true);
    }
    const g = await graph.networkGraph(me.id);
    expect(g.nodes.length).toBe(61);
    expect(g.edges.length).toBe(60);
    // Every edge must stay inside the ego-net.
    const ids = new Set(g.nodes.map((n: any) => n.id));
    expect(g.edges.every((e: any) => ids.has(e.a) && ids.has(e.b))).toBe(true);
  });

  it("NewsRepo ranks a large candidate set for a signed-in viewer", async () => {
    const { d1 } = makeTestDb();
    const repo = new NewsRepo(d1);
    const social = new SocialRepo(d1);
    const u = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "A" });
    for (let i = 0; i < 150; i++) {
      await repo.submit(u.id, { kind: "link", title: `S${i}`, url: `https://ex.com/${i}` } as any);
    }
    // Signed-in is the path that 500'd: it adds the per-viewer network query.
    const hot = await repo.feed({ src: "all", sort: "hot", limit: 30, offset: 0 }, u.id);
    expect(hot.stories).toHaveLength(30);
  });
});

describe("feeds stay machine-parseable", () => {
  let env: any, repo: NewsRepo;
  const req = (p: string, init: RequestInit = {}) =>
    newsWorker.fetch(new Request("https://thebay.news" + p, init), env, {} as any);

  beforeEach(async () => {
    ({ env } = makeTestEnv({ NEWS_ORIGIN: "https://thebay.news", PUBLIC_ORIGIN: "https://thebay.events" }));
    repo = new NewsRepo(env.DB);
    const social = new SocialRepo(env.DB);
    const u = await social.upsertByIdentity({ provider: "dev", providerUid: "a@x.com", email: "a@x.com", displayName: "A" });
    // A title full of things that break XML if unescaped.
    await repo.submit(u.id, {
      kind: "link",
      title: `Ampersands & "quotes" <tags> and 'apostrophes'`,
      url: "https://ex.com/xml",
    } as any);
  });

  /** Minimal well-formedness check: tags balance and no raw & or < in text. */
  function assertWellFormed(xml: string) {
    const stack: string[] = [];
    for (const m of xml.matchAll(/<\/?([a-zA-Z][\w:.-]*)[^>]*?(\/?)>/g)) {
      const [full, name, selfClose] = [m[0], m[1]!, m[2]];
      if (full.startsWith("<?") || full.startsWith("<!")) continue;
      if (selfClose === "/") continue;
      if (full.startsWith("</")) {
        expect(stack.pop(), `unbalanced </${name}>`).toBe(name);
      } else {
        stack.push(name);
      }
    }
    expect(stack, "unclosed tags").toEqual([]);
    // No unescaped & (every & must begin an entity) outside CDATA.
    const text = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
    expect(text.match(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g) ?? []).toEqual([]);
  }

  it("feed.xml is well-formed even with hostile titles", async () => {
    const res = await req("/feed.xml");
    expect(res.status).toBe(200);
    const xml = await res.text();
    assertWellFormed(xml);
    expect(xml).toContain("&amp;");
    expect(xml).not.toContain('<tags>');
  });

  it("sitemap.xml is well-formed and lists only absolute URLs", async () => {
    const xml = await (await req("/sitemap.xml")).text();
    assertWellFormed(xml);
    for (const loc of [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!)) {
      expect(loc.startsWith("https://thebay.news"), `relative loc: ${loc}`).toBe(true);
    }
  });

  it("robots.txt keeps private surfaces out of the index", async () => {
    const txt = await (await req("/robots.txt")).text();
    for (const p of ["/submit", "/login", "/api/", "/auth/"]) expect(txt).toContain(`Disallow: ${p}`);
  });
});

describe("write endpoints refuse the wrong caller", () => {
  let env: any, repo: NewsRepo, storyId: string;
  const req = (p: string, init: RequestInit = {}) =>
    newsWorker.fetch(new Request("https://thebay.news" + p, init), env, {} as any);
  const json = (p: string, body: any, cookie?: string) =>
    req(p, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

  async function signIn(email = "a@x.com") {
    const r = await json("/auth/dev", { email, name: "A" });
    return (r.headers.get("set-cookie") || "").split(";")[0]!;
  }

  beforeEach(async () => {
    ({ env } = makeTestEnv({ NEWS_ORIGIN: "https://thebay.news", PUBLIC_ORIGIN: "https://thebay.events" }));
    repo = new NewsRepo(env.DB);
    const social = new SocialRepo(env.DB);
    const u = await social.upsertByIdentity({ provider: "dev", providerUid: "seed@x.com", email: "seed@x.com", displayName: "S" });
    ({ id: storyId } = await repo.submit(u.id, { kind: "link", title: "A story", url: "https://ex.com/a" } as any));
  });

  it("voting on a story that doesn't exist 404s instead of 500ing", async () => {
    const cookie = await signIn();
    await json("/api/news/attest", SF, cookie);
    const res = await json("/api/news/vote", { storyId: "does-not-exist" }, cookie);
    expect([404, 409]).toContain(res.status);
  });

  it("rejects a vote with no storyId", async () => {
    const cookie = await signIn();
    await json("/api/news/attest", SF, cookie);
    expect((await json("/api/news/vote", {}, cookie)).status).toBe(400);
  });

  it("un-votes back down and never goes negative", async () => {
    const cookie = await signIn();
    await json("/api/news/attest", SF, cookie);
    expect((await (await json("/api/news/vote", { storyId }, cookie)).json() as any).votes).toBe(1);
    expect((await (await json("/api/news/vote", { storyId, on: false }, cookie)).json() as any).votes).toBe(0);
    expect((await (await json("/api/news/vote", { storyId, on: false }, cookie)).json() as any).votes).toBe(0);
  });

  it("rejects an attestation with junk coordinates", async () => {
    const cookie = await signIn();
    for (const bad of [{ lat: 999, lng: 0 }, { lat: "x", lng: "y" }, {}, { lat: null, lng: null }]) {
      const r = await json("/api/news/attest", bad, cookie);
      expect([400, 403]).toContain(r.status);
    }
  });

  it("expires the Bay attestation rather than trusting it forever", async () => {
    const cookie = await signIn();
    await json("/api/news/attest", SF, cookie);
    expect((await json("/api/news/vote", { storyId }, cookie)).status).toBe(200);
    // Simulate the 12h TTL lapsing.
    for (const k of [...(env.SESSIONS._map.keys() as Iterable<string>)]) {
      if (k.startsWith("geo:")) env.SESSIONS._map.delete(k);
    }
    expect((await json("/api/news/vote", { storyId }, cookie)).status).toBe(403);
  });

  it("enforces the submit rate limit", async () => {
    const cookie = await signIn();
    await json("/api/news/attest", SF, cookie);
    const form = (title: string, url: string) =>
      req("/submit", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({ title, url }).toString(),
      });
    // LIMITS.submit.max is 5; the 6th must be refused rather than accepted.
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await form(`Story number ${i}`, `https://ex.com/rl${i}`)).status);
    expect(codes.filter((c) => c === 303).length).toBeLessThanOrEqual(5);
    expect(codes.at(-1)).not.toBe(303); // the last one is over the limit
  });

  it("refuses to post from outside the Bay even with a valid session", async () => {
    const cookie = await signIn();
    expect((await json("/api/news/attest", LA, cookie)).status).toBe(403);
    expect((await json("/api/news/vote", { storyId }, cookie)).status).toBe(403);
  });
});
