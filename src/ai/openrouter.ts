import pLimit from "p-limit";
import type { CategoryDef } from "../core/models/category";
import { CATCH_ALL_CATEGORY } from "../core/models/category";
import type { Logger } from "../util/logger";
import type { Tagger, TaggableEvent, TagResult } from "./tagger";
import { buildSystemPrompt, buildUserPayload, ResponseSchema } from "./prompt";
import { extractJson } from "./json-llm";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterOpts {
  apiKey: string;
  model: string;
  batchSize: number;
  fallback: Tagger;
  logger: Logger;
  concurrency?: number;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function clamp(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Single source of truth for "get JSON out of a model reply" lives in json-llm;
 *  this tagger wants a throw (the batch then degrades to the keyword fallback). */
function robustJsonParse(content: string): unknown {
  const parsed = extractJson(content);
  if (parsed === null) throw new Error("could not parse JSON from model output");
  return parsed;
}

/**
 * Batched OpenRouter tagger. Cheap-model friendly: compact JSON in/out,
 * temperature 0, concurrency-limited. Any batch failure (or any event the model
 * skips) degrades gracefully to the keyword fallback — nothing is left untagged.
 */
export class OpenRouterTagger implements Tagger {
  readonly name = "ai" as const;
  private knownIds: Set<string>;
  private system: string;

  constructor(
    categories: CategoryDef[],
    private opts: OpenRouterOpts,
  ) {
    this.knownIds = new Set(categories.map((c) => c.id));
    this.system = buildSystemPrompt(categories);
  }

  async tag(events: TaggableEvent[]): Promise<TagResult[]> {
    const batches = chunk(events, Math.max(1, this.opts.batchSize));
    const limit = pLimit(this.opts.concurrency ?? 3);
    const nested = await Promise.all(
      batches.map((b) => limit(() => this.tagBatch(b))),
    );
    return nested.flat();
  }

  private normalizeCats(cats: string[]): string[] {
    const filtered = [...new Set(cats.filter((c) => this.knownIds.has(c)))];
    return filtered.length ? filtered : [CATCH_ALL_CATEGORY];
  }

  private async tagBatch(events: TaggableEvent[]): Promise<TagResult[]> {
    try {
      const content = await this.call(events);
      const parsed = ResponseSchema.parse(robustJsonParse(content));
      const byId = new Map(parsed.results.map((r) => [r.id, r]));
      const out: TagResult[] = [];
      const missing: TaggableEvent[] = [];
      for (const e of events) {
        const r = byId.get(e.id);
        if (!r) {
          missing.push(e);
          continue;
        }
        out.push({
          id: e.id,
          categories: this.normalizeCats(r.categories),
          interestScore: clamp(r.interestScore),
          reason: r.reason || "ai",
        });
      }
      if (missing.length) {
        out.push(...(await this.opts.fallback.tag(missing)));
      }
      return out;
    } catch (err) {
      this.opts.logger.warn(
        { err: (err as Error).message },
        "openrouter batch failed; using keyword fallback",
      );
      return this.opts.fallback.tag(events);
    }
  }

  private async call(events: TaggableEvent[]): Promise<string> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
        "HTTP-Referer": "https://github.com/eventers",
        "X-Title": "Eventers",
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: this.system },
          { role: "user", content: buildUserPayload(events) },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("OpenRouter: empty content");
    return content;
  }
}
