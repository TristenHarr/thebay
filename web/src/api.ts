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
  tagTypes: ["Me", "Events", "Event", "Goals", "Friends", "Groups", "Group", "Rankings", "Intros", "Mentors", "Match", "Media", "Communities", "Obligations", "Integrations", "Achievements", "Agent", "Reviews", "Notes"],
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
    requestFriend: b.mutation<any, string>({ query: (uid) => ({ url: `api/friends/${uid}/request`, method: "POST" }), invalidatesTags: ["Friends"] }),
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
    getNetworkGraph: b.query<{ nodes: any[]; edges: any[] }, void>({ query: () => "api/network/graph", providesTags: ["Friends"] }),
    // map bulletin board
    getNotes: b.query<{ notes: any[] }, void>({ query: () => "api/notes", providesTags: ["Notes"] }),
    postNote: b.mutation<{ ok: boolean; id: string }, { lat: number; lng: number; body: string }>({ query: (body) => ({ url: "api/notes", method: "POST", body }), invalidatesTags: ["Notes"] }),
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
    connectIntegration: b.mutation<any, { provider: string; token?: any }>({ query: ({ provider, token }) => ({ url: `api/integrations/${provider}/connect`, method: "POST", body: token || {} }), invalidatesTags: ["Integrations"] }),
    importIntegration: b.mutation<{ imported: number; total: number }, { provider: string; ics?: string; items?: any[] }>({ query: ({ provider, ...body }) => ({ url: `api/integrations/${provider}/import`, method: "POST", body }), invalidatesTags: ["Integrations"] }),
    subscribeCalendar: b.mutation<{ url: string }, void>({ query: () => ({ url: "api/me/calendar/subscribe", method: "POST" }) }),
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
  useGetCommunitiesQuery, useCreateCommunityMutation, useGetCommunityQuery, useJoinCommunityMutation, useGetMediaQuery, useGetIntegrationsQuery, useSubscribeCalendarMutation,
  useGetNetworkGraphQuery, useGetAchievementsQuery, useGetPublicAchievementsQuery, useGetPublicGoalsQuery,
  useGetNotesQuery, usePostNoteMutation,
  useIssueCheckinTokenMutation, useCheckInMutation, useGetCheckinsQuery,
  useGetEventMediaQuery, useGetAgendaQuery, useAttachMediaMutation,
  useGetImportedQuery, useConnectIntegrationMutation, useImportIntegrationMutation,
  useGetResearchQuery, useGetAgentQuery, useSetAgentMutation, useGetAgentSuggestionsQuery,
} = api;
