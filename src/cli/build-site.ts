import { parseArgs } from "node:util";
import { cpSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createRepository } from "../storage";
import { loadCategories, loadCities } from "../config/load";
import type { CanonicalEvent } from "../core/models/event";

const PUBLIC = resolve(process.cwd(), "src/server/public");

/** Trim a stored event to just the fields the client needs (keeps the JSON small). */
function slim(e: CanonicalEvent) {
  return {
    id: e.id,
    title: e.title,
    url: e.url,
    startUtc: e.startUtc,
    endUtc: e.endUtc,
    timezone: e.timezone,
    venueName: e.venueName,
    address: e.address,
    city: e.city,
    organizer: e.organizer,
    isFree: e.isFree,
    priceText: e.priceText,
    imageUrl: e.imageUrl,
    categories: e.categories,
    interestScore: e.interestScore,
    sources: (e.sources || []).map((s) => ({ sourceId: s.sourceId, sourceType: s.sourceType })),
    firstSeenAt: e.firstSeenAt,
    description: e.description ? e.description.slice(0, 300) : null,
  };
}

/** Build a fully static site (dashboard + widget + events.json) into dist/site/. */
export async function buildSiteCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: "string" } },
    allowPositionals: true,
  });
  const outDir = resolve(process.cwd(), (values.out as string) || "dist/site");

  // Curators: human-curated source lists get attribution + a ✦ badge, linking back.
  let curators: Array<{ sourceId: string; name: string; url?: string; substack?: string; blurb?: string }> = [];
  try {
    curators = JSON.parse(readFileSync(resolve(process.cwd(), "config/curators.json"), "utf8"));
  } catch {
    /* optional */
  }
  const curatorOf = (ev: CanonicalEvent) =>
    curators
      .filter((c) => (ev.sources || []).some((s) => s.sourceId === c.sourceId))
      .map((c) => ({ name: c.name, url: c.url }));

  const DAY = 86_400_000;
  // Horizon guard: some sources carry test/placeholder rows dated absurdly far out
  // (e.g. "Reserved Seating Demo" in 2121). Keep real far-future conferences (~2yr)
  // but drop the junk so they don't skew the feed or the "latest event" line.
  const HORIZON = new Date(Date.now() + 730 * DAY).toISOString();
  const nowIso = new Date(Date.now() - 6 * 3600 * 1000).toISOString();

  type ArchiveRow = ReturnType<typeof slim> & { curatedBy: ReturnType<typeof curatorOf> };
  const ARCHIVE_CAP = 300;
  const repo = createRepository();
  let events;
  let curatedArchive: ArchiveRow[];
  let curatedArchiveTotal = 0;
  let sources;
  try {
    const res = await repo.queryEvents({
      from: nowIso,
      to: HORIZON,
      includeHidden: true,
      limit: 100_000,
      sort: "start",
    });
    events = res.events.map((e) => {
      const cur = curatorOf(e);
      return cur.length ? { ...slim(e), curatedBy: cur } : slim(e);
    });

    // Curator archive — a curator's *past* picks. They're real events the curator
    // vouched for that have simply already happened; we surface them as a clearly
    // labeled archive (linking back), kept OUT of the upcoming feed. The moment a
    // curator adds future-dated picks, those flow into `events` above instead and
    // the archive quietly steps aside.
    const curatorSourceIds = curators.map((c) => c.sourceId);
    if (curatorSourceIds.length) {
      const arch = await repo.queryEvents({
        from: new Date(Date.now() - 400 * DAY).toISOString(),
        to: nowIso, // strictly before "now" → past only
        sources: curatorSourceIds,
        includeHidden: true,
        limit: 100_000,
        sort: "start",
      });
      const all = arch.events
        .map((e) => ({ ...slim(e), curatedBy: curatorOf(e) }))
        .filter((e) => e.curatedBy.length)
        .sort((a, b) => (b.startUtc || "").localeCompare(a.startUtc || "")); // most recent first
      curatedArchiveTotal = all.length;
      // Cap the RENDERED archive for page performance; the full history stays in the
      // curator's newsletter (linked). We keep the most-recent picks.
      curatedArchive = all.slice(0, ARCHIVE_CAP);
    } else {
      curatedArchive = [];
    }

    sources = await repo.listSources();
  } finally {
    repo.close();
  }

  const now = new Date();
  const data = {
    generatedAt: now.toISOString(),
    count: events.length,
    siteUrl: "/",
    api: {
      description: "Free, open, CORS-enabled JSON API of SF Bay Area tech events. No key required.",
      docs: "https://thebay.events/llms.txt",
      license: "Open data — free to use, attribution to thebay.events appreciated.",
    },
    events,
    curators: curators.map((c) => ({
      name: c.name,
      url: c.url,
      substack: c.substack,
      blurb: c.blurb,
      // how many of this curator's picks are upcoming (in the feed) vs. archived (past)
      count: events.filter((e) => "curatedBy" in e && e.curatedBy?.some((x) => x.name === c.name)).length,
      archiveCount: curatedArchive.filter((e) => e.curatedBy.some((x) => x.name === c.name)).length,
    })),
    curatedArchive,
    curatedArchiveTotal,
    categories: loadCategories().map((c) => ({ id: c.id, label: c.label, color: c.color })),
    cities: loadCities().map((c) => ({ id: c.id, label: c.label })),
    sources: sources.map((s) => ({ id: s.id, type: s.type, enabled: s.enabled, lastStatus: s.lastStatus })),
  };

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(PUBLIC, outDir, { recursive: true });
  writeFileSync(resolve(outDir, "events.json"), JSON.stringify(data));

  // ---- SEO / AI-EO: inject Event structured data into the HTML ----
  const upcoming = events
    .filter((e) => new Date(e.startUtc).getTime() > now.getTime())
    .sort((a, b) => (b.interestScore ?? -1) - (a.interestScore ?? -1))
    .slice(0, 60);
  const graph = upcoming.map((e) => ({
    "@type": "Event",
    name: e.title,
    startDate: e.startUtc,
    ...(e.endUtc ? { endDate: e.endUtc } : {}),
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: "https://schema.org/EventScheduled",
    url: e.url,
    ...(e.description ? { description: e.description.slice(0, 300) } : {}),
    location: {
      "@type": "Place",
      name: e.venueName || (e.city && e.city !== "unknown" ? "SF Bay Area" : "SF Bay Area"),
      address: e.address || "San Francisco Bay Area, CA",
    },
    ...(e.imageUrl ? { image: e.imageUrl } : {}),
    ...(e.isFree === true
      ? { isAccessibleForFree: true, offers: { "@type": "Offer", price: 0, priceCurrency: "USD", availability: "https://schema.org/InStock", url: e.url } }
      : {}),
    ...(e.organizer ? { organizer: { "@type": "Organization", name: e.organizer } } : {}),
  }));
  const ld = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  const htmlPath = resolve(outDir, "index.html");
  const html = readFileSync(htmlPath, "utf8")
    .replace("<!--LD_EVENTS-->", `<script type="application/ld+json">${ld}</script>`)
    // keep the meta description count fresh
    .replace(/content="The most comprehensive, instantly-filterable calendar of SF Bay Area tech events/,
      `content="${events.length.toLocaleString()}+ SF Bay Area tech events, instantly filterable`);
  writeFileSync(htmlPath, html);

  // robots.txt
  writeFileSync(resolve(outDir, "robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: https://thebay.events/sitemap.xml\n`);

  // sitemap.xml
  const today = now.toISOString().slice(0, 10);
  writeFileSync(resolve(outDir, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `  <url><loc>https://thebay.events/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>\n` +
    `  <url><loc>https://thebay.events/embed</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.6</priority></url>\n` +
    `  <url><loc>https://thebay.events/events.json</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>\n` +
    `</urlset>\n`);

  // llms.txt — for AI agents (AI-EO)
  writeFileSync(resolve(outDir, "llms.txt"),
    `# The Bay — SF Bay Area Tech Events\n\n` +
    `> The most comprehensive, filterable calendar of San Francisco Bay Area tech events ` +
    `(AI, hardware, VC / early-stage investors, software, mathematics). Updated daily. Free & open data, no key required.\n\n` +
    `## Free API\n` +
    `- Full dataset (JSON, CORS-enabled): https://thebay.events/events.json\n` +
    `  - Shape: { generatedAt, count, events: [ { id, title, url, startUtc, endUtc, timezone, venueName, address, city, organizer, isFree, priceText, categories, interestScore, sources } ], categories, cities, sources }\n` +
    `  - ${events.length} events. Each event's \`url\` is the canonical registration link. Filter the \`events\` array by \`categories\`, \`startUtc\`, \`city\`, or \`interestScore\`.\n` +
    `- Embeddable widget: https://thebay.events/embed\n\n` +
    `## Categories\n- hardware — hardware, robotics, chips, deep tech\n- vc — venture capital, early-stage investors, founders, demo days\n- math — mathematics\n- software — software, AI/ML, developer\n- tech — general tech (catch-all)\n\n` +
    `## Sources\nScraped daily from Luma, Eventbrite, Partiful, Meetup, Airtable, and university calendars.\n\n` +
    `## Attribution\nData from https://thebay.events — free to use with attribution.\n`);

  // ---- cache-busting: content-hash JS/CSS filenames so redeploys never serve stale ----
  const bust = (file: string): string | null => {
    const p = resolve(outDir, file);
    if (!existsSync(p)) return null;
    const dot = file.lastIndexOf(".");
    const h = createHash("sha1").update(readFileSync(p)).digest("hex").slice(0, 8);
    const hashed = file.slice(0, dot) + "." + h + file.slice(dot);
    renameSync(p, resolve(outDir, hashed));
    return hashed;
  };
  const appHashed = bust("app.js");
  const stylesHashed = bust("styles.css");
  const embedJsHashed = bust("embed.js");
  let idxHtml = readFileSync(htmlPath, "utf8");
  if (appHashed) idxHtml = idxHtml.replace("/app.js", "/" + appHashed);
  if (stylesHashed) idxHtml = idxHtml.replace("/styles.css", "/" + stylesHashed);
  writeFileSync(htmlPath, idxHtml);
  const embedPath = resolve(outDir, "embed.html");
  if (existsSync(embedPath) && embedJsHashed) {
    writeFileSync(embedPath, readFileSync(embedPath, "utf8").replace("/embed.js", "/" + embedJsHashed));
  }

  const mb = (JSON.stringify(data).length / 1024 / 1024).toFixed(1);
  console.log(`Built static site → ${outDir}`);
  console.log(`  ${events.length} events · events.json ${mb} MB · ${graph.length} events in JSON-LD`);
  console.log(`  + robots.txt, sitemap.xml, llms.txt, Event structured data`);
  console.log(`  deploy:  npx wrangler deploy`);
}
