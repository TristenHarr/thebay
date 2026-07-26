import type { CategoryDef } from "../core/models/category";
import { CATCH_ALL_CATEGORY } from "../core/models/category";
import type { Tagger, TaggableEvent, TagResult } from "./tagger";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Match a keyword only as a whole token — bounded by non-alphanumerics — so "ai"
 *  hits "AI dinner" but never "em[ai]l"/"ch[ai]r", and "c++"/"k8s" still work. */
const boundedRe = (kw: string) => new RegExp(`(?<![a-z0-9])${escapeRegExp(kw.toLowerCase())}(?![a-z0-9])`, "i");

interface CompiledCategory {
  id: string;
  matchers: RegExp[];
}

/**
 * Zero-dependency heuristic tagger. Runs when there's no OpenRouter key, and
 * also as the fallback when an AI batch fails. Never leaves an event untagged.
 * Keywords match on WORD BOUNDARIES (not substrings) so short tokens like "ai",
 * "ml", "vc" don't false-tag "email", "html", "service".
 */
export class KeywordTagger implements Tagger {
  readonly name = "keyword" as const;
  private interestIds: Set<string>;
  private compiled: CompiledCategory[];

  constructor(private categories: CategoryDef[]) {
    this.interestIds = new Set(
      categories.map((c) => c.id).filter((id) => id !== CATCH_ALL_CATEGORY),
    );
    this.compiled = categories.map((c) => ({
      id: c.id,
      matchers: (c.keywords ?? []).filter(Boolean).map(boundedRe),
    }));
  }

  async tag(events: TaggableEvent[]): Promise<TagResult[]> {
    return events.map((e) => this.tagOne(e));
  }

  private tagOne(e: TaggableEvent): TagResult {
    const text = [e.title, e.description, e.organizer]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const matched = new Set<string>();
    let totalHits = 0;
    for (const cat of this.compiled) {
      for (const re of cat.matchers) {
        if (re.test(text)) {
          matched.add(cat.id);
          totalHits++;
        }
      }
    }

    const interest = [...matched].filter((c) => this.interestIds.has(c)).length;
    let score: number;
    if (interest > 0) {
      score = Math.min(100, 30 + 20 * interest + Math.min(totalHits, 6) * 3);
    } else if (matched.size > 0) {
      score = 25;
    } else {
      score = 10;
    }

    const categories = matched.size ? [...matched] : [CATCH_ALL_CATEGORY];
    const reason = matched.size
      ? `keyword match: ${categories.join(", ")}`
      : "no strong keyword signal";
    return { id: e.id, categories, interestScore: score, reason };
  }
}
