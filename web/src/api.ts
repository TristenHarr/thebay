import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The single typed server-state layer. Every screen reads/writes through these
 * RTK Query endpoints — no hand-rolled fetching anywhere in the app. Cache
 * invalidation via tags keeps the UI consistent after mutations.
 */
export const api = createApi({
  reducerPath: "api",
  baseQuery: fetchBaseQuery({ baseUrl: "/", credentials: "same-origin" }),
  tagTypes: [
    "Me", "Events", "Event", "Goals", "Friends", "Groups", "Group", "Rankings", "Intros", "Mentors",
    "Match", "Media", "Communities", "Obligations", "Integrations", "Achievements", "Agent", "Reviews",
    "Notes", "Shadows", "MyShadow",
    // Reserved by M0 for the parallel tracks — declared up front so no two tracks
    // have to edit this line.
    "Search", "Vibes", "Places", "PlaceKinds", "MapPacks", "Companies", "Rounds", "Outcomes", "Attribution",
    "Xp", // Experience / leveling (Trails game)
    "Pokedex", // Founder catches (the Pokédex)
    "Crawls", // Founder crawls (planned routes)
    "Rank", // The learning loop — the live ranking model
    "Trophies", // The declarative trophy catalog (src/core/trophies)
    "Gyms", "Gym", // Hosts as gym leaders (migrations/0028)
    "Graph", // The multi-entity evidenced projection (src/core/graph)
    "Identity", "Card", // Founder types, vouches + the card (migrations/0031)
    "Net", "NetRecipes", // The scrape network — membership, clients, recipes
  ],
  endpoints: (b) => ({
    // auth + profile
    getMe: b.query<{ user: any | null; points?: number }, void>({ query: () => "api/me", providesTags: ["Me"] }),
    updateMe: b.mutation<any, any>({ query: (body) => ({ url: "api/me", method: "PATCH", body }), invalidatesTags: ["Me"] }),
    logout: b.mutation<any, void>({ query: () => ({ url: "auth/logout", method: "POST" }), invalidatesTags: ["Me"] }),
    devLogin: b.mutation<any, { email: string; name: string }>({ query: (body) => ({ url: "auth/dev", method: "POST", body }), invalidatesTags: ["Me"] }),
    registerPassword: b.mutation<any, { email: string; password: string; name?: string }>({ query: (body) => ({ url: "auth/password/register", method: "POST", body }), invalidatesTags: ["Me"] }),
    loginPassword: b.mutation<any, { email: string; password: string }>({ query: (body) => ({ url: "auth/password/login", method: "POST", body }), invalidatesTags: ["Me"] }),
    getProfile: b.query<any, string>({ query: (handle) => `api/u/${handle}` }),
    getPublicGoals: b.query<{ goals: any[] }, string>({ query: (handle) => `api/u/${handle}/goals` }),
    getPersonReviews: b.query<{ reviews: any[]; rating: { avg: number | null; count: number; byRole: Record<string, { avg: number; count: number }> } }, string>({ query: (handle) => `api/u/${handle}/reviews`, providesTags: ["Reviews"] }),
    reviewPerson: b.mutation<any, { userId: string; subjectType: string; rating: number; body?: string; eventId?: string }>({ query: ({ userId, ...body }) => ({ url: `api/users/${userId}/review`, method: "POST", body }), invalidatesTags: ["Reviews"] }),

    // events
    getEvents: b.query<{ events: any[]; total: number; facets: any }, string | void>({ query: (qs) => `api/events${qs || "?limit=200"}`, providesTags: ["Events"] }),
    // The personalized feed. Same filter grammar as `api/events`, but ranked for the
    // viewer, and it is the request that records impressions — so it must not be used for
    // background prefetching or the training set fills up with rows nobody saw.
    // ── the scrape network (migrations/0023 + /0025) ─────────────────────────
    // Membership, the animated in-person handshake, worker clients and the recipe queue.
    getNetMe: b.query<any, void>({ query: () => "api/net/me", providesTags: ["Net"] }),
    // Starts a ~30s handshake session and returns its whole frame list. NOT cached and
    // deliberately a mutation: each call revokes the session before it, so a cached replay
    // would hand out a code the server has already retired.
    startHandshake: b.mutation<any, { lat: number; lng: number }>({
      query: (body) => ({ url: "api/net/invite", method: "POST", body }),
    }),
    joinNetwork: b.mutation<any, { sessionId: string; frames: Array<{ step: number; code: string }>; lat: number; lng: number }>({
      query: (body) => ({ url: "api/net/join", method: "POST", body }),
      // Joining creates a real friendship and pays both sides, so the whole social surface
      // is stale afterwards.
      invalidatesTags: ["Net", "Me", "Friends", "Achievements"],
    }),
    registerClient: b.mutation<any, { kind: "cli" | "extension" | "web" | "app"; label?: string; capabilities?: string[] }>({
      query: (body) => ({ url: "api/net/clients", method: "POST", body }),
      invalidatesTags: ["Net"],
    }),
    revokeClient: b.mutation<any, string>({
      query: (id) => ({ url: `api/net/clients/${id}`, method: "DELETE" }),
      invalidatesTags: ["Net"],
    }),
    getNetLeaderboard: b.query<{ board: any[] }, void>({ query: () => "api/net/leaderboard", providesTags: ["Net"] }),
    getNetRecipes: b.query<{ recipes: any[] }, void>({ query: () => "api/net/recipes", providesTags: ["NetRecipes"] }),
    proposeRecipe: b.mutation<any, { sourceId: string; type: string; params: Record<string, unknown>; notes?: string }>({
      query: (body) => ({ url: "api/net/recipes", method: "POST", body }),
      invalidatesTags: ["NetRecipes"],
    }),
    getForYou: b.query<{ events: any[]; total: number; facets: any; ranking: { model: number | null; rescored: boolean; explored: boolean; pool: number } }, string | void>({
      query: (qs) => `api/events/foryou${qs || "?limit=100"}`,
      providesTags: ["Events"],
    }),
    // Deliberately invalidates NOTHING: refetching the feed on a click would reorder the
    // page under the cursor of the person who just clicked.
    rankFeedback: b.mutation<{ ok: boolean; applied: boolean }, { surface: "events" | "news" | "shadows"; itemId: string; kind: "open" | "dismiss" }>({
      query: (body) => ({ url: "api/rank/feedback", method: "POST", body }),
    }),
    getRankModel: b.query<Record<string, any>, string | void>({
      query: (surface) => `api/rank/model${surface ? `?surface=${surface}` : ""}`,
      providesTags: ["Rank"],
    }),
    getEventFull: b.query<any, string>({ query: (id) => `api/event/${id}/full`, providesTags: (_r, _e, id) => [{ type: "Event", id }] }),
    rsvp: b.mutation<any, { id: string; status: string }>({ query: ({ id, status }) => ({ url: `api/events/${id}/rsvp`, method: "POST", body: { status } }), invalidatesTags: (_r, _e, a) => ["Me", "Events", { type: "Event", id: a.id }, "Obligations"] }),
    // event reviews feed Host-NPS, so Rankings must refresh too
    reviewEvent: b.mutation<any, { id: string; rating: number; body?: string }>({ query: ({ id, ...body }) => ({ url: `api/events/${id}/review`, method: "POST", body }), invalidatesTags: (_r, _e, a) => [{ type: "Event", id: a.id }, "Obligations", "Me", "Rankings"] }),
    host: b.mutation<any, any>({ query: (body) => ({ url: "api/host", method: "POST", body }), invalidatesTags: ["Events"] }),

    // goals + obligations + achievements
    getGoals: b.query<{ goals: any[] }, void>({ query: () => "api/goals", providesTags: ["Goals"] }),
    createGoal: b.mutation<any, any>({ query: (body) => ({ url: "api/goals", method: "POST", body }), invalidatesTags: ["Goals"] }),
    updateGoal: b.mutation<any, { id: string; patch: any }>({ query: ({ id, patch }) => ({ url: `api/goals/${id}`, method: "PATCH", body: patch }), invalidatesTags: ["Goals"] }),
    getObligations: b.query<{ pending: string[] }, void>({ query: () => "api/me/obligations", providesTags: ["Obligations"] }),

    // social graph
    getFriends: b.query<{ friends: any[]; pending: any[] }, void>({ query: () => "api/friends", providesTags: ["Friends"] }),
    requestFriend: b.mutation<any, string>({ query: (uid) => ({ url: `api/friends/${uid}/request`, method: "POST" }), invalidatesTags: ["Friends", "Integrations"] }),
    respondFriend: b.mutation<any, { uid: string; accept: boolean }>({ query: ({ uid, accept }) => ({ url: `api/friends/${uid}/respond`, method: "POST", body: { accept } }), invalidatesTags: ["Friends"] }),
    friendsFeed: b.query<{ items: any[] }, void>({ query: () => "api/feed/friends" }),

    getGroups: b.query<{ groups: any[] }, void>({ query: () => "api/groups", providesTags: ["Groups"] }),
    createGroup: b.mutation<any, { name: string; eventId?: string }>({ query: (body) => ({ url: "api/groups", method: "POST", body }), invalidatesTags: ["Groups"] }),
    getGroup: b.query<any, string>({ query: (id) => `api/groups/${id}`, providesTags: (_r, _e, id) => [{ type: "Group", id }] }),
    sendMessage: b.mutation<any, { id: string; body: string }>({ query: ({ id, body }) => ({ url: `api/groups/${id}/messages`, method: "POST", body: { body } }) }),

    getLeaderboard: b.query<{ rows: any[] }, string | void>({ query: (scope) => `api/leaderboard${scope ? `?scope=${scope}` : ""}` }),
    getRankings: b.query<{ rows: any[]; metric: string }, string | void>({ query: (metric) => `api/rankings${metric ? `?metric=${metric}` : ""}`, providesTags: ["Rankings"] }),

    // intros
    getIntros: b.query<{ mine: any[]; inbox: any[]; incoming: any[] }, void>({ query: () => "api/intros", providesTags: ["Intros"] }),
    createIntro: b.mutation<any, { targetDesc: string; targetUserId?: string }>({ query: (body) => ({ url: "api/intros", method: "POST", body }), invalidatesTags: ["Intros"] }),
    forwardIntro: b.mutation<any, string>({ query: (reqId) => ({ url: `api/intros/${reqId}/forward`, method: "POST" }), invalidatesTags: ["Intros"] }),
    acceptIntro: b.mutation<any, string>({ query: (fwdId) => ({ url: `api/intros/forward/${fwdId}/accept`, method: "POST" }), invalidatesTags: ["Intros", "Friends"] }),

    // mentors + matching
    getMentors: b.query<{ mentors: any[] }, string | void>({ query: (topic) => `api/mentors${topic ? `?topic=${topic}` : ""}`, providesTags: ["Mentors"] }),
    setMentorProfile: b.mutation<any, any>({ query: (body) => ({ url: "api/mentors/me", method: "PUT", body }), invalidatesTags: ["Mentors"] }),
    requestMentor: b.mutation<any, { mentorId: string; message?: string }>({ query: ({ mentorId, message }) => ({ url: `api/mentors/${mentorId}/request`, method: "POST", body: { message } }) }),
    mentorInbox: b.query<{ requests: any[] }, void>({ query: () => "api/mentors/inbox", providesTags: ["Mentors"] }),
    respondMentor: b.mutation<any, { id: string; accept: boolean }>({ query: ({ id, accept }) => ({ url: `api/mentor-requests/${id}/respond`, method: "POST", body: { accept } }), invalidatesTags: ["Mentors", "Friends"] }),
    getDeck: b.query<{ deck: any[] }, void>({ query: () => "api/match/deck", providesTags: ["Match"] }),
    setMatchPrefs: b.mutation<any, any>({ query: (body) => ({ url: "api/match/prefs", method: "PUT", body }) }),
    matchAct: b.mutation<{ matched: boolean }, { targetId: string; action: string }>({ query: ({ targetId, action }) => ({ url: `api/match/${targetId}`, method: "POST", body: { action } }), invalidatesTags: ["Match", "Friends"] }),

    // communities + media + integrations
    // QR check-in
    issueCheckinToken: b.mutation<{ ok: boolean; token: string }, string>({ query: (eventId) => ({ url: `api/events/${eventId}/checkin-token`, method: "POST" }) }),
    checkIn: b.mutation<{ result: string }, { eventId: string; token: string }>({ query: ({ eventId, token }) => ({ url: `api/events/${eventId}/checkin`, method: "POST", body: { token } }), invalidatesTags: ["Me", "Achievements", "Obligations"] }),
    getCheckins: b.query<{ count: number; checkins: any[] }, string>({ query: (eventId) => `api/events/${eventId}/checkins` }),

    getAchievements: b.query<{ achievements: any[]; streaks: any[]; points: any[] }, void>({ query: () => "api/me/achievements", providesTags: ["Achievements"] }),
    getPublicAchievements: b.query<{ achievements: any[]; streaks: any[] }, string>({ query: (handle) => `api/u/${handle}/achievements` }),
    // The whole trophy catalog, earned and locked. Also provides "Achievements" on
    // purpose: every mutation that pays points already invalidates that tag (check-in,
    // shadow, vibe report, place), so trophies refresh with zero changes at those
    // ~6 call sites. The endpoint reconciles server-side, so the response can report
    // `justUnlocked`.
    getTrophies: b.query<
      { progress: any[]; nextUp: any[]; earnedCount: number; total: number; xpFromTrophies: number; justUnlocked: string[] },
      void
    >({ query: () => "api/trophies", providesTags: ["Trophies", "Achievements"] }),

    // ── gyms: hosts award XP, capped by verified dwell ────────────────────────
    getGymsHosted: b.query<{ hosted: any[] }, void>({ query: () => "api/gyms/hosted", providesTags: ["Gyms"] }),
    getGym: b.query<any, string>({ query: (eventId) => `api/events/${eventId}/gym`, providesTags: (_r, _e, id) => [{ type: "Gym", id }] }),
    getMyGymAwards: b.query<{ awards: any[] }, void>({ query: () => "api/me/gym-awards", providesTags: ["Gyms"] }),

    // ── founder types, cards + host badges ────────────────────────────────────
    getFounderTypes: b.query<{ types: any[] }, void>({ query: () => "api/founder-types" }),
    getMyIdentity: b.query<{ typeId: string | null; type2Id: string | null; vouches: Record<string, number> }, void>({
      query: () => "api/me/identity",
      providesTags: ["Identity"],
    }),
    setMyIdentity: b.mutation<any, { typeId: string; type2Id?: string | null }>({
      query: (body) => ({ url: "api/me/identity", method: "PUT", body }),
      invalidatesTags: ["Identity", "Card", "Me"],
    }),
    getMyCard: b.query<{ card: any }, void>({ query: () => "api/me/card", providesTags: ["Card"] }),
    getUserCard: b.query<{ card: any }, string>({ query: (handle) => `api/u/${handle}/card` }),
    vouchType: b.mutation<any, { userId: string; typeId: string; eventId?: string }>({
      query: ({ userId, ...body }) => ({ url: `api/users/${userId}/vouch`, method: "POST", body }),
      invalidatesTags: ["Identity", "Card"],
    }),
    getEventAffinity: b.query<any, string>({ query: (eventId) => `api/events/${eventId}/affinity`, providesTags: ["Identity"] }),
    getEventBadges: b.query<{ badges: any[] }, string>({ query: (eventId) => `api/events/${eventId}/gym/badges`, providesTags: (_r, _e, id) => [{ type: "Gym", id }] }),
    mintGymBadge: b.mutation<any, { eventId: string; label: string; emoji: string; color?: string; blurb?: string }>({
      query: ({ eventId, ...body }) => ({ url: `api/events/${eventId}/gym/badges`, method: "POST", body }),
      invalidatesTags: (_r, _e, a) => [{ type: "Gym", id: a.eventId }],
    }),
    awardGymBadge: b.mutation<any, { eventId: string; badgeId: string; userId: string }>({
      query: ({ eventId, badgeId, userId }) => ({ url: `api/events/${eventId}/gym/badges/${badgeId}/award`, method: "POST", body: { userId } }),
      invalidatesTags: (_r, _e, a) => [{ type: "Gym", id: a.eventId }, "Card"],
    }),
    // The read path that never existed — see GraphRepo.matchPrefs.
    getMatchPrefs: b.query<{ prefs: any | null }, void>({ query: () => "api/me/match-prefs", providesTags: ["Match"] }),
    setGymPolicy: b.mutation<any, { eventId: string; mode: string; flatXp?: number; bounties?: any[] }>({
      query: ({ eventId, ...body }) => ({ url: `api/events/${eventId}/gym`, method: "PUT", body }),
      invalidatesTags: (_r, _e, a) => [{ type: "Gym", id: a.eventId }, "Gyms"],
    }),
    armGym: b.mutation<any, string>({
      query: (eventId) => ({ url: `api/events/${eventId}/gym/arm`, method: "POST" }),
      invalidatesTags: (_r, _e, id) => [{ type: "Gym", id }, "Gyms"],
    }),
    settleGym: b.mutation<any, string>({
      query: (eventId) => ({ url: `api/events/${eventId}/gym/settle`, method: "POST" }),
      invalidatesTags: (_r, _e, id) => [{ type: "Gym", id }, "Gyms"],
    }),
    // An award mints XP, so Me/Xp/Trophies all move with it.
    awardGym: b.mutation<any, { eventId: string; userId: string; xp?: number; bountyKey?: string; note?: string }>({
      query: ({ eventId, ...body }) => ({ url: `api/events/${eventId}/gym/awards`, method: "POST", body }),
      invalidatesTags: (_r, _e, a) => [{ type: "Gym", id: a.eventId }, "Me", "Xp", "Trophies"],
    }),
    bulkAwardGym: b.mutation<any, { eventId: string; awards: Array<{ userId: string; xp?: number }> }>({
      query: ({ eventId, awards }) => ({ url: `api/events/${eventId}/gym/awards/bulk`, method: "POST", body: { awards } }),
      invalidatesTags: (_r, _e, a) => [{ type: "Gym", id: a.eventId }, "Me", "Xp", "Trophies"],
    }),
    revokeGymAward: b.mutation<any, { eventId: string; awardId: string; reason: string }>({
      query: ({ eventId, awardId, reason }) => ({ url: `api/events/${eventId}/gym/awards/${awardId}`, method: "DELETE", body: { reason } }),
      invalidatesTags: (_r, _e, a) => [{ type: "Gym", id: a.eventId }, "Me", "Xp"],
    }),
    // Returns the door secret ONCE — it is never stored in the clear, so this response
    // is the only place it exists. Not cached, deliberately.
    mintDoorCode: b.mutation<{ codeId: string; expiresAt: string; url: string; rotateMs: number; ttlMs: number }, { eventId: string; lat: number; lng: number }>({
      query: ({ eventId, ...body }) => ({ url: `api/events/${eventId}/door`, method: "POST", body }),
    }),
    claimPresence: b.mutation<any, { eventId: string; codeId: string; secret: string; lat: number; lng: number }>({
      query: ({ eventId, ...body }) => ({ url: `api/events/${eventId}/presence`, method: "POST", body }),
      invalidatesTags: (_r, _e, a) => [{ type: "Gym", id: a.eventId }, "Me", "Achievements", "Obligations"],
    }),
    getNetworkGraph: b.query<{ nodes: any[]; edges: any[] }, void>({ query: () => "api/network/graph", providesTags: ["Friends"] }),
    // The typed, evidenced projection. `Friends` on purpose: accepting a friend request or
    // blocking somebody changes who is in the graph, and those mutations already invalidate it.
    getGraph: b.query<{ nodes: any[]; edges: any[]; omitted: any }, string | void>({
      query: (qs) => `api/graph${qs || ""}`,
      providesTags: ["Friends", "Graph"],
    }),
    getGraphGeo: b.query<{ nodes: any[]; edges: any[]; omitted: any }, void>({
      query: () => "api/graph/geo",
      providesTags: ["Friends", "Graph"],
    }),
    getGraphPath: b.query<{ path: any; why: string[]; reasons: any[]; visible: boolean; exhausted: boolean; nodes: any[] }, string>({
      query: (targetId) => `api/graph/path/${targetId}`,
      providesTags: ["Graph"],
    }),
    // map bulletin board (legacy — superseded by shadows)
    getNotes: b.query<{ notes: any[] }, void>({ query: () => "api/notes", providesTags: ["Notes"] }),
    postNote: b.mutation<{ ok: boolean; id: string }, { lat: number; lng: number; body: string }>({ query: (body) => ({ url: "api/notes", method: "POST", body }), invalidatesTags: ["Notes"] }),

    // shadows — the live, ephemeral, location-sharded board
    getShadows: b.query<{ shadows: any[] }, string>({ query: (cells) => `api/shadows?cells=${cells}`, providesTags: ["Shadows"] }),
    getHeat: b.query<{ precision: number; cells: { cell: string; count: number }[] }, number | void>({ query: (p) => `api/shadows/heat${p ? `?precision=${p}` : ""}`, providesTags: ["Shadows"] }),
    getMyShadow: b.query<{ active: { id: string; cell: string } | null }, void>({ query: () => "api/shadows/mine", providesTags: ["MyShadow"] }),
    postShadow: b.mutation<{ ok: boolean; id: string; cell: string; expiresAt: string; replaced: any }, { lat: number; lng: number; kind: string; body?: string; mediaKey?: string; streamId?: string; connectionUserId?: string }>({
      query: (body) => ({ url: "api/shadows", method: "POST", body }),
      invalidatesTags: ["Shadows", "MyShadow", "Me", "Achievements"], // casting awards points + badges
    }),
    reactShadow: b.mutation<{ ok: boolean }, { id: string; emoji: string; on?: boolean }>({ query: ({ id, ...body }) => ({ url: `api/shadows/${id}/react`, method: "POST", body }), invalidatesTags: ["Shadows"] }),
    reportShadow: b.mutation<{ ok: boolean }, string>({ query: (id) => ({ url: `api/shadows/${id}/report`, method: "POST" }), invalidatesTags: ["Shadows"] }),
    deleteShadow: b.mutation<{ ok: boolean; deleted: boolean }, string>({ query: (id) => ({ url: `api/shadows/${id}`, method: "DELETE" }), invalidatesTags: ["Shadows", "MyShadow"] }),

    // Experience / leveling (the Trails game)
    getMyXp: b.query<{ level: number; xp: number; xpIntoLevel: number; xpForNext: number; toNext: number; pct: number; breakdown: { kind: string; xp: number; count: number }[] }, void>({ query: () => "api/me/xp", providesTags: ["Xp"] }),
    getXpLeaderboard: b.query<{ metric: string; rows: any[] }, string | void>({ query: (metric) => `api/xp/leaderboard${metric ? `?metric=${metric}` : ""}`, providesTags: ["Xp"] }),

    // Mobbing — live movement → XP + trails + the living map
    pingMovement: b.mutation<{ dist: number; xp: number; mps: number; flagged: boolean; cappedToday: boolean; cell: string; level: any }, { lat: number; lng: number; scope?: string }>({
      query: (body) => ({ url: "api/movement/ping", method: "POST", body }),
      invalidatesTags: ["Xp"],
    }),
    getMyTrail: b.query<{ trail: { lat: number; lng: number; at: string }[] }, void>({ query: () => "api/movement/trail" }),
    getMovementLive: b.query<{ dots: { lat: number; lng: number }[] }, string>({ query: (cells) => `api/movement/live?cells=${cells}` }),
    getOrbs: b.query<{ epoch: number; orbs: { id: string; lat: number; lng: number; xp: number }[] }, string>({ query: (cells) => `api/orbs?cells=${cells}`, providesTags: ["Xp"] }),
    pickupOrb: b.mutation<{ ok: boolean; xp?: number; reason?: string; level?: any }, { orbId: string; lat: number; lng: number }>({ query: (body) => ({ url: "api/orbs/pickup", method: "POST", body }), invalidatesTags: ["Xp"] }),

    // Catches — the founder Pokédex
    mintCatchToken: b.mutation<{ token: string }, void>({ query: () => ({ url: "api/catches/token", method: "POST" }) }),
    scanCatch: b.mutation<{ ok: boolean; reason?: string; caught?: any; xp?: number; level?: any }, { token: string }>({ query: (body) => ({ url: "api/catches/scan", method: "POST", body }), invalidatesTags: ["Pokedex", "Xp"] }),
    getPokedex: b.query<{ pokedex: any[] }, void>({ query: () => "api/catches", providesTags: ["Pokedex"] }),
    getMyStats: b.query<{ stats: any }, void>({ query: () => "api/me/stats", providesTags: ["Xp"] }),

    // Founder crawls — planned, shareable routes
    getCrawls: b.query<{ crawls: any[] }, void>({ query: () => "api/crawls", providesTags: ["Crawls"] }),
    getCrawl: b.query<{ crawl: any; stops: any[]; participants: any[] }, string>({ query: (id) => `api/crawls/${id}`, providesTags: (_r, _e, id) => [{ type: "Crawls", id }] }),
    createCrawl: b.mutation<{ ok: boolean; id: string }, { name: string; description?: string; stops: { name: string; lat: number; lng: number }[] }>({ query: (body) => ({ url: "api/crawls", method: "POST", body }), invalidatesTags: ["Crawls"] }),
    joinCrawl: b.mutation<{ ok: boolean }, string>({ query: (id) => ({ url: `api/crawls/${id}/join`, method: "POST" }), invalidatesTags: (_r, _e, id) => [{ type: "Crawls", id }, "Crawls"] }),
    checkpointCrawl: b.mutation<any, { id: string; stopIdx: number; lat: number; lng: number }>({ query: ({ id, ...body }) => ({ url: `api/crawls/${id}/checkpoint`, method: "POST", body }), invalidatesTags: (_r, _e, a) => [{ type: "Crawls", id: a.id }, "Xp"] }),

    getCommunities: b.query<{ communities: any[] }, void>({ query: () => "api/communities", providesTags: ["Communities"] }),
    createCommunity: b.mutation<any, { name: string; kind?: string }>({ query: (body) => ({ url: "api/communities", method: "POST", body }), invalidatesTags: ["Communities"] }),
    getCommunity: b.query<{ community: any; members: any[]; metric: string; rankings: any[] }, { id: string; metric?: string }>({ query: ({ id, metric }) => `api/communities/${id}${metric ? `?metric=${metric}` : ""}`, providesTags: (_r, _e, a) => [{ type: "Communities", id: a.id }] }),
    joinCommunity: b.mutation<any, string>({ query: (id) => ({ url: `api/communities/${id}/join`, method: "POST" }), invalidatesTags: (_r, _e, id) => [{ type: "Communities", id }, "Communities"] }),
    getMedia: b.query<{ media: any[] }, void>({ query: () => "api/me/media", providesTags: ["Media"] }),
    getEventMedia: b.query<{ media: any[] }, string>({ query: (id) => `api/events/${id}/media`, providesTags: ["Media"] }),
    getAgenda: b.query<{ events: any[] }, void>({ query: () => "api/me/agenda", providesTags: ["Events"] }),
    // AI
    getResearch: b.query<{ brief: any; aiEnhanced: boolean }, string>({ query: (id) => `api/events/${id}/research` }),
    getAgent: b.query<{ enabled: boolean; mode: string; hasAiKey: boolean; aiModel: string | null }, void>({ query: () => "api/me/agent", providesTags: ["Agent"] }),
    setAgent: b.mutation<any, { enabled?: boolean; mode?: string; openrouterKey?: string; openrouterModel?: string }>({ query: (body) => ({ url: "api/me/agent", method: "PUT", body }), invalidatesTags: ["Agent"] }),
    getAgentSuggestions: b.query<{ suggestions: any[] }, void>({ query: () => "api/me/agent/suggestions" }),
    attachMedia: b.mutation<any, { id: string; eventId?: string; caption?: string }>({ query: ({ id, ...body }) => ({ url: `api/media/${id}`, method: "PATCH", body }), invalidatesTags: ["Media"] }),
    getIntegrations: b.query<{ accounts: any[] }, void>({ query: () => "api/integrations", providesTags: ["Integrations"] }),
    getImported: b.query<{ items: any[] }, string>({ query: (provider) => `api/integrations/${provider}/items`, providesTags: ["Integrations"] }),
    getSuggestions: b.query<{ suggestions: any[] }, void>({ query: () => "api/integrations/suggestions", providesTags: ["Integrations", "Friends"] }),
    connectIntegration: b.mutation<any, { provider: string; token?: any }>({ query: ({ provider, token }) => ({ url: `api/integrations/${provider}/connect`, method: "POST", body: token || {} }), invalidatesTags: ["Integrations"] }),
    importIntegration: b.mutation<{ imported: number; total: number }, { provider: string; ics?: string; items?: any[] }>({ query: ({ provider, ...body }) => ({ url: `api/integrations/${provider}/import`, method: "POST", body }), invalidatesTags: ["Integrations"] }),
    subscribeCalendar: b.mutation<{ url: string }, void>({ query: () => ({ url: "api/me/calendar/subscribe", method: "POST" }) }),

    // ─────────────────────────────────────────────────────────────────────────
    // Parallel-track regions. Each track appends ONLY inside its own block, so
    // five agents can edit this file without contending for the same lines.
    // Keep the markers even when a block is empty.
    // ─────────────────────────────────────────────────────────────────────────
    // track:A search — hybrid FTS5 + vector search, NL query understanding
    // A POST endpoint used as a QUERY: the request is a structured document
    // (free-text + facet arrays + a window), which does not survive a query string
    // legibly, and RTK Query caches a POST `b.query` by its serialized arg exactly
    // as it does a GET. Discover keeps 3,000 events out of the browser this way.
    searchEvents: b.query<
      {
        query: { raw: string; source: "llm" | "deterministic"; intent: string; semanticQuery: string; filters: any; applied: any; relaxed: boolean };
        events: any[];
        total: number;
        facets: { tags: Array<{ value: string; facet: string; label: string; emoji: string | null; color: string | null; count: number }>; cities: Array<{ value: string; count: number }>; sources: Array<{ value: string; count: number }> };
        used: { fts: boolean; vector: boolean };
        /** Present only on a BROWSE (no text query, default sort, first page) — the one
         *  request that personalizes and records impressions. `null` on an explicit
         *  search or sort, which is answered verbatim. */
        ranking: { model: number | null; rescored: boolean; explored: boolean; window: number } | null;
        limit: number;
        offset: number;
        nextOffset: number | null;
      },
      {
        q?: string;
        filters?: { free?: boolean; tags?: string[]; near?: string; cities?: string[]; sources?: string[]; window?: string; from?: string; to?: string; minScore?: number };
        sort?: "relevance" | "soonest" | "interesting";
        limit?: number;
        offset?: number;
        understand?: boolean;
        semantic?: boolean;
      }
    >({
      query: (body) => ({ url: "api/search", method: "POST", body }),
      providesTags: ["Search"],
    }),
    // The live tag vocabulary (tag_vocab). Facet chips render from THIS, so adding
    // a tag is a row in D1 — no redeploy of the Worker or the app.
    getSearchTags: b.query<{ tags: any[]; facets: Record<string, any[]> }, void>({
      query: () => "api/search/tags",
      providesTags: ["Search"],
    }),
    // end:A
    // track:B vibes — predicted + crowd-reported event vibe profiles
    // The card always resolves (the server materialises a deterministic prediction
    // on first read), so callers never need a "no vibe" branch for a real event.
    getVibe: b.query<{ vibe: any; myReport: any | null; canReport: boolean }, string>({
      query: (id) => `api/events/${id}/vibe`,
      providesTags: (_r, _e, id) => [{ type: "Vibes", id }],
    }),
    // Reporting a room you checked into pays points, so Me/Achievements refresh too.
    reportVibe: b.mutation<{ ok: boolean; verified: boolean; vibe: any }, { eventId: string; energy: number; formality: number; intimacy: number; talkRatio: number; signal: number; approachability: number; crowd?: Record<string, number>; tags?: string[]; worthIt?: number }>({
      query: ({ eventId, ...body }) => ({ url: `api/events/${eventId}/vibe/report`, method: "POST", body }),
      invalidatesTags: (_r, _e, a) => [{ type: "Vibes", id: a.eventId }, "Vibes", "Me", "Achievements"],
    }),
    getVibePrompts: b.query<{ pending: Array<{ eventId: string; title: string; startUtc: string; checkedInAt: string }> }, void>({
      query: () => "api/me/vibe-prompts",
      providesTags: ["Vibes"],
    }),
    // Axis ranges + best-for tags as a query string, e.g. "?signalMin=70&bestFor=raising".
    searchVibes: b.query<{ vibes: any[]; count: number }, string | void>({
      query: (qs) => `api/vibes${qs || ""}`,
      providesTags: ["Vibes"],
    }),
    // end:B
    // track:C places — crowd city map, parking, community-proposed kinds
    // The taxonomy IS data: `status=proposed` drives the ballot, `active` is the
    // layer switcher. Each kind ships its own declarative form (`fields`).
    getPlaceKinds: b.query<{ kinds: any[]; ratifyVotes: number }, string | void>({
      query: (status) => `api/place-kinds${status ? `?status=${status}` : ""}`,
      providesTags: ["PlaceKinds"],
    }),
    proposePlaceKind: b.mutation<{ ok: boolean; kind: any }, { label: string; emoji: string; color?: string; category?: string; halfLifeHours?: number; fields?: any[] }>({
      query: (body) => ({ url: "api/place-kinds", method: "POST", body }),
      invalidatesTags: ["PlaceKinds"],
    }),
    votePlaceKind: b.mutation<{ ok: boolean; votes: number; status: string; ratified: boolean }, string>({
      query: (id) => ({ url: `api/place-kinds/${id}/vote`, method: "POST" }),
      invalidatesTags: ["PlaceKinds"],
    }),
    // A viewport is a bounded set of geohash cells (same shape as shadows).
    getPlaces: b.query<{ places: any[] }, { cells: string; kinds?: string }>({
      query: ({ cells, kinds }) => `api/places?cells=${cells}${kinds ? `&kinds=${kinds}` : ""}`,
      providesTags: ["Places"],
    }),
    getPlacesNear: b.query<{ places: any[] }, { lat: number; lng: number; km?: number; kinds?: string }>({
      query: ({ lat, lng, km, kinds }) => `api/places/near?lat=${lat}&lng=${lng}${km ? `&km=${km}` : ""}${kinds ? `&kinds=${kinds}` : ""}`,
      providesTags: ["Places"],
    }),
    getPlace: b.query<{ place: any; reports: any[]; difficulty: any; parking: any }, string>({
      query: (id) => `api/places/${id}`,
      providesTags: (_r, _e, id) => [{ type: "Places", id }],
    }),
    // Pinning + confirming pay points, so Me/Achievements refresh too.
    addPlace: b.mutation<{ ok: boolean; place: any }, { kindId: string; name?: string; address?: string; attrs?: Record<string, unknown>; lat: number; lng: number; pinLat?: number; pinLng?: number }>({
      query: (body) => ({ url: "api/places", method: "POST", body }),
      invalidatesTags: ["Places", "Me", "Achievements"],
    }),
    reportPlace: b.mutation<{ ok: boolean; confirms: number; disputes: number }, { id: string; verdict: "confirm" | "dispute" | "update" | "tip"; attrs?: Record<string, unknown>; body?: string; lat: number; lng: number }>({
      query: ({ id, ...body }) => ({ url: `api/places/${id}/report`, method: "POST", body }),
      invalidatesTags: (_r, _e, a) => [{ type: "Places", id: a.id }, "Places", "Me"],
    }),
    flagPlace: b.mutation<{ ok: boolean }, { id: string; reason?: string }>({
      query: ({ id, reason }) => ({ url: `api/places/${id}/flag`, method: "POST", body: { reason } }),
      invalidatesTags: (_r, _e, a) => [{ type: "Places", id: a.id }],
    }),
    // "Where do I actually park for this?" — ranked at the event's start time.
    getEventParking: b.query<{ event: any; options: any[]; note?: string; radiusKm?: number }, string>({
      query: (id) => `api/events/${id}/parking`,
      providesTags: ["Places"],
    }),
    // end:C
    // track:D maps — offline pack manifest + walking routes
    // The manifest reports the REAL byte size of each pack from an R2 HEAD, so
    // "Download the Bay (412 MB)" is never a build-time guess. Walking routes are
    // computed on-device in a Web Worker (see features/nav/router.worker.ts) —
    // there is deliberately no routing endpoint, because the point is that it
    // works with the network off.
    getMapPacks: b.query<{ available: boolean; packs: { id: string; kind: "basemap" | "walk-graph" | "other"; bytes: number; etag: string; builtAt: string | null; url: string }[] }, void>({
      query: () => "api/maps/packs",
      providesTags: ["MapPacks"],
    }),
    // end:D
    // track:E funding — companies, rounds, outcomes, attribution, leaderboards
    getCompanies: b.query<{ companies: any[]; total: number }, string | void>({ query: (qs) => `api/companies${qs || ""}`, providesTags: ["Companies"] }),
    getCompany: b.query<{ company: any; rounds: any[]; people: any[] }, string>({ query: (slug) => `api/companies/${slug}`, providesTags: (_r, _e, slug) => [{ type: "Companies", id: slug }] }),
    // Identity resolution: candidates are QUESTIONS. Confirming is the only thing
    // that ever welds a filing name to this account, so it invalidates both the
    // offer list and the company page that renders the result.
    getCompanyMatches: b.query<{ matches: any[] }, void>({ query: () => "api/me/company-matches", providesTags: ["Companies"] }),
    confirmCompanyPerson: b.mutation<{ result: string }, { companyId: string; personName: string; role: string }>({
      query: ({ companyId, ...body }) => ({ url: `api/companies/${companyId}/people/confirm`, method: "POST", body }),
      invalidatesTags: ["Companies", "Outcomes"],
    }),
    releaseCompanyPerson: b.mutation<{ released: boolean }, { companyId: string; personName: string; role: string }>({
      query: ({ companyId, ...body }) => ({ url: `api/companies/${companyId}/people/release`, method: "POST", body }),
      invalidatesTags: ["Companies"],
    }),
    getMyCompanies: b.query<{ companies: any[] }, void>({ query: () => "api/me/companies", providesTags: ["Companies"] }),
    declareCompany: b.mutation<{ ok: boolean; companyId: string }, { name: string; role: string; title?: string }>({
      query: (body) => ({ url: "api/me/companies", method: "POST", body }),
      invalidatesTags: ["Companies"],
    }),
    importMyCompanies: b.mutation<{ adopted: number }, void>({ query: () => ({ url: "api/me/companies/import", method: "POST" }), invalidatesTags: ["Companies"] }),

    getMyOutcomes: b.query<{ outcomes: any[] }, void>({ query: () => "api/me/outcomes", providesTags: ["Outcomes"] }),
    getPublicOutcomes: b.query<{ outcomes: any[] }, string>({ query: (handle) => `api/u/${handle}/outcomes`, providesTags: ["Outcomes"] }),
    createOutcome: b.mutation<{ ok: boolean; id: string }, { kind: string; companyId?: string; roundId?: string; occurredAt?: string; visibility?: string }>({
      query: (body) => ({ url: "api/outcomes", method: "POST", body }),
      invalidatesTags: ["Outcomes", "Attribution"],
    }),
    claimAttribution: b.mutation<{ result: string }, { outcomeId: string; causeType: string; causeId: string; evidence?: string }>({
      query: ({ outcomeId, ...body }) => ({ url: `api/outcomes/${outcomeId}/attributions`, method: "POST", body }),
      invalidatesTags: ["Outcomes", "Attribution"],
    }),
    confirmAttribution: b.mutation<{ result: string }, string>({
      query: (id) => ({ url: `api/attributions/${id}/confirm`, method: "POST" }),
      invalidatesTags: ["Outcomes", "Attribution"],
    }),
    getImpactBoard: b.query<{ board: string; rows: any[] }, string | void>({ query: (board) => `api/impact/leaderboard${board ? `?board=${board}` : ""}`, providesTags: ["Attribution"] }),
    // Public by default; this is the exit. It changes every board, so it clears
    // the ranking caches too.
    setAttributionOptOut: b.mutation<{ ok: boolean; optOut: boolean }, boolean>({
      query: (optOut) => ({ url: "api/me/attribution", method: "PUT", body: { optOut } }),
      invalidatesTags: ["Outcomes", "Attribution", "Rankings", "Me"],
    }),
    // end:E
  }),
});

export const {
  useGetMeQuery, useUpdateMeMutation, useLogoutMutation, useDevLoginMutation, useRegisterPasswordMutation, useLoginPasswordMutation, useGetProfileQuery,
  useGetPersonReviewsQuery, useReviewPersonMutation,
  useGetEventsQuery, useGetEventFullQuery, useRsvpMutation, useReviewEventMutation, useHostMutation,
  useGetGoalsQuery, useCreateGoalMutation, useUpdateGoalMutation, useGetObligationsQuery,
  useGetFriendsQuery, useRequestFriendMutation, useRespondFriendMutation, useFriendsFeedQuery,
  useGetGroupsQuery, useCreateGroupMutation, useGetGroupQuery, useSendMessageMutation,
  useGetLeaderboardQuery, useGetRankingsQuery,
  useGetIntrosQuery, useCreateIntroMutation, useForwardIntroMutation, useAcceptIntroMutation,
  useGetMentorsQuery, useSetMentorProfileMutation, useRequestMentorMutation, useMentorInboxQuery, useRespondMentorMutation,
  useGetDeckQuery, useSetMatchPrefsMutation, useMatchActMutation,
  useGetCommunitiesQuery, useCreateCommunityMutation, useGetCommunityQuery, useJoinCommunityMutation, useGetMediaQuery, useGetIntegrationsQuery, useGetSuggestionsQuery, useSubscribeCalendarMutation,
  useGetNetworkGraphQuery, useGetAchievementsQuery, useGetPublicAchievementsQuery, useGetPublicGoalsQuery,
  useGetTrophiesQuery,
  useGetGraphQuery, useGetGraphGeoQuery, useGetGraphPathQuery,
  useGetFounderTypesQuery, useGetMyIdentityQuery, useSetMyIdentityMutation,
  useGetMyCardQuery, useGetUserCardQuery, useVouchTypeMutation,
  useGetEventAffinityQuery, useGetEventBadgesQuery, useMintGymBadgeMutation, useAwardGymBadgeMutation,
  useGetMatchPrefsQuery,
  useGetGymsHostedQuery, useGetGymQuery, useGetMyGymAwardsQuery,
  useSetGymPolicyMutation, useArmGymMutation, useSettleGymMutation,
  useAwardGymMutation, useBulkAwardGymMutation, useRevokeGymAwardMutation,
  useMintDoorCodeMutation, useClaimPresenceMutation,
  useGetNotesQuery, usePostNoteMutation,
  useGetShadowsQuery, useGetHeatQuery, useGetMyShadowQuery, usePostShadowMutation, useReactShadowMutation, useReportShadowMutation, useDeleteShadowMutation,
  useGetMyXpQuery, useGetXpLeaderboardQuery,
  usePingMovementMutation, useGetMyTrailQuery, useGetMovementLiveQuery,
  useGetOrbsQuery, usePickupOrbMutation,
  useMintCatchTokenMutation, useScanCatchMutation, useGetPokedexQuery, useGetMyStatsQuery,
  useGetCrawlsQuery, useGetCrawlQuery, useCreateCrawlMutation, useJoinCrawlMutation, useCheckpointCrawlMutation,
  useIssueCheckinTokenMutation, useCheckInMutation, useGetCheckinsQuery,
  useGetEventMediaQuery, useGetAgendaQuery, useAttachMediaMutation,
  useGetImportedQuery, useConnectIntegrationMutation, useImportIntegrationMutation,
  useGetResearchQuery, useGetAgentQuery, useSetAgentMutation, useGetAgentSuggestionsQuery,
  useSearchEventsQuery, useGetSearchTagsQuery, // hooks:A
  // hooks:B
  useGetVibeQuery, useReportVibeMutation, useGetVibePromptsQuery, useSearchVibesQuery,
  // hooks:C
  useGetPlaceKindsQuery, useProposePlaceKindMutation, useVotePlaceKindMutation,
  useGetPlacesQuery, useGetPlacesNearQuery, useGetPlaceQuery,
  useAddPlaceMutation, useReportPlaceMutation, useFlagPlaceMutation,
  useGetEventParkingQuery,
  // hooks:D
  useGetMapPacksQuery,
  // hooks:E
  useGetCompaniesQuery, useGetCompanyQuery, useGetCompanyMatchesQuery,
  useConfirmCompanyPersonMutation, useReleaseCompanyPersonMutation,
  useGetMyCompaniesQuery, useDeclareCompanyMutation, useImportMyCompaniesMutation,
  useGetMyOutcomesQuery, useGetPublicOutcomesQuery, useCreateOutcomeMutation,
  useClaimAttributionMutation, useConfirmAttributionMutation,
  useGetImpactBoardQuery, useSetAttributionOptOutMutation,
  // the learning loop
  useGetForYouQuery, useRankFeedbackMutation, useGetRankModelQuery,
  // the scrape network
  useGetNetMeQuery, useStartHandshakeMutation, useJoinNetworkMutation,
  useRegisterClientMutation, useRevokeClientMutation,
  useGetNetLeaderboardQuery, useGetNetRecipesQuery, useProposeRecipeMutation,
} = api;
