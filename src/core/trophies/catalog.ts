/**
 * THE trophy catalog — data, not code.
 *
 * Before this file, a trophy lived in two places: an imperative `grantAchievement`
 * call buried in a repo, and a hard-coded `{icon, title, desc}` map in
 * web/src/features/achievements/Achievements.tsx. That split produced exactly the
 * bugs you would predict. Three trophies the UI promised (`first_checkin`,
 * `first_host`, `super_connector`) were granted by no server code at all. Two the
 * server granted (`intro_made`, `first_vibe`) were missing from the UI and rendered
 * as a generic 🏅. And nothing could draw a LOCKED trophy or progress toward one,
 * because the client only ever learned about trophies that had already fired.
 *
 * So the catalog follows `tag_vocab`'s precedent — "a new tag is a row, not a
 * redeploy" — and `src/core/xp/levels.ts`'s purity discipline: this module is pure
 * data plus lookups, imported by the Worker AND the browser, so the progress bar and
 * the award can never disagree about what the threshold was.
 *
 * ## The two invariants that other subsystems depend on
 *
 * **`id` is a stable award `kind`.** It is written verbatim into
 * `achievements.kind`, which is free text with no catalog table. Renaming an id
 * orphans every row that already carries it, so ids here are append-only forever —
 * including the nine legacy kinds shipped code already granted. Rename the `name`
 * freely; never the `id`.
 *
 * **No id contains a colon.** `gym:<ULID>` is the reserved namespace for host-minted
 * badges, enforced by a trigger. A canonical trophy called `gym:anything` would let
 * a gym leader mint a badge that impersonates a system award, so the absence of a
 * colon here is load-bearing and `tests/trophy-catalog.test.ts` asserts it.
 *
 * ## Why tiers
 *
 * A series is one metric at ascending thresholds. That is the whole trick: 22 series
 * over 22 metrics yield 66 trophies, every one of them with a free progress bar and
 * a visible next rung, and adding a rung is one line rather than a new grant site.
 */

/** Every counter the snapshot provides. A trophy may only measure one of these. */
export const TROPHY_METRICS = [
  "checkins",
  "reviews",
  "hosted",
  "intros",
  "connections",
  "friends",
  "shadows",
  "shadowAreas",
  "vibeReports",
  "photos",
  "places",
  "placeConfirms",
  "stories",
  "comments",
  "storyVotes",
  "mentorships",
  "attendStreak",
  "shadowStreak",
  "rsvps",
  "xp",
  "points",
  "communities",
] as const;
export type TrophyMetric = (typeof TROPHY_METRICS)[number];

export interface Trophy {
  /** Stable `achievements.kind`. Append-only; never contains ':'. */
  id: string;
  /** Groups the rungs of one ladder. Not persisted — a display/ordering concern. */
  series: string;
  /** 1-based rung within the series. */
  tier: number;
  name: string;
  flavor: string;
  icon: string;
  metric: TrophyMetric;
  /** Earned when the metric is `>= threshold`. */
  threshold: number;
  xp: number;
  /** Hidden until earned, and never suggested by `nextUp`. */
  secret?: boolean;
}

/** XP by rung. Steep enough that the top of a ladder feels worth climbing. */
const TIER_XP = [25, 75, 200, 500];

/** Build a ladder over one metric. Keeps thresholds, tiers and XP in lockstep so a
 *  series cannot be defined with a tier-3 rung cheaper than its tier-2. */
function ladder(
  seriesName: string,
  metric: TrophyMetric,
  icon: string,
  rungs: Array<{ id: string; name: string; flavor: string; at: number; icon?: string; secret?: boolean }>,
): Trophy[] {
  return rungs.map((r, i) => ({
    id: r.id,
    series: seriesName,
    tier: i + 1,
    name: r.name,
    flavor: r.flavor,
    icon: r.icon ?? icon,
    metric,
    threshold: r.at,
    xp: TIER_XP[i] ?? TIER_XP[TIER_XP.length - 1]! * (i - TIER_XP.length + 2),
    ...(r.secret ? { secret: true as const } : {}),
  }));
}

export const TROPHIES: readonly Trophy[] = [
  // ── being there ─────────────────────────────────────────────────────────────
  ...ladder("showed_up", "checkins", "📍", [
    { id: "first_checkin", name: "Showed Up", flavor: "Checked in to your first event.", at: 1 },
    { id: "showed_up_2", name: "Regular", flavor: "Ten check-ins. People know your face.", at: 10 },
    { id: "showed_up_3", name: "Fixture", flavor: "Fifty check-ins across the Bay.", at: 50 },
    { id: "showed_up_4", name: "Institution", flavor: "Two hundred rooms entered.", at: 200 },
  ]),
  ...ladder("rsvp", "rsvps", "✋", [
    { id: "rsvp_1", name: "Interested", flavor: "Your first RSVP.", at: 1 },
    { id: "rsvp_2", name: "Planner", flavor: "Twenty-five events on your calendar.", at: 25 },
    { id: "rsvp_3", name: "Calendar Bender", flavor: "A hundred RSVPs. Sleep is optional.", at: 100 },
  ]),
  ...ladder("streak", "attendStreak", "🔥", [
    { id: "streak_1", name: "On A Roll", flavor: "Three events without a gap.", at: 3 },
    { id: "streak_2", name: "Unmissable", flavor: "An eight-event attendance streak.", at: 8 },
    { id: "streak_3", name: "Metronome", flavor: "Twenty in a row. Clockwork.", at: 20 },
  ]),

  // ── saying something ────────────────────────────────────────────────────────
  ...ladder("critic", "reviews", "⭐", [
    { id: "first_review", name: "Critic", flavor: "Wrote your first event review.", at: 1 },
    { id: "critic_2", name: "Reviewer", flavor: "Ten reviews. Hosts read these.", at: 10 },
    { id: "critic_3", name: "Editor In Chief", flavor: "Fifty reviews written.", at: 50 },
  ]),
  ...ladder("vibes", "vibeReports", "🌡️", [
    { id: "first_vibe", name: "Vibe Check", flavor: "Reported what a room was actually like.", at: 1 },
    { id: "vibes_2", name: "Barometer", flavor: "Ten vibe reports.", at: 10 },
    { id: "vibes_3", name: "Oracle", flavor: "Fifty rooms read correctly.", at: 50 },
  ]),
  ...ladder("photos", "photos", "📸", [
    { id: "photos_1", name: "Shutterbug", flavor: "Posted your first photo.", at: 1 },
    { id: "photos_2", name: "Photographer", flavor: "Ten photos contributed.", at: 10 },
    { id: "photos_3", name: "Archivist", flavor: "Fifty photos in the record.", at: 50 },
  ]),

  // ── the news site ───────────────────────────────────────────────────────────
  ...ladder("stories", "stories", "📰", [
    { id: "stories_1", name: "Scribe", flavor: "Submitted your first story.", at: 1 },
    { id: "stories_2", name: "Correspondent", flavor: "Ten stories submitted.", at: 10 },
    { id: "stories_3", name: "Bureau Chief", flavor: "Fifty stories on the wire.", at: 50 },
  ]),
  ...ladder("comments", "comments", "💬", [
    { id: "comments_1", name: "Commentator", flavor: "Left your first comment.", at: 1 },
    { id: "comments_2", name: "Regular Caller", flavor: "Twenty-five comments.", at: 25 },
    { id: "comments_3", name: "Voice Of The Bay", flavor: "A hundred comments deep.", at: 100 },
  ]),
  ...ladder("curation", "storyVotes", "🗳️", [
    { id: "votes_1", name: "Reader", flavor: "Upvoted ten stories.", at: 10 },
    { id: "votes_2", name: "Curator", flavor: "A hundred votes cast.", at: 100 },
    { id: "votes_3", name: "Tastemaker", flavor: "Five hundred votes. You shape the page.", at: 500 },
  ]),

  // ── the graph ───────────────────────────────────────────────────────────────
  ...ladder("intros", "intros", "🤝", [
    { id: "intro_made", name: "Matchmaker", flavor: "Made your first warm intro.", at: 1 },
    { id: "intros_2", name: "Warm Wire", flavor: "Five intros that landed.", at: 5 },
    { id: "super_connector", name: "Super Connector", flavor: "Twenty-five accepted intros.", at: 25 },
    { id: "kingmaker", name: "Kingmaker", flavor: "A hundred introductions that stuck.", at: 100, icon: "👑", secret: true },
  ]),
  ...ladder("connections", "connections", "🫱", [
    { id: "connector", name: "Connector", flavor: "Logged a connection you made in person.", at: 1 },
    { id: "connections_2", name: "Rolodex", flavor: "Ten people met in the real world.", at: 10 },
    { id: "connections_3", name: "Whole Room", flavor: "Fifty in-person connections.", at: 50 },
  ]),
  ...ladder("friends", "friends", "👥", [
    { id: "friends_1", name: "Acquainted", flavor: "Your first accepted friend.", at: 1 },
    { id: "friends_2", name: "Well Connected", flavor: "Ten friends on The Bay.", at: 10 },
    { id: "friends_3", name: "Hub", flavor: "Fifty accepted connections.", at: 50 },
  ]),
  ...ladder("mentor", "mentorships", "🧭", [
    { id: "mentor_1", name: "Mentor", flavor: "Took on your first mentee.", at: 1 },
    { id: "mentor_2", name: "Guide", flavor: "Five accepted mentorships.", at: 5 },
    { id: "mentor_3", name: "Sensei", flavor: "Twenty people mentored.", at: 20 },
  ]),
  ...ladder("communities", "communities", "🏛️", [
    { id: "comm_1", name: "Joiner", flavor: "Joined your first community.", at: 1 },
    { id: "comm_2", name: "Multi Hyphenate", flavor: "Active in three communities.", at: 3 },
  ]),

  // ── hosting ─────────────────────────────────────────────────────────────────
  ...ladder("host", "hosted", "🎤", [
    { id: "first_host", name: "Host", flavor: "Hosted your first event.", at: 1 },
    { id: "host_2", name: "Impresario", flavor: "Five events hosted.", at: 5 },
    { id: "host_3", name: "Gym Leader", flavor: "Twenty-five events. You run a room.", at: 25 },
  ]),

  // ── the city ────────────────────────────────────────────────────────────────
  ...ladder("shadows", "shadows", "🌉", [
    { id: "first_shadow", name: "First Light", flavor: "Cast your first shadow over the Bay.", at: 1 },
    { id: "shadows_2", name: "Long Shadow", flavor: "Ten days of shadows cast.", at: 10 },
    { id: "shadows_3", name: "Eclipse", flavor: "Fifty days on the board.", at: 50 },
    { id: "ghost", name: "Ghost", flavor: "Two hundred days haunting the Bay.", at: 200, icon: "👻", secret: true },
  ]),
  ...ladder("cartographer", "shadowAreas", "🗺️", [
    { id: "area_explorer", name: "Area Explorer", flavor: "Cast from three corners of the Bay.", at: 3 },
    { id: "local_legend", name: "Local Legend", flavor: "Cast shadows from five corners of the Bay.", at: 5, icon: "🏴‍☠️" },
    { id: "cartographer_3", name: "Bay Wide", flavor: "Nine distinct areas covered.", at: 9 },
  ]),
  ...ladder("daily", "shadowStreak", "📆", [
    { id: "daily_1", name: "Daily Habit", flavor: "Three days running.", at: 3 },
    { id: "daily_2", name: "Fortnight", flavor: "Fourteen consecutive days.", at: 14 },
    { id: "daily_3", name: "Season", flavor: "Sixty days without missing one.", at: 60 },
  ]),
  ...ladder("places", "places", "🧭", [
    { id: "places_1", name: "Pathfinder", flavor: "Added your first place to the map.", at: 1 },
    { id: "places_2", name: "Placemaker", flavor: "Five places pinned.", at: 5 },
    { id: "places_3", name: "Surveyor General", flavor: "Twenty-five places on the map.", at: 25 },
  ]),
  ...ladder("confirms", "placeConfirms", "✅", [
    { id: "confirms_1", name: "Ground Truth", flavor: "Confirmed five places in person.", at: 5 },
    { id: "confirms_2", name: "Verifier", flavor: "Twenty-five confirmations.", at: 25 },
    { id: "confirms_3", name: "Notary", flavor: "A hundred places verified.", at: 100 },
  ]),

  // ── the long game ───────────────────────────────────────────────────────────
  ...ladder("level", "xp", "✨", [
    { id: "level_1", name: "Levelled Up", flavor: "Reached level 2.", at: 100 },
    { id: "level_2", name: "Seasoned", flavor: "Reached level 4.", at: 900 },
    { id: "level_3", name: "Veteran", flavor: "Reached level 6.", at: 2500 },
    { id: "level_4", name: "Legendary", flavor: "Reached level 11.", at: 10000, icon: "🌟" },
  ]),
  ...ladder("points", "points", "✦", [
    { id: "points_1", name: "Contributor", flavor: "A hundred points earned.", at: 100 },
    { id: "points_2", name: "Pillar", flavor: "A thousand points on the board.", at: 1000 },
    { id: "points_3", name: "Cornerstone", flavor: "Five thousand points.", at: 5000 },
  ]),
];

const BY_ID = new Map(TROPHIES.map((t) => [t.id, t]));

/** Lookup by award `kind`. Undefined for an unknown kind — including the internal
 *  `shadow_area` counter, which is deliberately NOT a trophy. */
export function trophyById(id: string): Trophy | undefined {
  return BY_ID.get(id);
}

/** The ladders, each sorted by tier. Used for the tiered trophy case and by the
 *  catalog tests that enforce ascending thresholds. */
export function series(): Record<string, Trophy[]> {
  const out: Record<string, Trophy[]> = {};
  for (const t of TROPHIES) (out[t.series] ||= []).push(t);
  for (const rungs of Object.values(out)) rungs.sort((a, b) => a.tier - b.tier);
  return out;
}

/** Casefold to bare words, so "L0cal-Legend!" and "local  legend" collide.
 *  Aggressive on purpose: this is the comparison a host-minted badge label is
 *  checked against, and homoglyph games are the obvious next move. */
export function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/1/g, "l")
    .replace(/3/g, "e")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Every canonical trophy name, normalised — the reserved-label list a host badge is
 * checked against (migrations/0028, `src/core/gym/badge.ts`). Derived from
 * `TROPHIES` rather than hand-maintained, so a new trophy reserves its own name and
 * nobody has to remember to update a second list.
 */
export const TROPHY_LABELS: readonly string[] = [...new Set(TROPHIES.map((t) => normalizeLabel(t.name)))];
