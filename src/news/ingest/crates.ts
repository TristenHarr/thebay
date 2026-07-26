/**
 * crates.io — what's shipping in the Rust ecosystem.
 *
 * Two different signals from one endpoint, and they need different bars:
 *
 *  - `just_updated` is real projects publishing a new version. Good signal, but
 *    it includes long-tail crates nobody uses, so it's gated on downloads.
 *  - `new_crates` is a firehose. A brand-new crate has zero downloads by
 *    definition, so downloads can't gate it; a real description can. Most of
 *    what this filters out is `v0.1.0` placeholders with a one-line stub.
 *
 * `most_downloaded` / `most_recently_downloaded` are deliberately NOT used:
 * they return syn, hashbrown and windows-sys every single run. Enormously
 * popular is not the same as newsworthy.
 *
 * Keyless. crates.io asks for a User-Agent that identifies the client and a
 * contact address. https://crates.io/policies
 */
import type { IngestedStory } from "./types";
import { isUsable } from "./types";

export const SUMMARY_URL = "https://crates.io/api/v1/summary";
const UA = "thebay.news aggregator contact@thebay.news";

/** A just-updated crate needs this many downloads to count as news. */
export const MIN_DOWNLOADS = 500;
/** A brand-new crate needs a description with actual content in it. */
export const MIN_NEW_DESCRIPTION = 40;
/** Per run, across both lists. */
export const MAX_CRATES = 10;

/**
 * Projects we follow regardless of popularity, by crate-name prefix.
 *
 * A young project never clears a downloads bar — that's the point of the bar —
 * so following one has to be an explicit decision rather than something the
 * ranking can discover.
 */
export const WATCHED: { prefix: string; label: string; topics: string[] }[] = [
  { prefix: "logicaffeine", label: "Logicaffeine / LOGOS", topics: ["software", "math"] },
];

/* eslint-disable @typescript-eslint/no-explicit-any */
interface CrateRow {
  name: string;
  newest_version?: string;
  max_version?: string;
  description?: string | null;
  downloads?: number;
  updated_at?: string;
  created_at?: string;
}

const version = (c: CrateRow) => String(c.newest_version ?? c.max_version ?? "").trim();
const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

function toStory(c: CrateRow, topics: string[], when?: string): Partial<IngestedStory> {
  const v = version(c);
  const desc = clean(c.description);
  return {
    origin: "crates",
    // Version-scoped, so each release is its own story and re-running the
    // harvest never re-posts one we already have.
    externalId: `crates:${c.name}@${v}`,
    title: (desc ? `${c.name} v${v} — ${desc}` : `${c.name} v${v}`).slice(0, 200),
    // Per-version permalink: a bare /crates/<name> URL is the same string for
    // every release, and dedup is by url_hash — so every future version would
    // silently merge into the first story instead of being its own.
    url: `https://crates.io/crates/${encodeURIComponent(c.name)}/${encodeURIComponent(v)}`,
    externalUrl: null,
    // Deliberately not download counts. Those reach the billions and would be
    // sqrt-weighted into the ranking, where one popular crate outscores
    // everything a human wrote.
    points: null,
    comments: null,
    createdAt: (() => {
      const t = when ?? c.updated_at ?? c.created_at;
      return t && Number.isFinite(Date.parse(t)) ? new Date(t).toISOString() : new Date().toISOString();
    })(),
    author: null,
    topics,
  };
}

export function parseSummary(payload: any): IngestedStory[] {
  const out: IngestedStory[] = [];
  const seen = new Set<string>();

  const push = (c: CrateRow) => {
    const s = toStory(c, ["software"]);
    if (!s.externalId || seen.has(s.externalId)) return;
    seen.add(s.externalId);
    if (isUsable(s)) out.push(s);
  };

  for (const c of (payload?.just_updated ?? []) as CrateRow[]) {
    if (!version(c) || !clean(c.description)) continue;
    if ((c.downloads ?? 0) < MIN_DOWNLOADS) continue;
    push(c);
  }
  for (const c of (payload?.new_crates ?? []) as CrateRow[]) {
    if (!version(c)) continue;
    if (clean(c.description).length < MIN_NEW_DESCRIPTION) continue;
    push(c);
  }
  return out.slice(0, MAX_CRATES);
}

export function searchUrlFor(prefix: string): string {
  return `https://crates.io/api/v1/crates?q=${encodeURIComponent(prefix)}&per_page=30&sort=recent-update`;
}

/**
 * A watched project, collapsed to ONE story per version.
 *
 * Logicaffeine publishes fifteen crates — base, cli, compile, data, forge, jit,
 * kernel, language … — and they all move to the same version together. Treated
 * as ordinary crates that's fifteen near-identical front-page rows for a single
 * release, which is how a followed project turns into spam. One row per version
 * says the true thing: the project shipped.
 */
export function collapseWatched(payload: any, w: (typeof WATCHED)[number]): IngestedStory[] {
  const crates = ((payload?.crates ?? []) as CrateRow[]).filter((c) =>
    String(c.name ?? "").toLowerCase().startsWith(w.prefix.toLowerCase()),
  );
  if (!crates.length) return [];

  // Group by version so an in-progress rollout (some crates already bumped)
  // doesn't produce a story that claims more than actually shipped.
  const byVersion = new Map<string, CrateRow[]>();
  for (const c of crates) {
    const v = version(c);
    if (!v) continue;
    byVersion.set(v, [...(byVersion.get(v) ?? []), c]);
  }

  const out: IngestedStory[] = [];
  for (const [v, group] of byVersion) {
    const newest = group
      .map((c) => c.updated_at ?? c.created_at)
      .filter(Boolean)
      .sort()
      .pop();
    // Link the shortest-named crate of the group — the closest thing the
    // project has to a root package — at this exact version.
    const primary = [...group].sort((a, b) => a.name.length - b.name.length)[0]!;
    const desc = clean(group.map((c) => c.description).find(Boolean));
    const n = group.length;

    const candidate: Partial<IngestedStory> = {
      origin: "crates",
      externalId: `crates-project:${w.prefix}@${v}`,
      title: (n > 1
        ? `${w.label} v${v} — ${n} crates published${desc ? `: ${desc}` : ""}`
        : `${w.label} v${v}${desc ? ` — ${desc}` : ""}`
      ).slice(0, 200),
      url: `https://crates.io/crates/${encodeURIComponent(primary.name)}/${encodeURIComponent(v)}`,
      externalUrl: null,
      points: null,
      comments: null,
      createdAt:
        newest && Number.isFinite(Date.parse(newest)) ? new Date(newest).toISOString() : new Date().toISOString(),
      author: null,
      topics: w.topics,
    };
    if (isUsable(candidate)) out.push(candidate);
  }
  // Newest version first, and only the most recent couple — a first harvest
  // shouldn't backfill a project's entire release history onto the front page.
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 2);
}

export async function fetchCrates(fetchImpl: typeof fetch = fetch): Promise<IngestedStory[]> {
  const headers = { accept: "application/json", "user-agent": UA };
  const out: IngestedStory[] = [];

  const res = await fetchImpl(SUMMARY_URL, { headers });
  if (!res.ok) throw new Error(`crates ${res.status}`);
  out.push(...parseSummary(await res.json()));

  // Watched projects are additive and best-effort: one of them being
  // unreachable must not lose the general harvest we already have in hand.
  for (const w of WATCHED) {
    try {
      const r = await fetchImpl(searchUrlFor(w.prefix), { headers });
      if (!r.ok) continue;
      out.push(...collapseWatched(await r.json(), w));
    } catch {
      continue;
    }
  }
  return out;
}
