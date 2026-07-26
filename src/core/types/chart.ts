/**
 * THE TYPE CHART — who you are, and which rooms you're built for.
 *
 * This is the Pokémon-type layer of the game, and it is deliberately NOT invented. Both
 * halves were already in the product, grounded in 8,433 real events:
 *
 *   · **the types** come from `tag_vocab`'s `audience:` facet — founders, investors,
 *     engineers, designers, recruiters, students — plus `operators`, which every archetype's
 *     crowd mix in `src/core/vibe.ts` already uses. `investors` is split into `vc` and
 *     `angel` because the distinction is the first thing a founder asks about somebody.
 *
 *   · **the effectiveness chart** comes from those same archetypes' `crowd` distributions.
 *     A hackathon's crowd is `{engineers: 60, founders: 25, students: 15}`, so an engineer
 *     at a hackathon is in their element and an investor is a tourist — and that isn't a
 *     designer's guess, it's what the catalog says.
 *
 * The event ARCHETYPE is therefore the gym's type, the person's declared type is theirs, and
 * `affinity()` is the matchup. Same shape as the game everyone already understands.
 *
 * ## The firewall
 *
 * **A type must never multiply XP.** Not a bonus, not a matchup multiplier, nothing. The
 * moment a type pays, everybody becomes whichever type pays — and the most damaging lie
 * available on this platform is "I'm an investor". Types are cosmetic, they steer discovery
 * ("rooms you'd fit"), and they can be vouched for. That is the whole of it, and
 * `tests/founder-types.test.ts` asserts that no gym or XP code path reads this module.
 */

/** The crowd vocabulary shared by every archetype in `src/core/vibe.ts`. */
export type CrowdKey = "founders" | "investors" | "operators" | "engineers" | "students" | "designers" | "recruiters";

export interface FounderType {
  id: string;
  label: string;
  emoji: string;
  color: string;
  blurb: string;
  /** Which crowd bucket this type counts as, for the affinity chart. */
  crowd: CrowdKey;
  sort: number;
}

/**
 * Nine types. Seeded into `founder_types` (migration 0031) so a tenth is a ROW rather than a
 * redeploy — `place_kinds`' rule, restated: the renderer must not need to know the list.
 *
 * `emoji` and `color` are required for the same reason `place_kinds` requires an icon: a type
 * with no colour has no card.
 */
export const FOUNDER_TYPES: readonly FounderType[] = [
  { id: "founder", label: "Founder", emoji: "🚀", color: "#f97316", crowd: "founders", sort: 1, blurb: "Building the thing." },
  { id: "engineer", label: "Engineer", emoji: "⚙️", color: "#3b82f6", crowd: "engineers", sort: 2, blurb: "Ships the thing." },
  // `audience:investors`, split because "did they write the cheque themselves" is the first
  // thing anybody actually wants to know.
  // NB: `config/categories.json` also has a slug `vc` (the ~530 events ABOUT venture capital).
  // The overlap is safe and deliberate: tags are stored facet-qualified (`topic:vc`) in
  // `tag_vocab`/`event_tags`, while identity lives in `founder_identity.type_id`. What must
  // never happen is inferring the person from the topic — being interested in VC is not being
  // a VC, and `tests/founder-types.test.ts` fails if anything starts deriving one from the
  // other.
  { id: "vc", label: "VC", emoji: "💰", color: "#22c55e", crowd: "investors", sort: 3, blurb: "Deploys other people's money." },
  { id: "angel", label: "Angel", emoji: "😇", color: "#eab308", crowd: "investors", sort: 4, blurb: "Writes their own cheques." },
  { id: "operator", label: "Operator", emoji: "🛠️", color: "#a855f7", crowd: "operators", sort: 5, blurb: "Makes the machine run." },
  { id: "designer", label: "Designer", emoji: "🎨", color: "#ec4899", crowd: "designers", sort: 6, blurb: "Decides how it feels." },
  // Not in `tag_vocab`, but Stanford and Berkeley alone account for 435 events in the
  // catalog and `research` is a first-class story origin in `src/news/curate.ts`.
  { id: "researcher", label: "Researcher", emoji: "🔬", color: "#06b6d4", crowd: "students", sort: 7, blurb: "Works on what isn't known yet." },
  { id: "student", label: "Student", emoji: "🎓", color: "#14b8a6", crowd: "students", sort: 8, blurb: "Here to learn and meet people." },
  // Present because `tag_vocab` has `audience:recruiters` and honesty beats hiding: rooms
  // advertise "no recruiters" as a signal, so being able to say so is the fair version.
  { id: "recruiter", label: "Recruiter", emoji: "🧲", color: "#8b8b9a", crowd: "recruiters", sort: 9, blurb: "Hiring." },
];

const BY_ID = new Map(FOUNDER_TYPES.map((t) => [t.id, t]));
export const founderType = (id: string): FounderType | undefined => BY_ID.get(id);

/**
 * Every event archetype's crowd mix, lifted verbatim from `ARCHETYPES` in
 * `src/core/vibe.ts`.
 *
 * Duplicated rather than imported on purpose: `vibe.ts` owns these as a PRIOR for predicting a
 * room's feel, and it is free to retune them for that job. This module needs a stable
 * effectiveness chart — a person's type shouldn't get better or worse at hackathons because
 * somebody improved the vibe predictor. `tests/founder-types.test.ts` reconciles the two and
 * fails if an archetype is added there without a decision here.
 */
export const ARCHETYPE_CROWD: Record<string, Partial<Record<CrowdKey, number>>> = {
  "demo-day": { founders: 45, investors: 30, operators: 15, engineers: 10 },
  hackathon: { engineers: 60, founders: 25, students: 15 },
  conference: { operators: 35, engineers: 25, founders: 20, investors: 20 },
  talk: { engineers: 35, founders: 30, operators: 25, students: 10 },
  workshop: { engineers: 45, founders: 25, students: 20, operators: 10 },
  dinner: { founders: 50, investors: 25, operators: 25 },
  party: { founders: 25, engineers: 25, operators: 25, students: 15, investors: 10 },
  "happy-hour": { founders: 35, engineers: 25, operators: 20, investors: 15, students: 5 },
  cowork: { engineers: 45, founders: 40, students: 15 },
  meetup: { engineers: 40, founders: 30, operators: 20, students: 10 },
};

/** The archetype ids this chart knows about — the "gym types". */
export const ARCHETYPES = Object.keys(ARCHETYPE_CROWD);

/**
 * How much this room is *yours*, 0..1.
 *
 * The share of the predicted crowd that matches your type, normalised against the biggest
 * share any type holds at that archetype — so 1.0 means "this room is mostly people like you"
 * rather than "you are 60% of it". Unknown type or unknown archetype ⇒ 0.5, a shrug, because
 * refusing to answer is worse than saying "no strong read".
 */
export function affinity(typeId: string, archetypeId: string): number {
  const t = BY_ID.get(typeId);
  const mix = ARCHETYPE_CROWD[archetypeId];
  if (!t || !mix) return 0.5;
  const mine = mix[t.crowd] ?? 0;
  const top = Math.max(...Object.values(mix).filter((n): n is number => typeof n === "number"), 1);
  return Math.max(0, Math.min(1, mine / top));
}

export type AffinityBand = "home" | "welcome" | "neutral" | "stretch";

/** Words for a number, so the UI never has to invent its own thresholds. */
export function affinityBand(score: number): AffinityBand {
  if (!Number.isFinite(score)) return "neutral";
  if (score >= 0.8) return "home";
  if (score >= 0.45) return "welcome";
  if (score > 0.1) return "neutral";
  return "stretch";
}

const BAND_COPY: Record<AffinityBand, string> = {
  home: "Your kind of room",
  welcome: "Plenty of your people",
  neutral: "A mixed room",
  stretch: "Outside your usual crowd",
};

/**
 * The affinity for a person with a primary and optional secondary type — the best of the two.
 *
 * Best, not average: a founder/engineer at a hackathon is at home because of the engineer
 * half, and averaging would report them as merely welcome. A second type should only ever
 * open doors.
 */
export function bestAffinity(types: readonly string[], archetypeId: string): { score: number; band: AffinityBand; label: string } {
  const score = types.length ? Math.max(...types.map((t) => affinity(t, archetypeId))) : 0.5;
  const band = affinityBand(score);
  return { score, band, label: BAND_COPY[band] };
}

/**
 * Which types a room is short of — what a host sees, and what makes a room worth travelling to.
 *
 * "This crowd is 60% engineers" is a fact about the room; "there are almost no investors here"
 * is the one a founder deciding how to spend their evening actually needs.
 */
export function underrepresented(archetypeId: string, limit = 3): FounderType[] {
  const mix = ARCHETYPE_CROWD[archetypeId];
  if (!mix) return [];
  return [...FOUNDER_TYPES]
    .filter((t) => (mix[t.crowd] ?? 0) < 15)
    .sort((a, b) => (mix[a.crowd] ?? 0) - (mix[b.crowd] ?? 0) || a.sort - b.sort)
    .slice(0, limit);
}
