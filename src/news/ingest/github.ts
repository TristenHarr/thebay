/**
 * GitHub — what people are actually building this week.
 *
 * Uses the official search API rather than scraping the trending page: no key
 * needed, documented, and stable. Unauthenticated search allows 10 requests per
 * minute; a 15-minute cron makes one, so we sit three orders of magnitude inside
 * the limit and never need a token in the Worker.
 *
 * Repos are ranked by stars gained since creation, which is a rough but honest
 * proxy for "new and interesting" rather than "old and famous".
 */
import type { IngestedStory } from "./types";
import { isUsable } from "./types";
import { USER_AGENT } from "./hn";

/** Only repos created recently — otherwise this returns the same giants forever. */
export const LOOKBACK_DAYS = 14;
const MIN_STARS = 50;

export function searchUrl(nowMs: number = Date.now()): string {
  const since = new Date(nowMs - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const q = `created:>${since} stars:>${MIN_STARS}`;
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=25`;
}

/** Map GitHub's language field onto our topic axes. Unmapped → no topic. */
const LANGUAGE_TOPIC: Record<string, string> = {
  verilog: "hardware", vhdl: "hardware", c: "hardware", "c++": "software", rust: "software",
  go: "software", typescript: "software", javascript: "software", python: "software",
  zig: "software", ocaml: "software", haskell: "math", lean: "math", coq: "math", julia: "math",
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseGithub(payload: any): IngestedStory[] {
  const items: any[] = Array.isArray(payload?.items) ? payload.items : [];
  const out: IngestedStory[] = [];
  for (const r of items) {
    const fullName = String(r?.full_name ?? "");
    const desc = String(r?.description ?? "").trim();
    if (!fullName) continue;

    // The description carries the signal; the repo name alone is often opaque.
    const title = desc ? `${fullName} — ${desc}`.slice(0, 200) : fullName;
    const lang = String(r?.language ?? "").toLowerCase();
    const topics = new Set<string>();
    if (LANGUAGE_TOPIC[lang]) topics.add(LANGUAGE_TOPIC[lang]!);
    for (const t of Array.isArray(r?.topics) ? r.topics : []) {
      const s = String(t).toLowerCase();
      if (/hardware|fpga|embedded|robot|chip/.test(s)) topics.add("hardware");
      if (/math|theorem|proof/.test(s)) topics.add("math");
    }
    if (!topics.size) topics.add("software");

    const candidate: Partial<IngestedStory> = {
      origin: "github",
      externalId: String(r?.id ?? fullName),
      title,
      url: typeof r?.html_url === "string" ? r.html_url : null,
      externalUrl: null, // the repo IS the destination; there's no separate thread
      points: Number.isFinite(r?.stargazers_count) ? r.stargazers_count : null,
      comments: Number.isFinite(r?.open_issues_count) ? r.open_issues_count : null,
      createdAt: r?.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      author: r?.owner?.login ? String(r.owner.login) : null,
      topics: [...topics],
    };
    if (isUsable(candidate)) out.push(candidate);
  }
  return out;
}

export async function fetchGithub(fetchImpl: typeof fetch = fetch, nowMs: number = Date.now()): Promise<IngestedStory[]> {
  const res = await fetchImpl(searchUrl(nowMs), {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": USER_AGENT,
    },
  });
  if (!res.ok) throw new Error(`github ${res.status}`);
  return parseGithub(await res.json());
}
