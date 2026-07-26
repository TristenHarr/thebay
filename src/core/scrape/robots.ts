/**
 * robots.txt, parsed. Pure, no I/O — a cron fetches the file, this decides what it means.
 *
 * There is no robots handling anywhere else in this repo, and for one machine scraping
 * on its owner's behalf that was a defensible omission. It stops being defensible the
 * moment fifty volunteers crawl in the project's name: the difference between a
 * distributed crawler and a distributed nuisance is largely whether it reads this file.
 *
 * Implements the parts of RFC 9309 that actually decide things:
 *   · records grouped by `User-agent`, several agents per group allowed;
 *   · the most specific matching agent wins, `*` as the fallback — and once a specific
 *     group matches, `*` is ignored entirely, as the spec requires;
 *   · `Allow` / `Disallow` with LONGEST-MATCH precedence, `Allow` winning exact ties;
 *   · `*` wildcards and `$` end-anchors inside paths;
 *   · an empty `Disallow:` means "allow everything", which is the single most common
 *     way a site says yes and the easiest thing to get backwards;
 *   · `Crawl-delay`, which isn't in the RFC but is how hosts actually ask for room.
 *
 * Deliberately NOT implemented: `Sitemap` (we don't crawl by sitemap) and
 * `Request-rate` (vanishingly rare, and `Crawl-delay` covers the intent).
 *
 * Fail-open on an unparseable file, fail-closed on an explicit rule. A 404 robots.txt
 * means "no restrictions stated" — treating it as deny-all would silently stop the
 * whole network the first time a CDN hiccuped. But a rule we *did* read is obeyed.
 */

export interface RobotsRules {
  /** May we fetch this path? */
  allows(path: string): boolean;
  /** What the host asked for between requests, in ms, or null if it didn't. */
  crawlDelayMs: number | null;
  /** The Disallow patterns that applied to us. */
  disallow: string[];
  /** The Allow patterns that applied to us. Stored alongside, because without them the
   *  extremely common `Disallow: /` + `Allow: /events/` shape reads as a total ban. */
  allow: string[];
}

interface Group {
  agents: string[];
  rules: Array<{ allow: boolean; pattern: string }>;
  crawlDelayMs: number | null;
}

/** Escape everything regex-special except our two wildcards, then translate those. */
function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

/** Rules that never say no. What an absent, empty or broken robots.txt yields. */
export function allowAll(crawlDelayMs: number | null = null): RobotsRules {
  return { allows: () => true, crawlDelayMs, disallow: [], allow: [] };
}

/**
 * Parse `txt` for the agent `ua`. Matching is case-insensitive substring, the way real
 * crawlers are identified: a group for `thebay` matches our full
 * "thebay.news aggregator (+…)" token.
 */
export function parseRobots(txt: string, ua: string): RobotsRules {
  if (typeof txt !== "string" || !txt.trim()) return allowAll();

  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      // Consecutive User-agent lines share one group; a User-agent line after rules
      // starts a new one.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (!current) continue; // a rule before any User-agent line belongs to nobody
    lastWasAgent = false;

    if (field === "disallow") {
      // An empty Disallow is an explicit "everything is fine". Recording it as a
      // pattern would make it match every path and ban the whole site.
      if (value) current.rules.push({ allow: false, pattern: value });
    } else if (field === "allow") {
      if (value) current.rules.push({ allow: true, pattern: value });
    } else if (field === "crawl-delay") {
      const secs = Number(value.replace(",", "."));
      if (Number.isFinite(secs) && secs > 0) current.crawlDelayMs = Math.min(600_000, Math.round(secs * 1000));
    }
  }

  const needle = ua.toLowerCase();
  // Most specific wins: prefer the longest agent token that matches us, and fall back
  // to `*` only if nothing named us. Per the RFC, a specific match means `*` is out.
  let best: Group | null = null;
  let bestLen = -1;
  let star: Group | null = null;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a === "*") {
        star ??= g;
        continue;
      }
      if (needle.includes(a) && a.length > bestLen) {
        best = g;
        bestLen = a.length;
      }
    }
  }
  const group = best ?? star;
  if (!group) return allowAll();
  if (!group.rules.length) return allowAll(group.crawlDelayMs);

  const compiled = group.rules.map((r) => ({ ...r, re: patternToRegExp(r.pattern) }));
  return {
    crawlDelayMs: group.crawlDelayMs,
    disallow: group.rules.filter((r) => !r.allow).map((r) => r.pattern),
    allow: group.rules.filter((r) => r.allow).map((r) => r.pattern),
    allows(path: string): boolean {
      const p = path && path.startsWith("/") ? path : `/${path ?? ""}`;
      let verdict = true;
      let winning = -1;
      for (const r of compiled) {
        if (!r.re.test(p)) continue;
        // Longest match wins; Allow beats Disallow at equal length, which is what makes
        // the common `Disallow: /` + `Allow: /events/` shape work.
        if (r.pattern.length > winning || (r.pattern.length === winning && r.allow)) {
          winning = r.pattern.length;
          verdict = r.allow;
        }
      }
      return verdict;
    },
  };
}

/**
 * Does a host's stored rule set permit this path?
 *
 * The coordinator keeps the resolved rules rather than the file, so it can decide at lease time
 * without re-fetching or re-parsing. It applies the SAME precedence `parseRobots` does —
 * longest match wins, Allow beats Disallow at equal length — because anything less would break
 * the most common shape in the wild: `Disallow: /` rescued by `Allow: /events/`. Seeing only the
 * Disallow half there would read as a total ban and silently stop a source we are welcome on.
 */
export function pathAllowed(disallow: string[], allow: string[], path: string): boolean {
  const dis = Array.isArray(disallow) ? disallow : [];
  const all = Array.isArray(allow) ? allow : [];
  if (!dis.length) return true;
  const p = path && path.startsWith("/") ? path : `/${path ?? ""}`;
  let verdict = true;
  let winning = -1;
  const consider = (pattern: string, isAllow: boolean) => {
    if (typeof pattern !== "string" || !pattern) return;
    if (!patternToRegExp(pattern).test(p)) return;
    if (pattern.length > winning || (pattern.length === winning && isAllow)) {
      winning = pattern.length;
      verdict = isAllow;
    }
  };
  for (const d of dis) consider(d, false);
  for (const a of all) consider(a, true);
  return verdict;
}

/** Path + query of a URL, which is what robots rules match against. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || "");
  } catch {
    return "/";
  }
}
