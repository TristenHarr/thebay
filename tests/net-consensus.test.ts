/**
 * Consensus — the swarm simulator.
 *
 * This is the test that decides whether the network can be trusted, so it is written as
 * a cast of characters rather than as a list of functions: honest workers, a fabricator,
 * a lazy worker whose crawl half-failed, two accounts sharing one house, and a worker who
 * simply looked a minute later than everyone else. The assertions are about outcomes a
 * human cares about — what reached the public catalog, and who got blamed.
 *
 * Two of them matter more than the rest:
 *
 *   · a FABRICATED event never reaches /api/events, and
 *   · an HONEST worker who happened to be alone, or slower, or on a source nobody else
 *     covered, is never marked wrong for it.
 *
 * The second is easy to lose while chasing the first, and losing it means the network
 * bleeds exactly the people you want.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, call, login, type TestApp } from "./helpers/app";
import { ScrapeNetRepo } from "../src/storage/d1/scrape-net-repo";
import { recipeHost } from "../src/core/scrape/host";
import { resolve, observationDigest, overlap, CONTRADICTION_MIN_OVERLAP, type LeaseInfo, type ObsInput } from "../src/core/scrape/consensus";
import { itemKey, canonicalUrl } from "../src/core/scrape/itemkey";
import { hashSecret } from "../src/core/net/invite";

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-07-26T12:00:00.000Z");

/* ─────────────────────────── the pure engine ─────────────────────────────── */

describe("core/scrape/itemkey", () => {
  it("strips what identifies a VISIT rather than a thing", () => {
    // Two workers reaching the same event page through different listings must produce
    // the same key, or each would appear to have invented an event.
    const a = canonicalUrl("https://www.eventbrite.com/e/ai-meetup-12345?utm_source=luma&aff=ebdssbdestsearch");
    const b = canonicalUrl("http://eventbrite.com/e/ai-meetup-12345#tickets");
    expect(a).toBe(b);
  });

  it("keeps parameters that DO identify the thing, in a stable order", () => {
    expect(canonicalUrl("https://x.com/e?id=7&utm_medium=x&cat=ai")).toBe("https://x.com/e?cat=ai&id=7");
    expect(canonicalUrl("https://x.com/")).toBe("https://x.com/");
    expect(canonicalUrl("https://x.com/a/")).toBe("https://x.com/a");
    expect(canonicalUrl("not a url")).toBe("not a url");
    expect(canonicalUrl("")).toBe("");
  });

  it("prefers the source's own id, because that survives an edit", () => {
    const withId = { sourceId: "luma-bay", externalId: "evt-abc", url: "https://lu.ma/x" };
    const retitled = { sourceId: "luma-bay", externalId: "evt-abc", url: "https://lu.ma/x-renamed" };
    expect(itemKey(withId, "fp1")).toBe(itemKey(retitled, "fp2"));
  });

  it("falls back to the url, then to the fingerprint — in that order", () => {
    const byUrl = itemKey({ sourceId: "s", url: "https://x.com/e/1" }, "fp");
    expect(byUrl).toBe(itemKey({ sourceId: "s", externalId: "", url: "https://x.com/e/1?utm_a=1" }, "other-fp"));
    expect(itemKey({ sourceId: "s" }, "fp")).toBe(itemKey({ sourceId: "s", url: "" }, "fp"));
    expect(itemKey({ sourceId: "s" }, "fp")).not.toBe(byUrl);
  });

  it("scopes by source, so a Luma sighting cannot corroborate an Eventbrite one", () => {
    expect(itemKey({ sourceId: "luma-bay", externalId: "x" }, "fp")).not.toBe(itemKey({ sourceId: "eb-hubs", externalId: "x" }, "fp"));
  });
});

describe("core/scrape/consensus — the arithmetic", () => {
  const lease = (id: string, over: Partial<LeaseInfo> = {}): LeaseInfo => ({
    leaseId: id,
    memberId: `m_${id}`,
    cluster: `c_${id}`,
    tier: "probation",
    completed: true,
    ...over,
  });
  const obs = (leaseId: string, keys: string[]): ObsInput[] => keys.map((k) => ({ id: `${leaseId}:${k}`, leaseId, itemKey: k }));

  it("digests the same set to the same hash regardless of order or repeats", () => {
    expect(observationDigest(["b", "a", "c"])).toBe(observationDigest(["c", "b", "a", "b"]));
    expect(observationDigest([])).toBe(observationDigest([]));
    expect(observationDigest(["a"])).not.toBe(observationDigest(["b"]));
  });

  it("measures overlap, and treats an empty crawl as agreeing with nothing", () => {
    expect(overlap(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(overlap(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(overlap(new Set(), new Set(["a"]))).toBe(0);
  });

  it("confirms what two independent workers both saw", () => {
    const v = resolve({
      leases: [lease("L1"), lease("L2")],
      observations: [...obs("L1", ["x", "y"]), ...obs("L2", ["x", "y"])],
    });
    expect(v.every((x) => x.status === "confirmed")).toBe(true);
    expect(v[0]!.observers).toBe(2);
  });

  it("does NOT let two accounts on one egress corroborate each other", () => {
    const v = resolve({
      leases: [lease("L1", { cluster: "one-nat" }), lease("L2", { cluster: "one-nat", memberId: "m_other" })],
      observations: [...obs("L1", ["x"]), ...obs("L2", ["x"])],
    });
    // One observer wearing two hats. Nobody else finished, so it waits — it does not pass.
    expect(v[0]!.status).toBe("pending");
    expect(v[0]!.observers).toBe(1);
  });

  it("leaves a lone worker PENDING — being early is not being wrong", () => {
    const v = resolve({ leases: [lease("L1")], observations: obs("L1", ["x"]) });
    expect(v[0]!.status).toBe("pending");
    expect(v[0]!.dissenters).toBe(0);
  });

  it("lets a trusted worker publish alone when nobody contradicts them", () => {
    const v = resolve({ leases: [lease("L1", { tier: "trusted" })], observations: obs("L1", ["x"]) });
    expect(v[0]!.status).toBe("confirmed");
  });

  it("contradicts an item that an independent worker on the SAME page did not see", () => {
    // L1 and L2 agree on four items, so they clearly fetched the same listing. The fifth,
    // which only L1 reports, is an outlier rather than a timing difference.
    const shared = ["a", "b", "c", "d"];
    const v = resolve({
      leases: [lease("L1"), lease("L2")],
      observations: [...obs("L1", [...shared, "invented"]), ...obs("L2", shared)],
    });
    expect(v.find((x) => x.itemKey === "invented")!.status).toBe("contradicted");
    expect(v.filter((x) => shared.includes(x.itemKey)).every((x) => x.status === "confirmed")).toBe(true);
  });

  it("will NOT contradict when the other worker's crawl clearly failed", () => {
    // The fairness rule. L2 finished but reported almost nothing, so its silence about
    // L1's fifteen events is not evidence — it's a broken crawl.
    const many = Array.from({ length: 15 }, (_, i) => `item${i}`);
    const v = resolve({
      leases: [lease("L1"), lease("L2")],
      observations: [...obs("L1", many), ...obs("L2", ["item0"])],
    });
    expect(v.filter((x) => x.status === "contradicted")).toHaveLength(0);
    // item0 is genuinely corroborated; the rest simply wait for a real second opinion.
    expect(v.find((x) => x.itemKey === "item0")!.status).toBe("confirmed");
    expect(v.filter((x) => x.status === "pending")).toHaveLength(14);
  });

  it("holds a trusted worker to evidence too — the tier is not a licence", () => {
    const shared = ["a", "b", "c", "d"];
    const v = resolve({
      leases: [lease("L1", { tier: "core" }), lease("L2")],
      observations: [...obs("L1", [...shared, "only-core-saw-this"]), ...obs("L2", shared)],
    });
    expect(v.find((x) => x.itemKey === "only-core-saw-this")!.status).toBe("contradicted");
  });

  it("ignores an unfinished lease — an open crawl is not a silent one", () => {
    const shared = ["a", "b", "c", "d"];
    const v = resolve({
      leases: [lease("L1"), lease("L2", { completed: false })],
      observations: obs("L1", [...shared, "extra"]),
    });
    expect(v.every((x) => x.status === "pending")).toBe(true);
  });

  it("respects the overlap threshold it documents", () => {
    // Exactly at the threshold counts; comfortably below it does not.
    const at = resolve({
      leases: [lease("L1"), lease("L2")],
      observations: [...obs("L1", ["a", "b", "c", "solo"]), ...obs("L2", ["a", "b", "c"])],
    });
    expect(overlap(new Set(["a", "b", "c", "solo"]), new Set(["a", "b", "c"]))).toBeGreaterThanOrEqual(CONTRADICTION_MIN_OVERLAP);
    expect(at.find((x) => x.itemKey === "solo")!.status).toBe("contradicted");
  });

  it("credits the finder, and is deterministic", () => {
    const v = resolve({
      leases: [lease("L1", { memberId: "ann" }), lease("L2", { memberId: "bob" })],
      observations: [...obs("L1", ["z", "a"]), ...obs("L2", ["a", "z"])],
    });
    expect(v.map((x) => x.itemKey)).toEqual([...v.map((x) => x.itemKey)].sort());
    expect(v[0]!.finderMemberIds.sort()).toEqual(["ann", "bob"]);
  });

  it("discards observations whose lease it was never told about", () => {
    const v = resolve({ leases: [lease("L1")], observations: [...obs("L1", ["x"]), ...obs("GHOST", ["forged"])] });
    expect(v.map((x) => x.itemKey)).toEqual(["x"]);
  });
});

/* ──────────────────────── the swarm, end to end ──────────────────────────── */

describe("the swarm", () => {
  let t: TestApp;
  let net: ScrapeNetRepo;

  /** A member with a client, ready to work. Returns its bearer token. */
  async function join(name: string, tier: "probation" | "trusted" | "core"): Promise<{ token: string; userId: string }> {
    const { cookie, user } = await login(t, `${name}@x.com`, name);
    await t.env.DB.prepare("INSERT INTO network_members (user_id, tier, joined_at) VALUES (?, ?, ?)").bind(user.id, tier, iso(T0)).run();
    const r = await call(t, "/api/net/clients", { method: "POST", cookie, body: { kind: "cli", capabilities: ["fetch"] } });
    return { token: r.json.token, userId: user.id };
  }

  /**
   * One raw event exactly as an adapter would emit it — pre-normalisation.
   *
   * Titles and venues are deliberately distinct rather than `Event 1`, `Event 2`: the
   * existing `dedupeWithinRun` fuzzy-matches titles at 0.85 similarity within a
   * city+day bucket, so near-identical fixtures would be merged before consensus ever
   * saw them and every count below would be quietly wrong.
   */
  const TITLES = [
    "AI Infra Night", "Hardware Happy Hour", "Robotics Demo Day", "Solid State Batteries",
    "Category Theory Reading Group", "Seed Stage Office Hours", "Compilers After Dark",
    "Photonics Meetup", "Rust Systems Salon", "Bio x Software Mixer", "Formal Methods Night",
    "Founder Speed Dating", "Analog Circuits Jam",
  ];
  const VENUES = ["Shack15", "Frontier Tower", "GitHub HQ", "Mission Control", "Fort Mason", "The Midway"];
  const raw = (n: number, over: Record<string, unknown> = {}) => ({
    sourceId: "cv",
    sourceType: "generic-json",
    externalId: `evt-${n}`,
    title: TITLES[n % TITLES.length]!,
    startRaw: `2026-08-0${(n % 8) + 1}T18:00:00-07:00`,
    url: `https://cerebralvalley.ai/e/${n}`,
    city: "San Francisco",
    venueName: VENUES[n % VENUES.length]!,
    ...over,
  });

  /** Lease a job, then submit `items` for it, as `token`'s worker. */
  async function work(token: string, items: unknown[], ip = "1.1.1.1") {
    const leased = await call(t, "/api/net/lease", {
      method: "POST",
      body: { max: 1 },
      headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": ip },
    });
    const lease = leased.json.leases?.[0];
    if (!lease) return { leased, submitted: null as any };
    const submitted = await call(t, "/api/net/submit", {
      method: "POST",
      body: { leaseId: lease.leaseId, items },
      headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": ip },
    });
    return { leased, submitted, lease };
  }

  /** Titles currently VISIBLE in the public catalog — retracted events are hidden, not
   *  deleted, so `hidden = 0` is what "published" actually means to a reader. */
  async function published(): Promise<string[]> {
    const r = await t.env.DB.prepare("SELECT title FROM events WHERE hidden = 0 ORDER BY title").all();
    return (r.results as any[]).map((e) => e.title);
  }

  beforeEach(async () => {
    t = makeTestApp({ HANDSHAKE_KEY: "k" });
    net = new ScrapeNetRepo(t.env.DB);
    await net.seedRecipes([{ id: "cv", type: "generic-json", params: { url: "https://api.cerebralvalley.ai/v1/x" } }], recipeHost);
    await net.plan();
    // Politeness is proven in tests/net-politeness.test.ts. Here it would only obscure
    // the assertions — every worker below would be told `too_soon` because they all poll
    // within the same millisecond — so this host's budget is opened up deliberately.
    await t.env.DB.prepare("UPDATE scrape_hosts SET min_gap_ms = 0, max_concurrent = 50").run();
  });

  it("publishes what two independent workers agree on", async () => {
    const ann = await join("ann", "probation");
    const bob = await join("bob", "probation");
    const items = [raw(1), raw(2)];

    const first = await work(ann.token, items, "9.9.9.1");
    expect(first.submitted.status).toBe(200);
    expect(first.submitted.json.accepted).toBe(2);
    // Alone so far: nothing published, nothing blamed.
    expect(first.submitted.json.consensus).toEqual({ confirmed: 0, pending: 2, contradicted: 0 });
    expect(await published()).toEqual([]);

    const second = await work(bob.token, items, "9.9.9.2");
    expect(second.submitted.json.consensus.confirmed).toBe(2);
    expect(second.submitted.json.published).toBe(2);
    expect(await published()).toEqual([raw(1).title, raw(2).title].sort());
  });

  it("keeps a FABRICATED event out of the public catalog", async () => {
    const ann = await join("ann", "probation");
    const liar = await join("liar", "probation");
    const real = [raw(1), raw(2), raw(3), raw(4)];

    // The fabricator reports the real page plus one invention — the realistic attack,
    // because reporting only garbage would fail on overlap and be obvious.
    await work(liar.token, [...real, raw(99, { title: "FREE MONEY SEMINAR" })], "5.5.5.1");
    await work(ann.token, real, "5.5.5.2");

    const titles = await published();
    expect(titles).not.toContain("FREE MONEY SEMINAR");
    expect(titles).toHaveLength(4);

    const bad = await t.env.DB.prepare("SELECT status FROM scrape_observations WHERE payload_json LIKE '%FREE MONEY%'").first();
    expect(bad.status).toBe("contradicted");
  });

  it("does not blame a worker whose partner's crawl failed", async () => {
    const ann = await join("ann", "probation");
    const broken = await join("broken", "probation");
    const many = Array.from({ length: 12 }, (_, i) => raw(i));

    await work(ann.token, many, "7.7.7.1");
    await work(broken.token, [], "7.7.7.2"); // finished, saw nothing

    const rows = await t.env.DB.prepare("SELECT status, COUNT(*) AS n FROM scrape_observations GROUP BY status").all();
    const byStatus = Object.fromEntries((rows.results as any[]).map((r) => [r.status, r.n]));
    expect(byStatus.contradicted ?? 0).toBe(0);
    expect(byStatus.pending).toBe(12);
    expect(await published()).toEqual([]);
  });

  it("lets a trusted worker publish alone, exactly as the local scraper does today", async () => {
    const core = await join("core", "core");
    const r = await work(core.token, [raw(1), raw(2)], "8.8.8.1");
    expect(r.submitted.json.published).toBe(2);
    expect(await published()).toHaveLength(2);
  });

  it("refuses two accounts sharing one house as a second opinion", async () => {
    const ann = await join("ann", "probation");
    const sock = await join("sock", "probation");
    const items = [raw(1)];

    await work(ann.token, items, "4.4.4.4");
    // The coordinator declines to even lease the job to the same egress...
    const second = await call(t, "/api/net/lease", {
      method: "POST",
      body: { max: 1 },
      headers: { authorization: `Bearer ${sock.token}`, "cf-connecting-ip": "4.4.4.4" },
    });
    expect(second.json.leases).toHaveLength(0);
    expect(second.json.skipped).toContainEqual({ host: "api.cerebralvalley.ai", reason: "independence" });
    // ...so nothing gets published on one household's word.
    expect(await published()).toEqual([]);
  });

  it("re-confirms a contradicted item when a third worker backs it up, and republishes", async () => {
    const ann = await join("ann", "probation");
    const bob = await join("bob", "probation");
    const cy = await join("cy", "probation");
    const shared = [raw(1), raw(2), raw(3), raw(4)];
    const extra = raw(5, { title: "Late Addition" });

    // Ann's crawl caught an event that appeared moments before Bob's did not see it.
    await work(ann.token, [...shared, extra], "3.3.3.1");
    await work(bob.token, shared, "3.3.3.2");
    let row = await t.env.DB.prepare("SELECT status FROM scrape_observations WHERE payload_json LIKE '%Late Addition%'").first();
    expect(row.status).toBe("contradicted");
    expect(await published()).not.toContain("Late Addition");

    // A third independent worker sees it too. Ann was right all along.
    await t.env.DB.prepare("UPDATE scrape_jobs SET target_observers = 3").run();
    await work(cy.token, [...shared, extra], "3.3.3.3");

    row = await t.env.DB.prepare("SELECT status FROM scrape_observations WHERE payload_json LIKE '%Late Addition%' AND member_id = ?")
      .bind(ann.userId)
      .first();
    expect(row.status).toBe("published");
    expect(await published()).toContain("Late Addition");
  });

  it("RETRACTS a published event when evidence arrives against it — reversibly", async () => {
    // The tiered-publish rule would be unfalsifiable otherwise: a trusted member publishes
    // alone and nothing that arrives later could ever touch it. Earning the right to
    // publish alone means nobody has to corroborate you, not that nobody may disagree.
    const core = await join("core", "core");
    const honest = await join("honest", "probation");
    const real = [raw(1), raw(2), raw(3), raw(4)];

    await work(core.token, [...real, raw(5, { title: "Ghost Gala" })], "1.9.1.1");
    expect(await published()).toContain("Ghost Gala"); // solo publish, as designed

    await work(honest.token, real, "1.9.1.2");

    // Hidden, not deleted: the row, its provenance and the sighting all survive, and
    // un-hiding is one UPDATE if the contradiction turns out to be the wrong call.
    const ev = await t.env.DB.prepare("SELECT hidden FROM events WHERE title = 'Ghost Gala'").first();
    expect(ev.hidden).toBe(1);
    expect(await published()).not.toContain("Ghost Gala"); // gone from the visible catalog
    const obs = await t.env.DB.prepare("SELECT status, event_id FROM scrape_observations WHERE payload_json LIKE '%Ghost Gala%'").first();
    expect(obs.status).toBe("contradicted");
    expect(obs.event_id).toBeTruthy(); // still linked, so a human can trace it

    // The four real events are untouched.
    expect(await published()).toHaveLength(4);
  });

  it("does not walk a published event back to merely PENDING", async () => {
    // "We're no longer sure" is not a reason to yank live data — only positive evidence
    // against it is. A second worker who simply hasn't finished must change nothing.
    const core = await join("core", "core");
    const other = await join("other", "probation");
    await work(core.token, [raw(1)], "1.9.2.1");
    expect(await published()).toHaveLength(1);

    // `other` takes a lease and never submits.
    await call(t, "/api/net/lease", { method: "POST", body: { max: 1 }, headers: { authorization: `Bearer ${other.token}`, "cf-connecting-ip": "1.9.2.2" } });
    await work(core.token, [raw(2)], "1.9.2.1"); // some other job settles, re-running consensus

    const row = await t.env.DB.prepare("SELECT status FROM scrape_observations WHERE member_id = ? ORDER BY created_at LIMIT 1").bind(core.userId).first();
    expect(row.status).toBe("published");
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE hidden = 1").first()).n).toBe(0);
  });

  it("derives the key server-side, so a client cannot aim its data at another event", async () => {
    const core = await join("core", "core");
    // A hostile client sends a fingerprint and an id of its own choosing. Neither field
    // exists in RawEvent, so both are simply ignored — the server computes its own.
    const r = await work(core.token, [raw(1, { fingerprint: "deadbeef", id: "hijack", starred: true, hidden: false })], "2.2.2.1");
    expect(r.submitted.json.published).toBe(1);
    const row = await t.env.DB.prepare("SELECT id, fingerprint, starred FROM events").first();
    expect(row.id).not.toBe("hijack");
    expect(row.fingerprint).not.toBe("deadbeef");
    expect(row.starred).toBe(0); // and it could not flag itself as featured
  });

  it("counts a client's repeated listing of one event as one sighting", async () => {
    const core = await join("core", "core");
    const r = await work(core.token, [raw(1), raw(1), raw(1)], "2.2.2.2");
    expect(r.submitted.json.accepted).toBe(1);
    expect(await published()).toHaveLength(1);
  });

  it("skips junk items without failing the submission", async () => {
    const core = await join("core", "core");
    const r = await work(
      core.token,
      [
        raw(1),
        { sourceId: "cv" }, // no title, no url, no date
        raw(2, { startRaw: "not a date" }),
        // No city to resolve, and an address we can confidently place out of region.
        raw(3, { city: "", address: "500 Main St, Austin, TX 78701" }),
      ],
      "2.2.2.3",
    );
    expect(r.submitted.status).toBe(200);
    expect(r.submitted.json.accepted).toBe(1);
    expect(r.submitted.json.rejected).toBe(3);
  });

  it("reports a client-digest mismatch as information, never as an accusation", async () => {
    const core = await join("core", "core");
    const leased = await call(t, "/api/net/lease", {
      method: "POST",
      body: { max: 1 },
      headers: { authorization: `Bearer ${core.token}` },
    });
    const r = await call(t, "/api/net/submit", {
      method: "POST",
      body: { leaseId: leased.json.leases[0].leaseId, items: [raw(1)], digest: "a-wrong-digest" },
      headers: { authorization: `Bearer ${core.token}` },
    });
    expect(r.status).toBe(200); // accepted anyway
    expect(r.json.digestMatches).toBe(false);
    expect(r.json.published).toBe(1);
    // And the real digest is the server's, computed from its own keys.
    expect(r.json.digest).toBe(observationDigest([itemKey({ sourceId: "cv", externalId: "evt-1" }, "unused")]));
  });

  it("refuses a submission against somebody else's lease", async () => {
    const ann = await join("ann", "probation");
    const bob = await join("bob", "probation");
    const leased = await call(t, "/api/net/lease", {
      method: "POST",
      body: { max: 1 },
      headers: { authorization: `Bearer ${ann.token}`, "cf-connecting-ip": "6.6.6.1" },
    });
    const stolen = await call(t, "/api/net/submit", {
      method: "POST",
      body: { leaseId: leased.json.leases[0].leaseId, items: [raw(1)] },
      headers: { authorization: `Bearer ${bob.token}`, "cf-connecting-ip": "6.6.6.2" },
    });
    expect(stolen.status).toBe(404);
  });

  it("refuses a second submission on the same lease", async () => {
    const core = await join("core", "core");
    const first = await work(core.token, [raw(1)], "6.6.6.3");
    const again = await call(t, "/api/net/submit", {
      method: "POST",
      body: { leaseId: first.lease.leaseId, items: [raw(2)] },
      headers: { authorization: `Bearer ${core.token}`, "cf-connecting-ip": "6.6.6.3" },
    });
    expect(again.status).toBe(409);
    expect(again.json.reason).toBe("settled");
  });

  it("refuses a submission on an expired lease", async () => {
    const core = await join("core", "core");
    const leased = await call(t, "/api/net/lease", {
      method: "POST",
      body: { max: 1 },
      headers: { authorization: `Bearer ${core.token}` },
    });
    const id = leased.json.leases[0].leaseId;
    await t.env.DB.prepare("UPDATE scrape_leases SET expires_at = ? WHERE id = ?").bind(iso(T0), id).run();
    const r = await call(t, "/api/net/submit", {
      method: "POST",
      body: { leaseId: id, items: [raw(1)] },
      headers: { authorization: `Bearer ${core.token}` },
    });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("expired");
  });

  it("holds a quarantined member's pending work without deleting or publishing it", async () => {
    const ann = await join("ann", "probation");
    await work(ann.token, [raw(1), raw(2)], "1.2.3.4");

    const { held } = await net.quarantineMember(ann.userId);
    expect(held).toBe(2);
    const rows = await t.env.DB.prepare("SELECT status FROM scrape_observations").all();
    expect((rows.results as any[]).every((r) => r.status === "quarantined")).toBe(true);
    expect(await published()).toEqual([]);
    // Nothing was destroyed — the payloads are still there for a human to look at.
    const n = await t.env.DB.prepare("SELECT COUNT(*) AS n FROM scrape_observations WHERE payload_json <> ''").first();
    expect(n.n).toBe(2);

    // And they get no more work until a human clears it.
    const after = await call(t, "/api/net/lease", { method: "POST", body: { max: 1 }, headers: { authorization: `Bearer ${ann.token}` } });
    expect(after.status).toBe(403);
  });

  it("records receipts against the lease that reported them", async () => {
    const core = await join("core", "core");
    const leased = await call(t, "/api/net/lease", {
      method: "POST",
      body: { max: 1 },
      headers: { authorization: `Bearer ${core.token}` },
    });
    await call(t, "/api/net/submit", {
      method: "POST",
      body: {
        leaseId: leased.json.leases[0].leaseId,
        items: [raw(1)],
        receipts: [{ url: "https://api.cerebralvalley.ai/v1/x", status: 200, bytes: 8123, serverDate: "Sun, 26 Jul 2026 12:00:00 GMT", elapsedMs: 240 }],
      },
      headers: { authorization: `Bearer ${core.token}` },
    });
    const rec = await t.env.DB.prepare("SELECT url, status, bytes FROM scrape_receipts").first();
    expect(rec.status).toBe(200);
    expect(rec.bytes).toBe(8123);
  });

  it("never accepts work from a revoked client, even mid-session", async () => {
    const core = await join("core", "core");
    const leased = await call(t, "/api/net/lease", {
      method: "POST",
      body: { max: 1 },
      headers: { authorization: `Bearer ${core.token}` },
    });
    await t.env.DB.prepare("UPDATE worker_clients SET revoked_at = ? WHERE token_hash = ?").bind(iso(T0), await hashSecret(core.token)).run();
    const r = await call(t, "/api/net/submit", {
      method: "POST",
      body: { leaseId: leased.json.leases[0].leaseId, items: [raw(1)] },
      headers: { authorization: `Bearer ${core.token}` },
    });
    expect(r.status).toBe(401);
    expect(await published()).toEqual([]);
  });
});
