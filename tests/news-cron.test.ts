/**
 * runNewsIngest — the function the cron runs every 15 minutes.
 *
 * It was the least-covered code in the product (6% of statements) despite being
 * the only thing keeping the front page alive unattended. What matters here is
 * FAILURE ISOLATION: one dead feed, a rate-limiting aggregator, or an AI outage
 * must degrade the harvest, never abort the run.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { runNewsIngest } from "../src/news/ingest";
import { makeTestEnv } from "./helpers/app";
import { NewsRepo } from "../src/storage/d1/news-repo";
import { CompaniesRepo } from "../src/storage/d1/companies-repo";
import { timeAgo, longDate, rfc822 } from "../src/news/render/time";
import { formatBody, excerpt } from "../src/news/render/text";
import { toHtml } from "../src/news/render/escape";

const HN_PAYLOAD = {
  hits: [
    { objectID: "1", title: "A real HN story", url: "https://ex.com/hn1", points: 120, num_comments: 40, created_at: "2026-07-25T10:00:00Z", author: "pg" },
    { objectID: "2", title: "Another HN story", url: "https://ex.com/hn2", points: 30, num_comments: 5, created_at: "2026-07-25T09:00:00Z", author: "dang" },
  ],
};
const LOBSTERS_PAYLOAD = [
  { short_id: "l1", title: "A Lobsters story", url: "https://ex.com/lo1", score: 20, comment_count: 3, created_at: "2026-07-25T08:00:00Z", comments_url: "https://lobste.rs/s/l1", tags: ["rust"], submitter_user: { username: "alice" } },
];
const HN_TAG_PAYLOAD = {
  hits: [
    { objectID: "s1", title: "Show HN: I built a MEMS rig", url: "https://ex.com/show1", points: 80, num_comments: 12, created_at: "2026-07-25T07:00:00Z", author: "maker" },
  ],
};
const GITHUB_PAYLOAD = {
  items: [
    { id: 991, full_name: "acme/fastdb", description: "An embedded database", html_url: "https://github.com/acme/fastdb",
      stargazers_count: 420, open_issues_count: 7, created_at: "2026-07-20T00:00:00Z", language: "Rust",
      topics: ["database"], owner: { login: "acme" } },
  ],
};
const FEED_XML = `<rss><channel><item><title>A feed story</title><link>https://ex.com/rss1</link><guid>g1</guid></item></channel></rss>`;
const PREVIEW_HTML = `<html lang="en"><head>
  <meta property="og:image" content="https://ex.com/hero.png">
  <meta property="og:description" content="A description long enough to be worth storing as a summary fallback.">
  <meta property="og:site_name" content="Example">
</head></html>`;

/** A Form D primary_doc.xml, as EDGAR serves it. Mined for the funding graph. */
const formDoc = (cik: string, name: string, amount: string) => `<?xml version="1.0"?>
<edgarSubmission>
  <submissionType>D</submissionType>
  <primaryIssuer>
    <cik>${cik}</cik>
    <entityName>${name}</entityName>
    <issuerAddress><city>San Francisco</city><stateOrCountry>CA</stateOrCountry></issuerAddress>
    <yearOfInc><value>2024</value></yearOfInc>
  </primaryIssuer>
  <relatedPersonsList>
    <relatedPersonInfo>
      <relatedPersonName><firstName>Ann</firstName><lastName>Lee</lastName></relatedPersonName>
      <relatedPersonRelationshipList><relationship>Executive Officer</relationship></relatedPersonRelationshipList>
    </relatedPersonInfo>
  </relatedPersonsList>
  <offeringData>
    <industryGroup><industryGroupType>Technology</industryGroupType></industryGroup>
    <offeringSalesAmounts><totalOfferingAmount>${amount}</totalOfferingAmount><totalAmountSold>${amount}</totalAmountSold></offeringSalesAmounts>
  </offeringData>
</edgarSubmission>`;

/** Route a fake fetch by URL, with per-host failure injection.
 *  `failFormD` breaks the FIRST filer's primary_doc.xml only — the point being
 *  that it costs that one filing and nothing else. */
function fakeFetch(opts: { failHn?: boolean; failLobsters?: boolean; failFeeds?: boolean; failPreviews?: boolean; failGithub?: boolean; failSec?: boolean; failResearch?: boolean; failFda?: boolean; failFormD?: boolean; failArxiv?: boolean; failCrates?: boolean } = {}) {
  return (async (input: any) => {
    const url = String(typeof input === "string" ? input : input.url ?? input);
    const json = (b: any) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("hn.algolia.com")) {
      if (opts.failHn) return new Response("nope", { status: 503 });
      // Show HN / Ask HN come from the same endpoint with a tag filter.
      if (url.includes("show_hn") || url.includes("ask_hn")) return json(HN_TAG_PAYLOAD);
      return json(HN_PAYLOAD);
    }
    if (url.includes("export.arxiv.org")) {
      if (opts.failArxiv) return new Response("", { status: 503 });
      return new Response(
        `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
           <id>http://arxiv.org/abs/2507.00001v1</id><published>2026-07-24T00:00:00Z</published>
           <title>A paper</title><author><name>A Author</name></author>
           <arxiv:primary_category term="cs.LG" /></entry></feed>`,
        { status: 200, headers: { "content-type": "application/atom+xml" } },
      );
    }
    if (url.includes("crates.io/api/v1/summary")) {
      if (opts.failCrates) return new Response("", { status: 500 });
      return json({ just_updated: [{ name: "a-crate", newest_version: "1.2.3",
        description: "A crate that does a thing worth describing", downloads: 9999,
        updated_at: "2026-07-26T00:00:00Z" }], new_crates: [] });
    }
    if (url.includes("crates.io/api/v1/crates")) {
      return json({ crates: [] });
    }
    if (url.includes("api.openalex.org")) {
      if (opts.failResearch) return new Response("", { status: 429 });
      return json({ results: [{ id: "https://openalex.org/W1", title: "A Bay paper", publication_date: "2026-07-24",
        cited_by_count: 5, primary_topic: { field: { display_name: "Computer Science" } },
        authorships: [{ author: { display_name: "Researcher" } }] }] });
    }
    if (url.includes("api.fda.gov")) {
      if (opts.failFda) return new Response("", { status: 500 });
      return json({ results: [{ k_number: "K260001", applicant: "Bay Medical", device_name: "A Device",
        city: "SAN FRANCISCO", state: "CA", decision_date: "2026-07-22" }] });
    }
    if (url.includes("efts.sec.gov")) {
      if (opts.failSec) return new Response("", { status: 403 });
      return json({ hits: { hits: [
        { _source: { ciks: ["1"], display_names: ["Acme Inc  (CIK 0000001)"], form: "D",
          file_date: "2026-07-21", biz_locations: ["San Francisco, CA"], adsh: "0000001-26-000001" } },
        { _source: { ciks: ["2"], display_names: ["Zeta Bio Inc  (CIK 0000002)"], form: "D",
          file_date: "2026-07-20", biz_locations: ["Oakland, CA"], adsh: "0000002-26-000002" } },
      ] } });
    }
    // The structured filing behind an SEC story (Track E). Matched on the document
    // name, not the archive path — the story's own -index.htm lives there too and
    // is a link-preview fetch.
    if (url.includes("primary_doc.xml")) {
      if (url.includes("/data/1/")) {
        if (opts.failFormD) return new Response("", { status: 500 });
        return new Response(formDoc("0000001", "Acme Inc", "4200000"), { status: 200 });
      }
      return new Response(formDoc("0000002", "Zeta Bio Inc", "1500000"), { status: 200 });
    }
    if (url.includes("api.github.com")) {
      if (opts.failGithub) return new Response("rate limited", { status: 403 });
      return json(GITHUB_PAYLOAD);
    }
    if (url.includes("lobste.rs")) {
      if (opts.failLobsters) throw new Error("connection reset");
      return json(LOBSTERS_PAYLOAD);
    }
    if (url.includes("arxiv") || url.includes("cloudflare") || url.includes("hackaday") || url.includes("sfstandard")) {
      if (opts.failFeeds) return new Response("", { status: 500 });
      return new Response(FEED_XML, { status: 200, headers: { "content-type": "application/rss+xml" } });
    }
    // Everything else is a link-preview fetch.
    if (opts.failPreviews) throw new Error("unreachable");
    return new Response(PREVIEW_HTML, { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
}

describe("runNewsIngest", () => {
  let env: any, repo: NewsRepo;
  beforeEach(() => { ({ env } = makeTestEnv()); repo = new NewsRepo(env.DB); });

  it("harvests every source, stores previews, and reports what it did", async () => {
    const r = await runNewsIngest(env, fakeFetch());
    expect(r.failures).toEqual([]);
    expect(r.fetched).toBeGreaterThanOrEqual(4); // 2 HN + 1 Lobsters + feeds
    expect(r.created).toBeGreaterThanOrEqual(4);
    expect(r.previewed).toBeGreaterThan(0);

    const { stories } = await repo.feed({ src: "all", sort: "new", limit: 50, offset: 0 });
    expect(stories.some((s) => s.title === "A real HN story")).toBe(true);
    expect(stories.some((s) => s.title === "A Lobsters story")).toBe(true);
    expect(stories.some((s) => s.imageUrl === "https://ex.com/hero.png")).toBe(true);
  });

  it("is idempotent — a second run creates nothing and only refreshes", async () => {
    await runNewsIngest(env, fakeFetch());
    const before = (await repo.feed({ src: "all", sort: "new", limit: 100, offset: 0 })).total;
    const second = await runNewsIngest(env, fakeFetch());
    expect(second.created).toBe(0);
    expect(second.refreshed).toBeGreaterThan(0);
    expect((await repo.feed({ src: "all", sort: "new", limit: 100, offset: 0 })).total).toBe(before);
  });

  it("isolates ONE dead source — the rest of the harvest still lands", async () => {
    const r = await runNewsIngest(env, fakeFetch({ failHn: true }));
    expect(r.failures.join(" ")).toMatch(/hn/);
    expect(r.created).toBeGreaterThan(0); // Lobsters + feeds still made it
    const { stories } = await repo.feed({ src: "all", sort: "new", limit: 50, offset: 0 });
    expect(stories.some((s) => s.title === "A Lobsters story")).toBe(true);
  });

  it("isolates a source that THROWS rather than returning an error status", async () => {
    const r = await runNewsIngest(env, fakeFetch({ failLobsters: true }));
    expect(r.failures.join(" ")).toMatch(/lobsters/);
    expect(r.created).toBeGreaterThan(0);
  });

  it("records every failing feed without aborting", async () => {
    const r = await runNewsIngest(env, fakeFetch({ failFeeds: true }));
    expect(r.failures.some((f) => f.startsWith("feed:") || f.startsWith("rss"))).toBe(true);
    expect(r.created).toBeGreaterThan(0); // HN + Lobsters unaffected
  });

  it("still completes when EVERY source is down", async () => {
    const r = await runNewsIngest(env, fakeFetch({ failHn: true, failLobsters: true, failFeeds: true, failGithub: true, failSec: true, failResearch: true, failFda: true, failArxiv: true, failCrates: true }));
    expect(r.failures.length).toBeGreaterThan(0);
    expect(r.created).toBe(0);
    expect(r).toHaveProperty("summarized"); // returned a report rather than throwing
  });

  it("survives previews being unreachable", async () => {
    const r = await runNewsIngest(env, fakeFetch({ failPreviews: true }));
    expect(r.created).toBeGreaterThan(0);
    expect(r.previewed).toBe(0);
    // Marked as attempted, so it isn't retried forever.
    expect(await repo.needingPreview(50)).toEqual([]);
  });

  it("survives the AI binding throwing", async () => {
    env.AI = { run: async () => { throw new Error("model unavailable"); } };
    const r = await runNewsIngest(env, fakeFetch());
    expect(r.created).toBeGreaterThan(0);
    expect(r.failures.some((f) => f.startsWith("summarize"))).toBe(false); // handled per-story
  });

  it("uses the AI summary when the model answers sensibly", async () => {
    env.AI = { run: async () => ({ response: "A concise one-sentence summary of the story for Bay engineers." }) };
    await runNewsIngest(env, fakeFetch());
    const { stories } = await repo.feed({ src: "all", sort: "new", limit: 50, offset: 0 });
    expect(stories.some((s) => s.summary?.startsWith("A concise one-sentence"))).toBe(true);
  });
});

describe("time helpers", () => {
  const NOW = Date.parse("2026-07-25T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it("renders every relative-time band", () => {
    expect(timeAgo(ago(10_000), NOW)).toBe("now");
    expect(timeAgo(ago(5 * 60_000), NOW)).toBe("5m");
    expect(timeAgo(ago(3 * 3_600_000), NOW)).toBe("3h");
    expect(timeAgo(ago(2 * 86_400_000), NOW)).toBe("2d");
    expect(timeAgo(ago(60 * 86_400_000), NOW)).toBe("2mo");
    expect(timeAgo(ago(400 * 86_400_000), NOW)).toBe("1y");
  });

  it("never renders a negative age from clock skew", () => {
    expect(timeAgo(new Date(NOW + 60_000).toISOString(), NOW)).toBe("now");
  });

  it("returns empty for unparseable input rather than NaN", () => {
    expect(timeAgo("garbage", NOW)).toBe("");
    expect(longDate("garbage")).toBe("");
  });

  it("formats a long date and an RFC-822 date", () => {
    expect(longDate("2026-07-25T12:00:00.000Z")).toBe("Jul 25, 2026");
    expect(rfc822("2026-07-25T12:00:00.000Z")).toMatch(/^Sat, 25 Jul 2026/);
  });
});

describe("body formatting", () => {
  it("splits paragraphs and preserves single newlines as breaks", () => {
    const out = toHtml(formatBody("First para.\nSame para, new line.\n\nSecond para."));
    expect(out).toBe("<p>First para.<br>Same para, new line.</p><p>Second para.</p>");
  });

  it("autolinks urls with nofollow, and never trusts the scheme", () => {
    const out = toHtml(formatBody("See https://example.com/a?b=1 for details."));
    expect(out).toContain('rel="nofollow noopener ugc"');
    expect(out).toContain('href="https://example.com/a?b=1"');
    expect(toHtml(formatBody("javascript:alert(1) is not a link"))).not.toContain("<a ");
  });

  it("escapes before linkifying, so markup in a url can't break out", () => {
    const out = toHtml(formatBody('<img src=x> https://ex.com/"onmouseover="alert(1)'));
    expect(out).not.toContain("<img src=x>");
    expect(out).not.toContain('"onmouseover="');
  });

  it("truncates long urls for display but links the full one", () => {
    const long = "https://example.com/" + "y".repeat(90);
    const out = toHtml(formatBody(long));
    expect(out).toContain(`href="${long}"`);
    expect(out).toContain("…</a>");
  });

  it("renders nothing for empty input", () => {
    expect(toHtml(formatBody(""))).toBe("");
    expect(toHtml(formatBody(null))).toBe("");
  });

  it("excerpts on a word boundary", () => {
    expect(excerpt("short")).toBe("short");
    const e = excerpt("word ".repeat(80), 50);
    expect(e.length).toBeLessThanOrEqual(50);
    expect(e.endsWith("…")).toBe(true);
    expect(e).not.toMatch(/\s…$/);
  });
});

describe("the new sources are isolated like every other one", () => {
  it("a GitHub outage does not stop the rest of the harvest", async () => {
    const { env } = makeTestEnv();
    const repo = new NewsRepo(env.DB);
    const r = await runNewsIngest(env, fakeFetch({ failGithub: true }));
    expect(r.failures.join(" ")).toMatch(/github/);
    expect(r.created).toBeGreaterThan(0);
    expect((await repo.feed({ src: "all", sort: "new", limit: 50, offset: 0 })).stories.some((s) => s.title === "A real HN story")).toBe(true);
  });

  it("mines the Form D behind each SEC story into the funding graph", async () => {
    const { env } = makeTestEnv();
    const r = await runNewsIngest(env, fakeFetch());
    expect(r.failures).toEqual([]);
    expect(r.filings).toBe(2);
    expect(r.companies).toBe(2);

    const repo = new CompaniesRepo(env.DB);
    const acme = await repo.bySlug("acme");
    expect(acme!.company).toMatchObject({ cik: "1", city: "San Francisco", industry: "Technology", yearFounded: 2024 });
    expect(acme!.rounds[0]).toMatchObject({ amountUsd: 4_200_000, source: "sec", externalId: "0000001-26-000001" });
    // the person on the filing is stored UNRESOLVED — a name, never an account
    expect(acme!.people).toEqual([expect.objectContaining({ personName: "Ann Lee", role: "Executive Officer", confirmed: false, handle: null })]);

    // the news story is linked to its company, so the front page can show the money
    const story = (await new NewsRepo(env.DB).feed({ src: "sec", sort: "new", limit: 10, offset: 0 })).stories.find((s) => s.title.startsWith("Acme"))!;
    expect((await repo.factsForStories([story.id])) [story.id]).toMatchObject({ slug: "acme", amountUsd: 4_200_000, roundSource: "sec" });
  });

  it("spends the Form D budget only on filings it has never seen", async () => {
    const { env } = makeTestEnv();
    await runNewsIngest(env, fakeFetch());
    const second = await runNewsIngest(env, fakeFetch());
    expect(second.filings).toBe(0); // both accessions already stored
    expect(second.companies).toBe(0);
    expect(second.failures).toEqual([]);
  });

  it("a broken primary_doc.xml costs ONE filing, not the harvest", async () => {
    const { env } = makeTestEnv();
    const repo = new NewsRepo(env.DB);
    const r = await runNewsIngest(env, fakeFetch({ failFormD: true }));

    expect(r.filings).toBe(1); // Zeta still landed
    expect(r.failures).toEqual(["formd:0000001-26-000001"]);
    expect(await new CompaniesRepo(env.DB).bySlug("zeta-bio")).toBeTruthy();
    expect(await new CompaniesRepo(env.DB).bySlug("acme")).toBeNull();
    // and the news side is entirely unaffected
    expect(r.created).toBeGreaterThan(0);
    const { stories } = await repo.feed({ src: "all", sort: "new", limit: 50, offset: 0 });
    expect(stories.some((s) => s.title === "A real HN story")).toBe(true);
    expect(stories.some((s) => s.title.startsWith("Acme"))).toBe(true); // the STORY survived
  });

  it("stores GitHub repos and Show HN under their own origins", async () => {
    const { env } = makeTestEnv();
    const repo = new NewsRepo(env.DB);
    await runNewsIngest(env, fakeFetch());
    const gh = await repo.feed({ src: "github", sort: "new", limit: 10, offset: 0 });
    expect(gh.stories.some((s) => s.title.startsWith("acme/fastdb"))).toBe(true);
    const hn = await repo.feed({ src: "hn", sort: "new", limit: 20, offset: 0 });
    expect(hn.stories.some((s) => s.title.startsWith("Show HN"))).toBe(true);
  });
});
