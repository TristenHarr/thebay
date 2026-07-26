/**
 * Link integrity.
 *
 * Two separate production bugs came from the same mistake: the site RENDERED a
 * URL that no route handled. Comment forms posted to /item/<id>/<slug>/comment
 * when only /item/:id/comment existed, and every author byline linked to
 * /u/<handle> which did not exist at all. Both looked fine until clicked, and
 * both passed tests that hand-wrote the path instead of reading it off the page.
 *
 * So: render the real pages, extract every internal href and form action, and
 * request each one. A 404 or 405 here means the site links somewhere it cannot
 * serve — no matter which route or template introduced it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import newsWorker from "../src/worker/news";
import { makeTestEnv } from "./helpers/app";
import { NewsRepo } from "../src/storage/d1/news-repo";
import { SocialRepo } from "../src/storage/d1/social-repo";

const SF = { lat: 37.7749, lng: -122.4194 };

describe("every rendered link resolves", () => {
  let env: any, repo: NewsRepo, social: SocialRepo, cookie: string, storyPath: string;

  const req = (path: string, init: RequestInit = {}) =>
    newsWorker.fetch(new Request("https://thebay.news" + path, init), env, {} as any);

  beforeEach(async () => {
    ({ env } = makeTestEnv({ NEWS_ORIGIN: "https://thebay.news", PUBLIC_ORIGIN: "https://thebay.events" }));
    repo = new NewsRepo(env.DB);
    social = new SocialRepo(env.DB);

    const author = await social.upsertByIdentity({
      provider: "dev", providerUid: "ann@x.com", email: "ann@x.com", displayName: "Ann Nakamura",
    });
    const { id } = await repo.submit(author.id, {
      kind: "link", title: "Fabricating a MEMS resonator", url: "https://semiengineering.com/mems",
    } as any);
    await repo.addComment(id, author.id, "A comment so the thread renders.");
    const story = (await repo.getStory(id))!;
    storyPath = `/item/${story.id}/${story.slug}`;

    // A signed-in session, so signed-in-only chrome (submit form, reply) renders.
    const login = await req("/auth/dev", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ann@x.com", name: "Ann Nakamura" }),
    });
    cookie = (login.headers.get("set-cookie") || "").split(";")[0]!;
    await req("/api/news/attest", {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(SF),
    });
  });

  /** Internal hrefs and form actions, with the method each would be used by. */
  function extractTargets(htmlText: string): { path: string; method: string }[] {
    const out = new Map<string, { path: string; method: string }>();

    for (const m of htmlText.matchAll(/<form\b([^>]*)>/gi)) {
      const attrs = m[1]!;
      const action = /action\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
      const method = (/method\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] || "get").toUpperCase();
      if (action?.startsWith("/")) out.set(`${method} ${action}`, { path: action, method });
    }
    for (const m of htmlText.matchAll(/\bhref\s*=\s*"(\/[^"]*)"/gi)) {
      const path = m[1]!.split("#")[0]!;
      if (path && !out.has(`GET ${path}`)) out.set(`GET ${path}`, { path, method: "GET" });
    }
    return [...out.values()];
  }

  async function assertAllResolve(pagePath: string) {
    const res = await req(pagePath, { headers: { cookie } });
    expect(res.status, `${pagePath} should render`).toBe(200);
    const body = await res.text();

    const targets = extractTargets(body);
    expect(targets.length, `${pagePath} should contain links`).toBeGreaterThan(3);

    const broken: string[] = [];
    for (const t of targets) {
      const init: RequestInit = { headers: { cookie } };
      if (t.method === "POST") {
        init.method = "POST";
        (init.headers as any)["content-type"] = "application/x-www-form-urlencoded";
        init.body = "body=link-integrity-probe";
      }
      const r = await req(t.path, init);
      // 404 = nothing serves it. 405 = wrong method. Anything else (including
      // 401/403/303) means a handler exists, which is what's being checked.
      if (r.status === 404 || r.status === 405) broken.push(`${t.method} ${t.path} → ${r.status}`);
    }
    expect(broken, `${pagePath} links to URLs nothing serves`).toEqual([]);
  }

  it("front page", async () => { await assertAllResolve("/"); });
  it("newest", async () => { await assertAllResolve("/newest"); });
  it("aggregated view", async () => { await assertAllResolve("/?src=all"); });
  it("item page (comment form + author + reply)", async () => { await assertAllResolve(storyPath); });
  it("submit page", async () => { await assertAllResolve("/submit"); });
  it("about", async () => { await assertAllResolve("/about"); });
  it("login", async () => { await assertAllResolve("/login"); });
  it("profile page", async () => { await assertAllResolve("/u/ann-nakamura".replace("ann-nakamura", (await repo.userByHandle("ann"))?.handle ?? "ann")); });

  it("the author byline specifically resolves (it 404'd in production)", async () => {
    const body = await (await req("/")).text();
    const handleHref = /href="(\/u\/[^"]+)"/.exec(body)?.[1];
    expect(handleHref, "a story byline should link to a profile").toBeTruthy();
    expect((await req(handleHref!)).status).toBe(200);
  });

  it("an unknown handle 404s rather than erroring", async () => {
    expect((await req("/u/nobody-here")).status).toBe(404);
  });
});
