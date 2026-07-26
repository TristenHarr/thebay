import { z } from "zod";
import { chatComplete, type ChatMsg, type LlmEnv } from "./llm";

/**
 * Content moderation for shadows — the ephemeral live board. Two layers:
 *
 *   1. `screenText` — an always-on, deterministic hard-screen. Catches the
 *      unambiguous, genuinely dangerous stuff (credible threats, self-harm
 *      encouragement) INSTANTLY and with no dependency, so the worst content never
 *      persists even when no LLM is configured. Deliberately narrow — it must never
 *      false-positive on the candid, profane, opinionated talk this community runs on.
 *   2. `moderateText` — the LLM classifier (Workers AI by default, a stronger
 *      OpenRouter model if a key is set). Handles the nuanced long tail: targeted
 *      hate, harassment, doxxing, scams. Runs async off the post so the board stays
 *      instant; a block retracts the shadow live (see the route's auditNewShadow).
 *
 * `buildModerationRequest` / `parseModerationVerdict` are pure and exported so the
 * prompt shape + the parse are unit-tested without a live model — same discipline
 * as buildOpenRouterRequest.
 */
export interface ModerationVerdict {
  allow: boolean;
  reason: string | null;
}

// Unambiguous, high-severity patterns only. Hate/harassment nuance is the LLM's
// job; these are the things that must never survive even a cold start. Kept narrow
// on purpose — a founder venting "this pitch will kill me" must pass.
const HARD_BLOCK: Array<{ re: RegExp; reason: string }> = [
  { re: /\bk+\s*y+\s*s+\b/i, reason: "self-harm encouragement" }, // "kys"
  { re: /\bkill\s+(your\s*self|yo?ur?self|urself|u)\b/i, reason: "self-harm encouragement" },
  { re: /\b(go|just)\s+(and\s+)?(die|kill\s+yourself|hang\s+yourself)\b/i, reason: "self-harm encouragement" },
  { re: /\bhang\s+your\s*self\b/i, reason: "self-harm encouragement" },
  { re: /\bi(\s*'?\s*ll|\s+will|\s+am\s+going\s+to|\s+gonna)\s+(kill|murder|shoot|stab|hurt)\s+(you|u|him|her|them|y'?all)\b/i, reason: "credible threat of violence" },
];

/** Instant deterministic screen. `allow:false` ⇒ never persist / never fan out. */
export function screenText(text: string): ModerationVerdict {
  const t = (text || "").trim();
  if (!t) return { allow: true, reason: null };
  for (const { re, reason } of HARD_BLOCK) if (re.test(t)) return { allow: false, reason };
  return { allow: true, reason: null };
}

/** The exact messages sent to the classifier — pure, so the prompt is testable. */
export function buildModerationRequest(text: string): ChatMsg[] {
  return [
    {
      role: "system",
      content: [
        "You are a content-safety classifier for an ephemeral, location-based social board used by tech founders in the SF Bay Area.",
        "This is an adult community with a candid, irreverent culture. ALLOW profanity, edgy humor, strong or negative opinions, criticism of companies/people's work, and venting.",
        "BLOCK ONLY content that is genuinely harmful:",
        "- targeted harassment or hate toward a person or protected group (race, religion, gender, sexuality, etc.)",
        "- credible threats of violence, or encouragement of self-harm/suicide",
        "- sexual content involving minors",
        "- doxxing (sharing someone's private personal information: home address, phone, etc.)",
        "- spam, scams, or phishing",
        'Respond with ONLY a JSON object, no prose: {"allow": boolean, "reason": string}.',
        'When you block, "reason" is a short phrase naming the category. When you allow, "reason" is "".',
      ].join("\n"),
    },
    { role: "user", content: text.slice(0, 1000) },
  ];
}

const VerdictSchema = z.object({ allow: z.boolean(), reason: z.string().nullish() });

/** Parse the classifier's reply. Robust to code fences / stray prose (extract the
 *  first JSON object); falls back to a keyword scan; defaults to allow when it can't
 *  tell (the deterministic screen has already run, so the tail here is low-severity). */
export function parseModerationVerdict(raw: string | null): ModerationVerdict {
  if (!raw) return { allow: true, reason: null };
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = VerdictSchema.safeParse(JSON.parse(match[0]));
      if (parsed.success) return { allow: parsed.data.allow, reason: parsed.data.reason ?? null };
    } catch {
      /* not JSON after all — fall through to the keyword scan */
    }
  }
  const low = raw.toLowerCase();
  if (/\b(block|blocked|unsafe|violat\w*|reject|disallow|not allowed|flag)\b/.test(low)) return { allow: false, reason: "flagged" };
  return { allow: true, reason: null };
}

export interface ModerateOpts {
  env?: LlmEnv;
  openrouterKey?: string | null;
  model?: string | null;
}

/** Full pipeline: deterministic hard-screen, then (if it passed and a model is
 *  available) the LLM classifier. No model ⇒ allow (the hard-screen already ran). */
export async function moderateText(text: string, opts: ModerateOpts = {}): Promise<ModerationVerdict> {
  const screen = screenText(text);
  if (!screen.allow) return screen;
  if (!(text || "").trim()) return { allow: true, reason: null };
  const raw = await chatComplete(buildModerationRequest(text), {
    env: opts.env,
    openrouterKey: opts.openrouterKey ?? null,
    model: opts.model ?? null,
    maxTokens: 60,
  });
  if (raw == null) return { allow: true, reason: null };
  return parseModerationVerdict(raw);
}
