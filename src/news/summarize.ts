/**
 * The AI TL;DR and topic tagging.
 *
 * Follows the pattern the rest of this codebase already uses for AI: a
 * DETERMINISTIC core that always works, with the model as an optional
 * improvement on top. If there's no AI binding, no key, or the model returns
 * something unusable, the story still gets a sensible summary and correct topics
 * — it just gets them from rules instead. Nothing here is allowed to fail a
 * cron run or block a page render.
 */
import type { Env } from "../worker/env";
import type { Story } from "../storage/d1/news-repo";

export interface Summary { summary: string; topics: string[] }

/** The four axes this site ranks against, with the words that signal each. */
const TOPIC_SIGNALS: Record<string, RegExp> = {
  hardware: /\b(hardware|chip|silicon|semiconductor|fab|mems|photonic|robot(ic)?s?|sensor|fpga|asic|pcb|embedded|wafer|lidar|batter(y|ies)|manufactur|quantum|drone|satellite|biotech)/i,
  vc: /\b(seed|series [a-d]\b|venture|vc\b|funding|fundrais|raise[sd]?|valuation|term sheet|cap table|investor|angel|yc\b|accelerator|incubator|acquisition|ipo|startup|founder|entrepreneur|pitch|demo day)/i,
  math: /\b(theorem|proof|conjecture|topolog|algebra|combinator|geometr|number theory|probabilit|lemma|manifold|arxiv|mathemat|cryptograph)/i,
  software: /\b(software|compiler|database|kernel|runtime|api\b|framework|typescript|rust\b|python|golang|distributed|latency|open.?source|protocol|llm|machine learning|\bai\b|developer|engineer|hackathon|devops|infrastructure|security)/i,
};

/**
 * Paid training courses advertised as events.
 *
 * Course vendors bulk-list "Generative AI for Business Leaders 1 Day Training in
 * ‹City›, CA" across every Bay town. They pass a topic filter easily — they're
 * full of "AI", "enterprise", "data engineering" — but they are advertising, not
 * news, and eight in a row was the real front page. They differ enough in wording
 * that title-similarity doesn't catch them; the giveaway is the shared
 * "<n> Day(s) <Training|Workshop|Masterclass|Bootcamp>" boilerplate.
 *
 * Deliberately narrow: a genuine "2-day hardware workshop" meetup is rare, and
 * missing one is much cheaper than burying the front page under course ads.
 */
const COMMERCIAL_TRAINING =
  /\b\d+\s*[-–]?\s*days?\b[^.]{0,40}\b(training|workshop|masterclass|bootcamp|certification|course)\b|\b(training|workshop|masterclass|bootcamp|certification)\b[^.]{0,20}\b\d+\s*[-–]?\s*days?\b/i;

export function looksLikeCommercialTraining(title: string): boolean {
  return COMMERCIAL_TRAINING.test(String(title ?? ""));
}

/** Rule-based topics — always available, and the fallback when the model isn't. */
export function deriveTopics(text: string): string[] {
  const hay = String(text ?? "");
  return Object.entries(TOPIC_SIGNALS).filter(([, re]) => re.test(hay)).map(([k]) => k);
}

/**
 * Sources hand us text that is ALREADY cut off. A meetup description arrived as
 * 172 characters ending "…transforming how wars are fought and who dominates t",
 * which is under our own limit, so it passed straight through and rendered that
 * bare "t" on the front page. Our truncation was never the problem; inheriting
 * someone else's was.
 *
 * A fragment that ends with a stub of a word is the tell. Only a genuinely long
 * run of text is treated this way — "Bay Area Rust Meetup" is a short complete
 * phrase with no terminal punctuation, and mangling that would be worse than
 * the thing being fixed.
 */
const SENTENCE_END = /[.!?…)"'\]]$/;
const CUT_OFF_WORD = /\s+\S{1,3}$/;
export function tidyFragment(text: string): string {
  if (SENTENCE_END.test(text) || text.length < 120) return text;
  const trimmed = text.replace(CUT_OFF_WORD, "");
  return (trimmed.length < text.length ? trimmed : text) + "…";
}

/** A usable summary with no model at all: the source's own description, trimmed. */
export function fallbackSummary(story: Pick<Story, "description" | "body" | "title">): string | null {
  const raw = (story.description || story.body || "").replace(/\s+/g, " ").trim();
  if (raw.length < 40) return null; // too short to be worth a TL;DR line
  return raw.length <= 180 ? tidyFragment(raw) : raw.slice(0, 179).replace(/\s+\S*$/, "") + "…";
}

const PROMPT = (title: string, context: string) =>
  `Summarize this tech news item for a Bay Area engineering audience in ONE sentence of at most 30 words. ` +
  `Be concrete and factual. Do not editorialize, do not start with "This article".\n\n` +
  `Title: ${title}\n${context ? `Context: ${context.slice(0, 1200)}\n` : ""}\nOne-sentence summary:`;

/**
 * Best-effort summary. Returns null when there's nothing worth storing, so the
 * caller simply leaves `summary` NULL and the row renders without a TL;DR.
 */
export async function summarizeStory(env: Env, story: Story): Promise<Summary | null> {
  const context = (story.description || story.body || "").trim();
  const topics = deriveTopics(`${story.title} ${context}`);
  const fallback = fallbackSummary(story);

  if (!env.AI) return fallback ? { summary: fallback, topics } : topics.length ? { summary: "", topics } : null;

  try {
    const res: any = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [{ role: "user", content: PROMPT(story.title, context) }],
      max_tokens: 90,
    });
    const text = String(res?.response ?? res?.result?.response ?? "").replace(/\s+/g, " ").trim();
    // Guard against the model returning an empty string, a refusal, or an essay.
    if (text.length >= 25 && text.length <= 400) {
      return { summary: text.length <= 220 ? text : text.slice(0, 219).replace(/\s+\S*$/, "") + "…", topics };
    }
  } catch {
    // Model unavailable or errored — fall through to the deterministic path.
  }

  return fallback ? { summary: fallback, topics } : topics.length ? { summary: "", topics } : null;
}
