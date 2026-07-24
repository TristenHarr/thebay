import type { CategoryDef } from "../core/models/category";
import { CATCH_ALL_CATEGORY } from "../core/models/category";
import type { Tagger, TaggableEvent, TagResult } from "./tagger";

/**
 * Zero-dependency heuristic tagger. Runs when there's no OpenRouter key, and
 * also as the fallback when an AI batch fails. Never leaves an event untagged.
 */
export class KeywordTagger implements Tagger {
  readonly name = "keyword" as const;
  private interestIds: Set<string>;

  constructor(private categories: CategoryDef[]) {
    this.interestIds = new Set(
      categories.map((c) => c.id).filter((id) => id !== CATCH_ALL_CATEGORY),
    );
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
    for (const cat of this.categories) {
      for (const kw of cat.keywords) {
        if (kw && text.includes(kw.toLowerCase())) {
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
