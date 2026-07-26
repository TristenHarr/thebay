/**
 * Event vibes — the optional model layer.
 *
 * Two distinct jobs, deliberately separated:
 *
 *   1. `predictVibe`  — read the LISTING and guess the six axes. This is the only
 *      place raw marketing copy is allowed in.
 *   2. `writeVibeProse` — write the headline and blurb from the NUMBERS plus a
 *      handful of structured facts. It never sees the description, so it cannot
 *      free-associate "an unforgettable evening of innovation" back at the reader.
 *      What it says is what the axes say.
 *
 * Both degrade to `src/core/vibe.ts` (house rule: `completeJson` returns null on
 * ANY failure — no key, bad shape, timeout, budget spent — and every caller must
 * have a deterministic path). The card therefore always renders, and with no
 * model configured anywhere the whole feature still works; it just gets its
 * numbers from rules and its sentences from a template.
 */
import { z } from "zod";
import { completeJson, type JsonOpts, type KvLike, type ModelConfig } from "./json-llm";
import type { ChatMsg } from "./llm";
import {
  VIBE_AXES,
  bandLabel,
  baselinePredict,
  clampAxes,
  deriveBestFor,
  deriveExpect,
  normalizeCrowd,
  templateBlurb,
  templateHeadline,
  type EventFacts,
  type VibeAxes,
  type VibePrediction,
} from "../core/vibe";

/* ── schemas: the model never gets to widen a type ─────────────────────────── */

const axis = z.number();
export const VibePredictionSchema = z.object({
  energy: axis,
  formality: axis,
  intimacy: axis,
  talkRatio: axis,
  signal: axis,
  approachability: axis,
  crowd: z.record(z.number()).optional(),
  bestFor: z.array(z.string()).max(6).optional(),
  expect: z.array(z.string()).max(6).optional(),
});

export const VibeProseSchema = z.object({
  headline: z.string(),
  blurb: z.string(),
});

/** A headline is one line, not an essay and not an empty string. */
const HEADLINE_MIN = 8;
const HEADLINE_MAX = 90;
const BLURB_MIN = 40;
const BLURB_MAX = 600;

/** Shared options every vibe model call takes (cache, budget, timeout). */
export type VibeLlmOpts = Partial<Pick<JsonOpts<unknown>, "cache" | "budget" | "timeoutMs" | "refresh">>;

/* ── env wiring ────────────────────────────────────────────────────────────── */

/** The narrow slice of Env this module needs. Structural, so `src/ai` stays free
 *  of Worker types (`@cloudflare/workers-types` is not ambient here). */
export interface VibeEnv {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL_QUALITY?: string;
  OPENROUTER_MODEL_FAST?: string;
  LLM_DAILY_BUDGET_USD?: string;
  /** KV used for both the response cache and the spend counter. */
  SESSIONS?: KvLike;
  AI?: { run(model: string, input: unknown): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * Build the model config + call options for vibe work. Vibes are low-volume and
 * quality-sensitive (one card per event, cached for a month), so they take the
 * QUALITY model; the fast model is the fallback.
 */
export function vibeLlm(env: VibeEnv): { cfg: ModelConfig; opts: VibeLlmOpts } {
  const dailyUsd = Number(env.LLM_DAILY_BUDGET_USD ?? NaN);
  const kv = env.SESSIONS ?? null;
  return {
    cfg: {
      openrouterKey: env.OPENROUTER_API_KEY ?? null,
      model: env.OPENROUTER_MODEL_QUALITY ?? env.OPENROUTER_MODEL_FAST ?? null,
      env: env.AI ? { AI: env.AI } : undefined,
    },
    opts: {
      cache: kv,
      budget: kv && Number.isFinite(dailyUsd) && dailyUsd > 0 ? { kv, dailyUsd } : null,
      timeoutMs: 8_000,
    },
  };
}

/* ── 1. predict the numbers from the listing ───────────────────────────────── */

const AXIS_GUIDE = [
  "energy: 0 = library-quiet, 100 = shouting over the music",
  "formality: 0 = hoodies and laptops, 100 = black tie",
  "intimacy: 0 = a big anonymous room, 100 = a tight circle you can't hide in",
  "talkRatio: 0 = pure mingling, 100 = wall-to-wall talks with no room time",
  "signal: 0 = recruiters, tourists and course vendors, 100 = people actually building",
  "approachability: 0 = closed cliques, 100 = strangers introduce themselves",
].join("\n");

function predictMessages(facts: EventFacts): ChatMsg[] {
  const listing = [
    `Title: ${facts.title}`,
    facts.venueName ? `Venue: ${facts.venueName}` : "",
    facts.city ? `City: ${facts.city}` : "",
    facts.organizer ? `Organizer: ${facts.organizer}` : "",
    facts.categories?.length ? `Tags: ${facts.categories.join(", ")}` : "",
    facts.isFree == null ? "" : `Price: ${facts.isFree ? "free" : facts.priceText || "paid"}`,
    facts.description ? `Description: ${String(facts.description).slice(0, 1500)}` : "",
  ].filter(Boolean).join("\n");

  return [
    {
      role: "system",
      content:
        "You rate the ROOM at Bay Area tech events, the way a dispensary describes a strain: honest numbers, no marketing. " +
        "Score each axis 0-100 as an integer.\n" + AXIS_GUIDE + "\n" +
        'Also return "crowd" (percentage shares by role, summing to 100, e.g. {"founders":40,"engineers":35,"investors":25}), ' +
        '"bestFor" (up to 4 short phrases naming who should go) and "expect" (up to 4 short factual bullets). ' +
        "Be skeptical: most listings oversell. Reply with JSON only.",
    },
    { role: "user", content: listing },
  ];
}

/**
 * Predict a room's vibe from its listing. Always returns a usable prediction —
 * `model` is null when the deterministic baseline produced it.
 */
export async function predictVibe(
  facts: EventFacts,
  cfg: ModelConfig,
  opts: VibeLlmOpts,
): Promise<{ prediction: VibePrediction; model: string | null }> {
  const fallback = baselinePredict(facts);
  const raw = await completeJson(predictMessages(facts), cfg, { schema: VibePredictionSchema, maxTokens: 500, ...opts });
  if (!raw) return { prediction: fallback, model: null };

  // The model's numbers are clamped, never trusted — a 900 becomes a 100.
  const axes = clampAxes(raw, fallback.axes);
  const crowd = normalizeCrowd(raw.crowd);
  const clean = (xs: string[] | undefined, max: number) =>
    [...new Set((xs ?? []).map((s) => String(s).trim().slice(0, 60)).filter(Boolean))].slice(0, max);
  const bestFor = clean(raw.bestFor, 4);
  const expect = clean(raw.expect, 4);
  return {
    prediction: {
      axes,
      crowd: Object.keys(crowd).length ? crowd : fallback.crowd,
      bestFor: bestFor.length ? bestFor : deriveBestFor(axes, facts),
      expect: expect.length ? expect : deriveExpect(axes, facts),
      archetype: fallback.archetype,
    },
    model: cfg.model ?? null,
  };
}

/* ── 2. write the prose from the numbers ───────────────────────────────────── */

function proseMessages(axes: VibeAxes, facts: EventFacts, bestFor: string[]): ChatMsg[] {
  // Only NUMBERS + a few structured facts. The description is deliberately absent:
  // the prose must describe the room we measured, not the room the copy promises.
  const numbers = VIBE_AXES.map((a) => `${a}: ${axes[a]} (${bandLabel(a, axes[a])})`).join("\n");
  const context = [
    `Title: ${facts.title}`,
    facts.venueName ? `Venue: ${facts.venueName}` : "",
    facts.city ? `City: ${facts.city}` : "",
    facts.categories?.length ? `Tags: ${facts.categories.join(", ")}` : "",
    facts.isFree == null ? "" : `Price: ${facts.isFree ? "free" : facts.priceText || "paid"}`,
    bestFor.length ? `Best for: ${bestFor.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  return [
    {
      role: "system",
      content:
        "Write a strain-card description of an event room from its measured axes. " +
        `"headline": at most ${HEADLINE_MAX} characters, 2-4 comma-separated descriptors ending in a period, ` +
        'e.g. "Loud, hoodie-dense, deal-flow heavy." ' +
        '"blurb": two plain sentences (max 320 characters) saying what walking in actually feels like. ' +
        "Use ONLY the numbers and facts given. Do not invent speakers, sponsors, attendance figures or agenda. " +
        "No hype words. Reply with JSON only.",
    },
    { role: "user", content: `${numbers}\n\n${context}` },
  ];
}

const usable = (s: string, min: number, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length >= min && t.length <= max ? t : null;
};

/**
 * The headline + blurb. Falls back to the deterministic template whenever the
 * model is absent, slow, broken, or returns something that isn't a one-liner —
 * so the card ALWAYS has words on it.
 */
export async function writeVibeProse(
  axes: VibeAxes,
  facts: EventFacts,
  bestFor: string[],
  cfg: ModelConfig,
  opts: VibeLlmOpts,
): Promise<{ headline: string; blurb: string; model: string | null }> {
  const fallback = { headline: templateHeadline(axes, facts), blurb: templateBlurb(axes, facts, bestFor), model: null };
  const raw = await completeJson(proseMessages(axes, facts, bestFor), cfg, { schema: VibeProseSchema, maxTokens: 300, ...opts });
  if (!raw) return fallback;
  const headline = usable(raw.headline, HEADLINE_MIN, HEADLINE_MAX);
  const blurb = usable(raw.blurb, BLURB_MIN, BLURB_MAX);
  if (!headline || !blurb) return fallback; // a refusal or an essay is not prose
  return { headline, blurb, model: cfg.model ?? null };
}

/**
 * Predict + write in one go. The convenience the route and the admin enrich pass
 * both use; still degrades end-to-end with no model configured.
 */
export async function enrichVibe(
  facts: EventFacts,
  cfg: ModelConfig,
  opts: VibeLlmOpts,
): Promise<{ prediction: VibePrediction; prose: { headline: string; blurb: string } | null; model: string | null }> {
  const { prediction, model: pModel } = await predictVibe(facts, cfg, opts);
  const prose = await writeVibeProse(prediction.axes, facts, prediction.bestFor, cfg, opts);
  return {
    prediction,
    // Template prose is NOT persisted: leaving it null lets the repo render it from
    // the current numbers on every read, so a sentence can't go stale against them.
    prose: prose.model ? { headline: prose.headline, blurb: prose.blurb } : null,
    model: prose.model ?? pModel,
  };
}
