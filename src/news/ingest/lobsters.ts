/**
 * Lobste.rs, via its public JSON endpoints. Their tags map cleanly onto our topic
 * axes, so we carry them across instead of re-deriving topics.
 */
import type { IngestedStory } from "./types";
import { isUsable } from "./types";
import { USER_AGENT } from "./hn";

export const LOBSTERS_HOTTEST = "https://lobste.rs/hottest.json";

/** Their tag vocabulary → our four axes. Unmapped tags are simply dropped. */
const TAG_TO_TOPIC: Record<string, string> = {
  hardware: "hardware", electronics: "hardware", embedded: "hardware", chip: "hardware",
  math: "math", compsci: "math", formalmethods: "math",
  programming: "software", software: "software", compilers: "software", distributed: "software",
  rust: "software", go: "software", python: "software", c: "software", javascript: "software",
  ai: "software", ml: "software", databases: "software", devops: "software", security: "software",
  business: "vc", finance: "vc",
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseLobsters(payload: any): IngestedStory[] {
  const rows: any[] = Array.isArray(payload) ? payload : [];
  const out: IngestedStory[] = [];
  for (const r of rows) {
    const externalId = String(r?.short_id ?? "");
    const url = typeof r?.url === "string" && r.url ? r.url : null;
    const topics = Array.from(
      new Set((Array.isArray(r?.tags) ? r.tags : []).map((t: any) => TAG_TO_TOPIC[String(t).toLowerCase()]).filter(Boolean)),
    ) as string[];
    const candidate: Partial<IngestedStory> = {
      origin: "lobsters",
      externalId,
      title: String(r?.title ?? "").trim(),
      url,
      externalUrl: typeof r?.comments_url === "string" ? r.comments_url : null,
      points: Number.isFinite(r?.score) ? r.score : null,
      comments: Number.isFinite(r?.comment_count) ? r.comment_count : null,
      createdAt: r?.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      author: r?.submitter_user ? String(r.submitter_user?.username ?? r.submitter_user) : null,
      topics,
    };
    if (isUsable(candidate)) out.push(candidate);
  }
  return out;
}

export async function fetchLobsters(fetchImpl: typeof fetch = fetch): Promise<IngestedStory[]> {
  const res = await fetchImpl(LOBSTERS_HOTTEST, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`lobsters ${res.status}`);
  return parseLobsters(await res.json());
}
