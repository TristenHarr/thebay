/**
 * Structured LLM calls — the shared spine for every AI feature that needs data
 * back rather than prose (event tagging, vibe prediction, query understanding,
 * identity-match ranking).
 *
 * Layers four things onto `chatComplete`:
 *   - **Strict JSON**, validated against a caller-supplied zod schema. The model
 *     never gets to widen a type.
 *   - **A KV response cache** keyed by (model, messages). Query understanding hits
 *     the same phrasings constantly; this is what makes per-search LLM cost ~zero.
 *   - **A daily spend guard.** A runaway loop is a billing incident, not a bug, so
 *     the ceiling is enforced here rather than trusted to call sites.
 *   - **A timeout.** A slow model must degrade, never hold a request open.
 *
 * Returns `null` on ANY failure — unparseable output, schema mismatch, timeout,
 * budget exhausted, no model configured. Every caller is therefore required to
 * have a deterministic path. That is the house rule this codebase already runs on
 * (`OpenRouterTagger` → `KeywordTagger`, `summarize` → `fallbackSummary`): the
 * model adds quality, never availability.
 */
import type { z } from "zod";
import { chatComplete, type ChatMsg, type LlmEnv } from "./llm";
import { hash128 } from "../core/util/hash";

/** The slice of KVNamespace we use. Narrow so tests can pass a Map-backed stub. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/** Which model to call and with whose key. Passed in, never read from ambient
 *  config — that's what makes this usable from the Worker as well as the CLI. */
export interface ModelConfig {
  openrouterKey?: string | null;
  model?: string | null;
  env?: LlmEnv;
}

/**
 * A coarse daily ceiling on model spend. This is a runaway-loop guard, not
 * accounting: we count calls and multiply by a flat per-call estimate rather than
 * reading real token usage, because the only decision it drives is "stop".
 */
export interface BudgetGuard {
  kv: KvLike;
  dailyUsd: number;
  /** Flat per-call estimate. Default is deliberately pessimistic. */
  costPerCallUsd?: number;
  /** YYYY-MM-DD. Injected so budget rollover is testable without faking a clock. */
  today?: string;
}

export interface JsonOpts<T> {
  schema: z.ZodType<T>;
  maxTokens?: number;
  timeoutMs?: number;
  cache?: KvLike | null;
  cacheTtlSec?: number;
  budget?: BudgetGuard | null;
  /** Skip the cache read but still write. Used by admin "force re-enrich". */
  refresh?: boolean;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_SEC = 30 * 24 * 3600;
const DEFAULT_COST_PER_CALL_USD = 0.002;

/**
 * Pull the first JSON value out of a model reply. Cheap models fence their output
 * or bolt on a sentence of preamble even when told not to, so this strips ``` fences
 * and falls back to the outermost {...} / [...] span. Returns null rather than
 * throwing — callers here always have a deterministic path.
 */
export function extractJson(raw: string | null): unknown | null {
  if (!raw) return null;
  const stripped = raw
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  if (!stripped) return null;
  try {
    return JSON.parse(stripped);
  } catch {
    /* fall through to span extraction */
  }
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const a = stripped.indexOf(open);
    const b = stripped.lastIndexOf(close);
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(stripped.slice(a, b + 1));
      } catch {
        /* try the next bracket style */
      }
    }
  }
  return null;
}

/** Stable cache key. Model is part of it so switching models can't serve stale
 *  output shaped by the old one. */
export function cacheKey(model: string | null | undefined, messages: ChatMsg[]): string {
  const body = messages.map((m) => `${m.role}:${m.content}`).join("\n\x00\n");
  return `llm:${hash128(`${model ?? "default"}\x00${body}`)}`;
}

/** `true` when today's estimated spend is already at or over the ceiling. */
async function overBudget(b: BudgetGuard): Promise<boolean> {
  const day = b.today ?? new Date().toISOString().slice(0, 10);
  const raw = await b.kv.get(`llm:spend:${day}`).catch(() => null);
  const calls = Number(raw ?? 0);
  if (!Number.isFinite(calls)) return false;
  const per = b.costPerCallUsd ?? DEFAULT_COST_PER_CALL_USD;
  return calls * per >= b.dailyUsd;
}

async function recordCall(b: BudgetGuard): Promise<void> {
  const day = b.today ?? new Date().toISOString().slice(0, 10);
  const key = `llm:spend:${day}`;
  const raw = await b.kv.get(key).catch(() => null);
  const next = (Number(raw ?? 0) || 0) + 1;
  // 48h TTL: long enough to survive UTC rollover skew, short enough to self-clean.
  await b.kv.put(key, String(next), { expirationTtl: 48 * 3600 }).catch(() => {});
}

/**
 * Ask a model for JSON matching `schema`. Returns null if anything at all goes
 * wrong — the caller must handle that.
 */
export async function completeJson<T>(
  messages: ChatMsg[],
  cfg: ModelConfig,
  opts: JsonOpts<T>,
): Promise<T | null> {
  const key = cacheKey(cfg.model, messages);

  if (opts.cache && !opts.refresh) {
    const hit = await opts.cache.get(key).catch(() => null);
    if (hit != null) {
      // A cached value that no longer satisfies the schema is treated as a miss,
      // not as an error — schemas change across deploys and stale shapes must not
      // resurface as live data.
      const parsed = opts.schema.safeParse(extractJson(hit));
      if (parsed.success) return parsed.data;
    }
  }

  if (opts.budget && (await overBudget(opts.budget))) return null;

  const raw = await chatComplete(messages, {
    openrouterKey: cfg.openrouterKey ?? null,
    model: cfg.model ?? null,
    env: cfg.env,
    maxTokens: opts.maxTokens ?? 700,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    json: true,
    temperature: 0,
  });
  if (raw == null) return null;
  if (opts.budget) await recordCall(opts.budget);

  const parsed = opts.schema.safeParse(extractJson(raw));
  if (!parsed.success) return null;

  if (opts.cache) {
    await opts.cache
      .put(key, JSON.stringify(parsed.data), { expirationTtl: opts.cacheTtlSec ?? DEFAULT_CACHE_TTL_SEC })
      .catch(() => {});
  }
  return parsed.data;
}
