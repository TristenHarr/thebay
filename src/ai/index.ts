import { env, aiEnabled } from "../config/env";
import type { CategoryDef } from "../core/models/category";
import type { Logger } from "../util/logger";
import { KeywordTagger } from "./keyword-tagger";
import { OpenRouterTagger } from "./openrouter";
import type { Tagger } from "./tagger";

/** Pick the AI tagger if a key is configured, else the keyword tagger. */
export function createTagger(categories: CategoryDef[], logger: Logger): Tagger {
  const keyword = new KeywordTagger(categories);
  if (!aiEnabled()) return keyword;
  return new OpenRouterTagger(categories, {
    apiKey: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_MODEL,
    batchSize: env.AI_BATCH_SIZE,
    fallback: keyword,
    logger,
  });
}

export type { Tagger, TaggableEvent, TagResult } from "./tagger";
