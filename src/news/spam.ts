/**
 * Submission noise scoring.
 *
 * IMPORTANT: this does not block anything. Ever.
 *
 * The rule for this site is *let people speak*. Nothing here refuses a
 * submission, hides a post, or judges tone — a score is only used to ORDER a
 * human's moderation queue so the noisiest things surface first. Automatic
 * enforcement is exclusively rate limits and cooldowns (src/news/ratelimit.ts),
 * which are content-neutral: they care how fast you post, never what you said.
 *
 * That distinction matters. A heuristic that blocks is a heuristic that will
 * eventually refuse a real person's genuine post with no explanation and no
 * appeal, which is both worse than the spam it prevented and much harder to
 * notice. A heuristic that merely sorts a queue can be wrong all day at no cost.
 *
 * Pure, so the whole policy is inspectable and testable with fixed input.
 */
import { displayDomain } from "./canonical";

export interface SpamSignal { code: string; weight: number; detail?: string }

export interface NoiseVerdict {
  /** Higher = look at this sooner. Carries no enforcement meaning. */
  score: number;
  signals: SpamSignal[];
}

/** Queue ordering only: at or above this, a submission is surfaced for review. */
export const REVIEW_SCORE = 3;

/** URL shorteners hide the destination, which defeats one-story-per-link. */
const SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "buff.ly", "is.gd", "cutt.ly",
  "rebrand.ly", "shorturl.at", "rb.gy", "tiny.cc", "lnkd.in", "trib.al",
]);

/**
 * Phrases that essentially never appear in a genuine Bay tech submission.
 * Kept narrow and commercial on purpose — this list must not grow into a
 * vocabulary filter. If a phrase could plausibly appear in a real post made in
 * good faith, it does not belong here.
 */
const SPAM_PHRASES = [
  /\bbuy\s+(now|cheap|online)\b/i,
  /\b(free|cheap)\s+(download|crack|keygen|serial)\b/i,
  /\b(casino|betting|escort|viagra|cialis)\b/i,
  /\bmake\s+\$?\d+[k]?\s*(\/|per\s+)?(day|week|month)\b/i,
  /\b(work|earn)\s+from\s+home\b/i,
  /\bcrypto\s+(giveaway|airdrop)\b/i,
  /\bguaranteed\s+(profit|returns?)\b/i,
  /\b(whatsapp|telegram)\s*[:+]?\s*\+?\d{6,}/i,
];

export interface NoiseInput {
  title: string;
  url?: string | null;
  body?: string | null;
  /** Canonical hosts this author already has live submissions on. */
  recentDomains?: string[];
  /** Hosts an operator explicitly blocked after seeing spam. */
  blockedDomains?: string[];
}

/**
 * Score a submission for QUEUE ORDER. Never call this to decide whether to
 * accept something — there is no such decision in this codebase.
 *
 * Note what is deliberately NOT scored: capitalisation, punctuation, title
 * length, and account age. Those fire on enthusiastic newcomers writing in good
 * faith, and an excited first post is exactly the thing a young site should
 * welcome rather than quietly bury.
 */
export function scoreSubmission(input: NoiseInput): NoiseVerdict {
  const signals: SpamSignal[] = [];
  const title = String(input.title ?? "");
  const body = String(input.body ?? "");
  const text = `${title} ${body}`;
  const host = input.url ? displayDomain(input.url) : "";

  if (host && (input.blockedDomains ?? []).includes(host)) {
    signals.push({ code: "blocked_domain", weight: 5, detail: host });
  }
  if (host && SHORTENERS.has(host)) {
    signals.push({ code: "url_shortener", weight: 3, detail: host });
  }

  for (const re of SPAM_PHRASES) {
    const m = re.exec(text);
    if (m) { signals.push({ code: "spam_phrase", weight: 4, detail: m[0].slice(0, 40) }); break; }
  }

  // A wall of links in the body reads as an ad rather than a post.
  const linkCount = (body.match(/https?:\/\//g) ?? []).length;
  if (linkCount >= 5) signals.push({ code: "link_farm", weight: 3, detail: `${linkCount} links` });

  // Same author, same domain, over and over — the shape of self-promotion.
  const sameDomain = host ? (input.recentDomains ?? []).filter((d) => d === host).length : 0;
  if (sameDomain >= 3) signals.push({ code: "domain_flooding", weight: 3, detail: `${sameDomain} recent` });

  return { score: signals.reduce((n, s) => n + s.weight, 0), signals };
}

/** Whether a submission is worth a human's attention. Not whether it's allowed. */
export function needsReview(v: NoiseVerdict): boolean {
  return v.score >= REVIEW_SCORE;
}
