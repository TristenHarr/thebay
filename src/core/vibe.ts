/**
 * Event vibes — the numeric core.
 *
 * You can't tell the caliber or the feel of a room from a listing, so this models
 * an event the way a dispensary describes a strain: six numeric axes, evocative
 * prose, and a "best for". Everything here is PURE and deterministic — the model
 * (src/ai/vibe-predict.ts) only ever refines what this file can already produce
 * on its own. A vibe card renders with no API key, no network, and no attendees.
 *
 * Three sources of belief, combined in one place:
 *   1. the LISTING            → `baselinePredict` (or an LLM prediction of the same shape)
 *   2. the HOST's track record→ only once earned from >= 3 previously-reported rooms
 *   3. the ATTENDEES          → check-in-VERIFIED reports, which dominate as they arrive
 *
 * The arithmetic is a plain Bayesian-flavoured shrinkage:
 *     w    = n_verified / (n_verified + 3)
 *     axis = w * mean(verified reports) + (1 - w) * prior
 *     conf = min(0.95, 0.3 + 0.15 * n_verified)
 * Three verified reports are worth exactly as much as everything we guessed.
 */

import { z } from "zod";

/* ── axes ──────────────────────────────────────────────────────────────────── */

export const VIBE_AXES = ["energy", "formality", "intimacy", "talkRatio", "signal", "approachability"] as const;
export type VibeAxis = (typeof VIBE_AXES)[number];

/** All six axes, each 0–100. `talkRatio` 0 = pure mingling / 100 = pure talks;
 *  `signal` 0 = recruiters and tourists / 100 = real builders. */
export type VibeAxes = Record<VibeAxis, number>;

/** Who is in the room, as percentage shares that sum to 100. */
export type CrowdMix = Record<string, number>;

/** One attendee's read of a room. Axes are optional — an unrated slider falls back
 *  to the prior rather than to a silent zero. `verified` is set by the server from
 *  `checkins`; the client never gets to claim it. */
export interface VibeReport extends Partial<VibeAxes> {
  verified: boolean;
  crowd?: CrowdMix | null;
}

/** A host's earned reputation: the mean of the rooms they've actually run. */
export interface HostTrackRecord {
  events: number;
  axes: VibeAxes;
}

export type VibeSource = "predicted" | "blended" | "reported";

/**
 * The 6-slider report card, as it arrives from a browser.
 *
 * Bounds are asserted here as well as in SQL: the CHECK constraint is the thing
 * that makes a bad row unrepresentable, this is the thing that turns a bad request
 * into a 400 instead of a 500. `verified` is deliberately absent — it is decided
 * by the server from `checkins` and can never be claimed by a client.
 */
const slider = z.number().int().min(0).max(100);
export const VibeReportSchema = z.object({
  energy: slider,
  formality: slider,
  intimacy: slider,
  talkRatio: slider,
  signal: slider,
  approachability: slider,
  crowd: z.record(z.number().min(0).max(100)).optional(),
  tags: z.array(z.string().min(1).max(40)).max(8).optional(),
  worthIt: z.number().int().min(1).max(5).optional(),
});
export type VibeReportBody = z.infer<typeof VibeReportSchema>;

/* ── constants (exported so tests and the UI speak the same numbers) ────────── */

/** Verified reports needed to weigh as much as everything we guessed. */
export const REPORT_HALF_LIFE = 3;
/** A host must have run this many *reported* rooms before their history counts. */
export const HOST_MIN_EVENTS = 3;
/** A track record can inform the prior, but never erase the listing entirely. */
export const HOST_MAX_WEIGHT = 0.6;
/** At this many verified reports the room speaks for itself (w >= 0.7). */
export const REPORTED_MIN = 7;
const CONF_BASE = 0.3;
const CONF_STEP = 0.15;
const CONF_CAP = 0.95;

/* ── small pure helpers ────────────────────────────────────────────────────── */

/** Coerce anything into a 0–100 integer, or null when it isn't a number at all.
 *  Null (rather than a silent 0) so a missing axis stays missing. */
export function clampAxis(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** Every axis clamped; anything missing falls back to `fallback` for that axis. */
export function clampAxes(v: Partial<Record<VibeAxis, unknown>> | null | undefined, fallback: VibeAxes): VibeAxes {
  const out = {} as VibeAxes;
  for (const a of VIBE_AXES) out[a] = clampAxis(v?.[a]) ?? fallback[a];
  return out;
}

export function meanAxes(list: VibeAxes[]): VibeAxes | null {
  if (!list.length) return null;
  const out = {} as VibeAxes;
  for (const a of VIBE_AXES) out[a] = Math.round(list.reduce((s, x) => s + x[a], 0) / list.length);
  return out;
}

/** Linear mix: `wB` of `b`, the rest of `a`. Rounded to integers. */
export function mixAxes(a: VibeAxes, b: VibeAxes, wB: number): VibeAxes {
  const w = Math.min(1, Math.max(0, wB));
  const out = {} as VibeAxes;
  for (const x of VIBE_AXES) out[x] = Math.round(w * b[x] + (1 - w) * a[x]);
  return out;
}

/** How much the attendee reports are worth against the prior. */
export function reportWeight(nVerified: number): number {
  const n = Math.max(0, nVerified);
  return n / (n + REPORT_HALF_LIFE);
}

/** Confidence in the card. Grows with verified evidence only, and caps — we are
 *  never certain about a room from a sample. */
export function vibeConfidence(nVerified: number): number {
  return Math.min(CONF_CAP, CONF_BASE + CONF_STEP * Math.max(0, nVerified));
}

/** How much a host's own track record informs the prior. Zero until earned. */
export function hostWeight(nEvents: number): number {
  if (nEvents < HOST_MIN_EVENTS) return 0;
  return Math.min(HOST_MAX_WEIGHT, nEvents / (nEvents + REPORT_HALF_LIFE));
}

/** Percentage shares, cleaned and rescaled to sum to 100. */
export function normalizeCrowd(raw: unknown): CrowdMix {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const pairs: [string, number][] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : Number(v);
    const label = String(k).trim().slice(0, 32);
    if (label && Number.isFinite(n) && n > 0) pairs.push([label, n]);
  }
  const total = pairs.reduce((s, [, n]) => s + n, 0);
  if (!total) return {};
  const out: CrowdMix = {};
  for (const [k, n] of pairs) out[k] = Math.round((n / total) * 100);
  return out;
}

/** Mean of several crowd mixes, renormalised. */
export function meanCrowd(list: CrowdMix[]): CrowdMix {
  const usable = list.map(normalizeCrowd).filter((c) => Object.keys(c).length);
  if (!usable.length) return {};
  const sum: CrowdMix = {};
  for (const c of usable) for (const [k, v] of Object.entries(c)) sum[k] = (sum[k] ?? 0) + v;
  return normalizeCrowd(sum);
}

/* ── the blend ─────────────────────────────────────────────────────────────── */

export interface BlendInput {
  /** The listing-derived (or model-derived) prior. */
  predicted: VibeAxes;
  /** Every report we hold. Unverified ones are counted but never weighted. */
  reports: VibeReport[];
  /** The host's earned track record, if they have one. */
  host?: HostTrackRecord | null;
  /** The prior's crowd mix (from the prediction). */
  predictedCrowd?: CrowdMix | null;
}

export interface BlendResult {
  axes: VibeAxes;
  /** The prior after the host carry-over, before any attendee report. */
  prior: VibeAxes;
  crowd: CrowdMix;
  source: VibeSource;
  confidence: number;
  /** VERIFIED reports — the number the UI is allowed to show as "N attendees". */
  nReports: number;
  /** Reports we hold but deliberately did not weight. */
  nUnverified: number;
}

/**
 * Combine listing, host history and attendee reports into one honest card.
 *
 * `source` is the honesty contract with the UI: `predicted` means nobody has
 * actually been in that room yet, and must never be rendered as a report count.
 */
export function blendVibe(input: BlendInput): BlendResult {
  const predicted = clampAxes(input.predicted, DEFAULT_AXES);
  const verified = input.reports.filter((r) => r.verified);
  const nVerified = verified.length;
  const nUnverified = input.reports.length - nVerified;

  // 1. the prior: the listing, nudged toward the host's earned track record.
  const hw = input.host ? hostWeight(input.host.events) : 0;
  const prior = hw > 0 && input.host ? mixAxes(predicted, clampAxes(input.host.axes, predicted), hw) : predicted;

  // 2. the posterior: verified attendees, shrunk toward the prior.
  const mean = meanAxes(verified.map((r) => clampAxes(r, prior)));
  const w = reportWeight(nVerified);
  const axes = mean ? mixAxes(prior, mean, w) : prior;

  const crowd = mean
    ? blendCrowd(normalizeCrowd(input.predictedCrowd), meanCrowd(verified.map((r) => r.crowd ?? {})), w)
    : normalizeCrowd(input.predictedCrowd);

  const source: VibeSource = nVerified === 0 ? "predicted" : nVerified >= REPORTED_MIN ? "reported" : "blended";
  return { axes, prior, crowd, source, confidence: vibeConfidence(nVerified), nReports: nVerified, nUnverified };
}

/** Same shrinkage as the axes, applied to the crowd shares. */
function blendCrowd(prior: CrowdMix, reported: CrowdMix, w: number): CrowdMix {
  if (!Object.keys(reported).length) return prior;
  if (!Object.keys(prior).length) return reported;
  const out: CrowdMix = {};
  for (const k of new Set([...Object.keys(prior), ...Object.keys(reported)])) {
    out[k] = w * (reported[k] ?? 0) + (1 - w) * (prior[k] ?? 0);
  }
  return normalizeCrowd(out);
}

/* ── the deterministic prediction ──────────────────────────────────────────── */

/** The structured facts a prediction is allowed to see. Deliberately small: the
 *  prose step gets this plus the numbers, and never the raw marketing copy. */
export interface EventFacts {
  title: string;
  description?: string | null;
  categories?: string[] | null;
  city?: string | null;
  venueName?: string | null;
  organizer?: string | null;
  isFree?: boolean | null;
  priceText?: string | null;
  startUtc?: string | null;
}

export interface VibePrediction {
  axes: VibeAxes;
  crowd: CrowdMix;
  bestFor: string[];
  expect: string[];
  /** Which room shape we matched. Useful in the prose prompt and for debugging. */
  archetype: string;
}

/** The shape of a room we know nothing else about. */
const DEFAULT_AXES: VibeAxes = { energy: 55, formality: 40, intimacy: 45, talkRatio: 45, signal: 55, approachability: 60 };
const DEFAULT_CROWD: CrowdMix = { founders: 30, engineers: 30, operators: 20, investors: 10, students: 10 };

interface Archetype {
  id: string;
  /** Word-boundary anchored — `ai` must not match "email", `party` must not match
   *  "partnership". Same rule the keyword tagger runs on. */
  re: RegExp;
  axes: VibeAxes;
  crowd?: CrowdMix;
}

/**
 * Room shapes, most specific first — the first match wins, so "demo day" beats the
 * generic "meetup" that also appears in the title.
 */
const ARCHETYPES: Archetype[] = [
  {
    id: "demo-day",
    re: /\b(demo\s?day|pitch(es|ing)?\s?(night|day|competition)?|pitch|showcase)\b/i,
    axes: { energy: 70, formality: 60, intimacy: 30, talkRatio: 75, signal: 75, approachability: 45 },
    crowd: { founders: 45, investors: 30, operators: 15, engineers: 10 },
  },
  {
    id: "hackathon",
    re: /\b(hackathon|hack\s?night|buildathon|jam)\b/i,
    axes: { energy: 80, formality: 15, intimacy: 55, talkRatio: 15, signal: 85, approachability: 75 },
    crowd: { engineers: 60, founders: 25, students: 15 },
  },
  {
    id: "conference",
    re: /\b(conference|summit|expo|convention|symposium|forum)\b/i,
    axes: { energy: 60, formality: 70, intimacy: 20, talkRatio: 80, signal: 55, approachability: 35 },
    crowd: { operators: 35, engineers: 25, founders: 20, investors: 20 },
  },
  {
    id: "talk",
    re: /\b(panel|fireside|keynote|talk|talks|lecture|seminar|webinar|ama)\b/i,
    axes: { energy: 45, formality: 60, intimacy: 35, talkRatio: 90, signal: 60, approachability: 40 },
    crowd: { engineers: 35, founders: 30, operators: 25, students: 10 },
  },
  {
    id: "workshop",
    re: /\b(workshop|training|bootcamp|class|course|masterclass|tutorial|lab)\b/i,
    axes: { energy: 45, formality: 45, intimacy: 65, talkRatio: 70, signal: 65, approachability: 70 },
    crowd: { engineers: 45, founders: 25, students: 20, operators: 10 },
  },
  {
    id: "dinner",
    re: /\b(dinner|salon|roundtable|round\s?table|breakfast|lunch|office\s?hours|retreat|supper)\b/i,
    axes: { energy: 40, formality: 45, intimacy: 85, talkRatio: 40, signal: 80, approachability: 75 },
    crowd: { founders: 50, investors: 25, operators: 25 },
  },
  {
    id: "party",
    re: /\b(party|parties|after\s?party|launch|celebration|gala|rave|dj)\b/i,
    axes: { energy: 90, formality: 20, intimacy: 25, talkRatio: 5, signal: 40, approachability: 65 },
    crowd: { founders: 25, engineers: 25, operators: 25, students: 15, investors: 10 },
  },
  {
    id: "happy-hour",
    re: /\b(happy\s?hour|mixer|mingle|drinks|social|meet\s?(and|&)\s?greet|networking)\b/i,
    axes: { energy: 75, formality: 25, intimacy: 45, talkRatio: 10, signal: 50, approachability: 80 },
    crowd: { founders: 35, engineers: 25, operators: 20, investors: 15, students: 5 },
  },
  {
    id: "cowork",
    re: /\b(co\s?work(ing)?|build\s?night|coffee|study|sprint|open\s?house|demo\s?hours)\b/i,
    axes: { energy: 40, formality: 15, intimacy: 60, talkRatio: 10, signal: 75, approachability: 80 },
    crowd: { engineers: 45, founders: 40, students: 15 },
  },
  {
    id: "meetup",
    re: /\b(meet\s?up|group|club|community|chapter)\b/i,
    axes: { energy: 60, formality: 30, intimacy: 45, talkRatio: 45, signal: 55, approachability: 70 },
    crowd: { engineers: 40, founders: 30, operators: 20, students: 10 },
  },
];

/** Signals that shift an archetype rather than replace it. */
const MODIFIERS: Array<{ re: RegExp; delta: Partial<VibeAxes> }> = [
  // A door you have to get through filters the room — that IS the caliber signal.
  { re: /\b(invite[\s-]?only|application|apply|curated|selective|vetted|rsvp\s?approval|members?\s?only|closed\s?door)\b/i, delta: { signal: 15, intimacy: 10, approachability: -5, formality: 5 } },
  { re: /\b(founders?\s?only|operators?\s?only|no\s?recruiters|builders?\s?only)\b/i, delta: { signal: 15, approachability: 5 } },
  { re: /\b(vc|venture|investors?|lp|limited\s?partners?|fund)\b/i, delta: { formality: 10, signal: 5 } },
  { re: /\b(students?|university|campus|club\s?fair|career\s?fair|job\s?fair|recruiting)\b/i, delta: { signal: -20, approachability: 5 } },
  { re: /\b(intimate|small\s?group|\d{1,2}\s?seats|limited\s?seats|by\s?the\s?fire)\b/i, delta: { intimacy: 20, approachability: 10 } },
  { re: /\b(black\s?tie|formal|awards?|ceremony)\b/i, delta: { formality: 25, approachability: -10 } },
  { re: /\b(outdoor|hike|run|walk|picnic|park|beach)\b/i, delta: { formality: -15, approachability: 15, energy: 5 } },
];

const scan = (facts: EventFacts): string =>
  [facts.title, facts.description ?? "", (facts.categories ?? []).join(" "), facts.venueName ?? "", facts.organizer ?? ""].join(" ");

/**
 * The prior from the listing, with no model at all. Word-boundary matched, so
 * "partnership" never reads as a "party" and "service" never reads as "vc".
 *
 * The archetype is matched against the TITLE first and only falls back to the full
 * text if nothing hits: a happy hour whose description happens to say "come talk to
 * us" is a happy hour, not a talk. Modifiers are additive and specific enough to
 * read from the whole listing.
 */
export function baselinePredict(facts: EventFacts): VibePrediction {
  const hay = scan(facts);
  const titleish = [facts.title, (facts.categories ?? []).join(" ")].join(" ");
  const match = ARCHETYPES.find((a) => a.re.test(titleish)) ?? ARCHETYPES.find((a) => a.re.test(hay));
  const base = match ? { ...match.axes } : { ...DEFAULT_AXES };
  const crowd = { ...(match?.crowd ?? DEFAULT_CROWD) };

  for (const m of MODIFIERS) {
    if (!m.re.test(hay)) continue;
    for (const [k, d] of Object.entries(m.delta)) base[k as VibeAxis] = base[k as VibeAxis] + (d as number);
  }
  // A free open door is warmer but noisier — more tourists per builder.
  if (facts.isFree) { base.signal -= 8; base.approachability += 5; }
  // A ticket price is a filter, so it lifts signal a little.
  if (facts.isFree === false) base.signal += 5;

  const axes = clampAxes(base, DEFAULT_AXES);
  return {
    axes,
    crowd: normalizeCrowd(crowd),
    bestFor: deriveBestFor(axes, facts),
    expect: deriveExpect(axes, facts),
    archetype: match?.id ?? "unknown",
  };
}

/* ── deterministic prose ───────────────────────────────────────────────────── */

/** Band labels per axis, low → high. Used in the blurb and in the LLM prompt so
 *  the model is describing OUR numbers rather than free-associating on the copy. */
const BANDS: Record<VibeAxis, Array<[number, string]>> = {
  energy: [[25, "calm"], [45, "low-key"], [65, "warm"], [85, "buzzing"], [100, "electric"]],
  formality: [[25, "hoodies and laptops"], [45, "casual"], [65, "smart casual"], [85, "business"], [100, "black tie"]],
  intimacy: [[25, "a big anonymous room"], [45, "roomy"], [65, "mid-size"], [85, "small-group"], [100, "a tight circle"]],
  talkRatio: [[20, "pure mingling"], [40, "mostly mingling"], [60, "half programme, half room"], [80, "mostly programme"], [100, "wall-to-wall talks"]],
  signal: [[25, "recruiters and tourists"], [45, "a mixed crowd"], [65, "a real builder core"], [85, "builder-dense"], [100, "nothing but builders"]],
  approachability: [[25, "cliquey"], [45, "reserved"], [65, "friendly enough"], [85, "easy to talk to"], [100, "everyone says hi"]],
};

/** Two-word descriptors for the headline: [low end, high end]. */
const HEADLINE_WORDS: Record<VibeAxis, [string, string]> = {
  energy: ["quiet", "loud"],
  formality: ["hoodie-dense", "buttoned-up"],
  intimacy: ["big-room", "small-room"],
  talkRatio: ["mingling-first", "talk-heavy"],
  signal: ["tourist-heavy", "deal-flow heavy"],
  approachability: ["cliquey", "easy to meet people"],
};

export function bandLabel(axis: VibeAxis, value: number): string {
  const v = clampAxis(value) ?? 50;
  for (const [max, label] of BANDS[axis]) if (v <= max) return label;
  return BANDS[axis][BANDS[axis].length - 1]![1];
}

/**
 * The strain-card one-liner, e.g. "Loud, hoodie-dense, deal-flow heavy."
 * Picks the three axes furthest from the middle — the things that actually
 * distinguish this room — in a stable order.
 */
export function templateHeadline(axes: VibeAxes, _facts: EventFacts): string {
  const ranked = [...VIBE_AXES]
    .map((a, i) => ({ a, i, dist: Math.abs((clampAxis(axes[a]) ?? 50) - 50) }))
    .sort((x, y) => y.dist - x.dist || x.i - y.i)
    .slice(0, 3);
  const words = ranked.map(({ a }) => HEADLINE_WORDS[a][(clampAxis(axes[a]) ?? 50) < 50 ? 0 : 1]);
  const line = words.join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1) + ".";
}

/** Two sentences of honest description, straight off the numbers. */
export function templateBlurb(axes: VibeAxes, facts: EventFacts, bestFor: string[] = []): string {
  const a = clampAxes(axes, DEFAULT_AXES);
  const where = facts.venueName ? ` at ${facts.venueName}` : "";
  const first = `Expect ${bandLabel("energy", a.energy)} energy in ${bandLabel("intimacy", a.intimacy)} surroundings${where}, dressed ${bandLabel("formality", a.formality)}.`;
  const second = `It runs ${a.talkRatio}% programme to ${100 - a.talkRatio}% room, the crowd is ${bandLabel("signal", a.signal)}, and it's ${bandLabel("approachability", a.approachability)} if you turn up alone.`;
  const third = bestFor.length ? ` Best for ${bestFor.slice(0, 2).join(" and ")}.` : "";
  return `${first} ${second}${third}`;
}

/** Who this room is worth going to, derived from the axes (never guessed). */
export function deriveBestFor(axes: VibeAxes, facts: EventFacts): string[] {
  const a = clampAxes(axes, DEFAULT_AXES);
  const hay = scan(facts);
  const out: string[] = [];
  const add = (s: string) => { if (!out.includes(s)) out.push(s); };

  if (a.signal >= 65 && a.talkRatio <= 45) add("finding a cofounder");
  if (a.intimacy >= 65 && a.talkRatio <= 60) add("real conversations");
  if (a.talkRatio >= 70) add("learning something specific");
  if (a.approachability >= 70 && a.talkRatio <= 55) add("turning up alone");
  if (a.energy >= 75 && a.formality <= 35) add("a loose night out");
  if (a.formality >= 60 && a.signal >= 55) add("meeting investors");
  if (/\b(vc|venture|seed|series\s?[a-d]|fundrais|raising|investors?)\b/i.test(hay)) add("raising");
  if (a.signal >= 70) add("meeting real builders");
  if (!out.length) add("a low-stakes first outing");
  return out.slice(0, 4);
}

/** The concrete "what you're walking into" bullets. */
export function deriveExpect(axes: VibeAxes, facts: EventFacts): string[] {
  const a = clampAxes(axes, DEFAULT_AXES);
  const out = [
    `${a.talkRatio}% programme / ${100 - a.talkRatio}% mingling`,
    `Room: ${bandLabel("intimacy", a.intimacy)}`,
    `Dress: ${bandLabel("formality", a.formality)}`,
    `Crowd: ${bandLabel("signal", a.signal)}`,
  ];
  if (facts.isFree) out.push("Free — expect a wider, looser crowd");
  return out;
}
