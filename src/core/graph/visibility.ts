/**
 * WHO MAY SEE WHOM. One function, and every user the projection is about to emit goes
 * through it.
 *
 * This is the highest-stakes file in the graph. A stale search index is a missed result; a
 * leaky graph *publishes a relationship a user revoked* — it tells a stranger that a
 * `social_enabled = 0` person attended an event, or draws a line to somebody who blocked
 * them. So the rules are not spread across a dozen SQL predicates that each handler must
 * remember; they are here, they are pure, and `tests/graph-projection.test.ts` attacks them
 * directly.
 *
 * ## The rules
 *
 * | subject | visible to |
 * |---|---|
 * | yourself | always |
 * | anyone | only if `social_enabled = 1 AND banned_at IS NULL` … |
 * | …EXCEPT an accepted friend at hop 1 | visible even with `social_enabled = 0` |
 * | somebody in a `blocked` friendship | never, in either direction, at any hop |
 * | a banned VIEWER | sees nothing at all |
 *
 * ## Why the friend exemption stops at hop 1
 *
 * `SocialRepo.listFriends` deliberately shows you a friend who has social sharing off —
 * `social-repo.ts:262` documents the "can't open my friend" bug that forced it. Parity
 * matters, or your own friends list and your own graph would disagree about who exists.
 *
 * But the exemption must NOT travel. A `social_enabled = 0` friend of yours may appear as
 * YOUR friend; they must never appear as somebody else's co-attendee, and never as an
 * interior node on a path between two other people. Extending it one hop further would turn
 * an opt-out into "opted out, unless you know someone who knows me", which is not an opt-out.
 */

export interface ViewerCtx {
  /** Null for an anonymous viewer. */
  id: string | null;
  /** A banned viewer gets an empty graph rather than a filtered one. */
  banned: boolean;
  /** Accepted friendships — the hop-1 exemption set. */
  friends: Set<string>;
  /** `friendships.status = 'blocked'` in either direction. A hard, mutual cut. */
  blocked: Set<string>;
}

export interface UserFacts {
  id: string;
  socialEnabled: boolean;
  bannedAt: string | null;
}

export const ANON_VIEWER: ViewerCtx = { id: null, banned: false, friends: new Set(), blocked: new Set() };

/**
 * May `viewer` see `u`, reached at `hop` hops from the viewer?
 *
 * `hop` is required rather than optional on purpose: a caller that doesn't know how far away
 * a node is cannot correctly apply the friend exemption, and defaulting it would silently
 * pick the permissive branch.
 */
export function canSeeUser(viewer: ViewerCtx, u: UserFacts, hop: number): boolean {
  if (viewer.banned) return false;
  // Blocking outranks everything, including being yourself in a corrupted row and including
  // the friend exemption. Nothing enforced this before.
  if (viewer.blocked.has(u.id)) return false;
  if (viewer.id && u.id === viewer.id) return true;
  if (u.bannedAt) return false;
  if (u.socialEnabled) return true;
  return hop <= 1 && viewer.friends.has(u.id);
}

/** Events and places are already public through `/api/events` and `/api/places`; the only
 *  question is moderation. Kept here so "what hides a node" has one home. */
export function canSeeEvent(e: { hidden?: number | boolean | null }): boolean {
  return !e.hidden;
}
export function canSeePlace(p: { hidden?: number | boolean | null }): boolean {
  return !p.hidden;
}
export function canSeeStory(s: { dead?: number | boolean | null }): boolean {
  return !s.dead;
}

/**
 * The SQL fragment for the cheap half of user visibility — the part that is unconditional
 * and therefore belongs in the query rather than in memory.
 *
 * Deliberately NOT the whole rule: the friend exemption and the block set depend on the
 * viewer's own graph, and encoding those as SQL means binding a variable-length id list into
 * every user join, which is how you end up over D1's 100-parameter cap. `canSeeUser` is the
 * decider; this is an index-friendly pre-filter that reduces what we hydrate.
 */
export const VISIBLE_USER_SQL = "u.banned_at IS NULL";
