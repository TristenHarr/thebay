/**
 * Claude proposing scraper improvements — the "agents self-improve them" half.
 *
 * The safety of letting a model touch the scrapers rests entirely on where it sits in the
 * pipeline: it only ever produces a CANDIDATE recipe, which is `{ type, params }` for an
 * adapter that already exists, and that candidate then has to survive the same shadow audit
 * a human's proposal does (src/core/scrape/audit.ts). The model proposes; code decides.
 *
 * So there is no prompt-injection path to running anything: the output is validated against
 * `RecipeProposalSchema`, then against the adapter's own `parseParams`, then against
 * `recipeHost`, and a candidate that survives all three still only earns a shadow trial. The
 * worst a bad suggestion can do is waste some shadow lease slots and get rejected.
 *
 * Where this earns its keep: a site changes its field names, yield collapses to near zero, and
 * a model that can see a sample of the actual payload alongside the current field mapping is
 * genuinely good at spotting that `startDateTime` became `starts_at`. That is a boring,
 * mechanical fix that would otherwise wait for a human to notice.
 */
import { z } from "zod";
import { completeJson, type KvLike, type ModelConfig } from "./json-llm";
import type { ChatMsg } from "./llm";
import { hasAdapter, getAdapter } from "../sources/registry";
import { recipeHost } from "../core/scrape/host";

/** What we let the model return. Deliberately narrow: params and a reason, nothing else. */
const ProposalSchema = z.object({
  params: z.record(z.string(), z.unknown()),
  reason: z.string().max(400),
  confidence: z.number().min(0).max(1).optional(),
});

export interface ProposalInput {
  sourceId: string;
  /** The adapter type. The model may not change it — a type change is a different source. */
  type: string;
  /** What's live now. */
  currentParams: Record<string, unknown>;
  /** How badly it's doing, so the model knows what it's being asked to fix. */
  symptom: string;
  /** A trimmed sample of the payload the source actually returns. */
  sample: unknown;
}

export interface Proposal {
  sourceId: string;
  type: string;
  params: Record<string, unknown>;
  host: string;
  reason: string;
  confidence: number;
}

/** Keep the prompt (and the bill) bounded — a sample is for spotting field names, not for
 *  reading the whole feed. */
export function trimSample(sample: unknown, maxChars = 4000): string {
  let text: string;
  try {
    // One or two items is plenty to see the shape; a hundred is just tokens.
    const arr = Array.isArray(sample) ? sample.slice(0, 2) : sample;
    text = JSON.stringify(arr, null, 1);
  } catch {
    text = String(sample);
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…truncated` : text;
}

export function buildMessages(input: ProposalInput): ChatMsg[] {
  return [
    {
      role: "system",
      content:
        "You fix event-scraper configurations. You are given an adapter type, the params currently in use, " +
        "a symptom, and a sample of the payload the source really returns. Reply with JSON only: " +
        '{"params": {...}, "reason": "...", "confidence": 0..1}. ' +
        "`params` must be a complete replacement for the current params, same adapter type. " +
        "Change only what the sample shows is wrong — dot-paths in fieldMap must match the sample's actual keys. " +
        "Never add pagination, higher limits, or extra URLs unless the symptom is missing coverage; we are a polite " +
        "guest on these sites. If the sample does not show what is wrong, return the current params unchanged with " +
        "a low confidence.",
    },
    {
      role: "user",
      content: [
        `source: ${input.sourceId}`,
        `adapter type: ${input.type}`,
        `symptom: ${input.symptom}`,
        `current params: ${JSON.stringify(input.currentParams)}`,
        `payload sample:`,
        trimSample(input.sample),
      ].join("\n"),
    },
  ];
}

/**
 * Ask for a better recipe. Returns null on anything doubtful — no model, no reply, a reply
 * that fails the schema, params the adapter rejects, an unplaceable host, or a proposal
 * identical to what's already live. Null is the common case and costs nothing: the incumbent
 * simply keeps running.
 */
export async function proposeRecipe(
  input: ProposalInput,
  cfg: ModelConfig,
  opts: { cache?: KvLike | null; minConfidence?: number } = {},
): Promise<Proposal | null> {
  // A type we don't have an adapter for could never be scheduled, so don't spend a call.
  if (!hasAdapter(input.type)) return null;

  const raw = await completeJson(buildMessages(input), cfg, {
    schema: ProposalSchema,
    maxTokens: 900,
    cache: opts.cache ?? null,
    // Same params for the same symptom is the same answer; caching keeps a daily cron from
    // re-paying for a source nobody has changed.
    cacheTtlSec: 6 * 3600,
  }).catch(() => null);
  if (!raw) return null;

  const confidence = raw.confidence ?? 0.5;
  if (confidence < (opts.minConfidence ?? 0.4)) return null;

  // The same three validations the HTTP proposal route applies, for the same reasons. A
  // model's output gets no more trust than a stranger's.
  try {
    getAdapter(input.type).parseParams(raw.params);
  } catch {
    return null;
  }
  const host = recipeHost(input.type, raw.params);
  if (!host) return null;

  // Nothing changed — proposing it would burn a shadow slot to re-prove the status quo.
  if (JSON.stringify(sortKeys(raw.params)) === JSON.stringify(sortKeys(input.currentParams))) return null;

  return { sourceId: input.sourceId, type: input.type, params: raw.params, host, reason: raw.reason, confidence };
}

/** Stable key order, so "same params" isn't decided by how the JSON happened to be built. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}

/**
 * Which sources look broken enough to be worth asking about.
 *
 * "Broken" is deliberately about a DROP rather than a low absolute number: plenty of sources
 * legitimately return two events a week, and a threshold on volume would have us endlessly
 * re-proposing recipes for small calendars that are working fine.
 */
export function looksBroken(stats: { confirmed: number; windows: number }, baseline: { confirmed: number; windows: number }): string | null {
  const rate = (s: { confirmed: number; windows: number }) => (s.windows > 0 ? s.confirmed / s.windows : 0);
  const now = rate(stats);
  const was = rate(baseline);
  if (stats.windows < 3) return null; // not enough to call it
  if (was > 0 && now === 0) return `found nothing across ${stats.windows} windows, having previously averaged ${was.toFixed(1)} per window`;
  if (was >= 2 && now < was * 0.4) return `yield fell from ${was.toFixed(1)} to ${now.toFixed(1)} events per window`;
  return null;
}
