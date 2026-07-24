import type { RsvpStatus, ProfileUpdate, HostEvent } from "../../shared/schema";

async function j(path: string, opts?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: opts?.body ? { "content-type": "application/json" } : {},
    ...opts,
  });
  try {
    return { status: res.status, ...(await res.json()) };
  } catch {
    return { status: res.status };
  }
}

export const api = {
  // auth
  me: () => j("/api/me"),
  logout: () => j("/auth/logout", { method: "POST" }),
  devLogin: (email: string, name: string) => j("/auth/dev", { method: "POST", body: JSON.stringify({ email, name }) }),
  emailLogin: (email: string) => j("/auth/email", { method: "POST", body: JSON.stringify({ email }) }),
  // profile
  updateMe: (patch: ProfileUpdate) => j("/api/me", { method: "PATCH", body: JSON.stringify(patch) }),
  profile: (handle: string) => j(`/api/u/${handle}`),
  uploadAvatar: (file: File) =>
    fetch("/api/me/avatar", { method: "POST", headers: { "content-type": file.type }, body: file }).then((r) => r.json()),
  // events
  events: (qs = "") => j("/api/events" + qs),
  eventFull: (id: string) => j(`/api/event/${id}/full`),
  rsvp: (id: string, status: RsvpStatus) => j(`/api/events/${id}/rsvp`, { method: "POST", body: JSON.stringify({ status }) }),
  review: (id: string, rating: number, body: string) =>
    j(`/api/events/${id}/reviews`, { method: "POST", body: JSON.stringify({ rating, body }) }),
  uploadPhoto: (id: string, file: File, caption = "") =>
    fetch(`/api/events/${id}/photos?caption=${encodeURIComponent(caption)}`, {
      method: "POST",
      headers: { "content-type": file.type },
      body: file,
    }).then((r) => r.json()),
  // social
  friends: () => j("/api/friends"),
  requestFriend: (uid: string) => j(`/api/friends/${uid}/request`, { method: "POST" }),
  respondFriend: (uid: string, accept: boolean) =>
    j(`/api/friends/${uid}/respond`, { method: "POST", body: JSON.stringify({ accept }) }),
  friendsFeed: () => j("/api/feed/friends"),
  // groups
  groups: () => j("/api/groups"),
  createGroup: (name: string, eventId?: string) => j("/api/groups", { method: "POST", body: JSON.stringify({ name, eventId }) }),
  joinGroup: (id: string) => j(`/api/groups/${id}/join`, { method: "POST" }),
  group: (id: string) => j(`/api/groups/${id}`),
  sendMessage: (id: string, body: string) => j(`/api/groups/${id}/messages`, { method: "POST", body: JSON.stringify({ body }) }),
  // leaderboard + host
  leaderboard: (scope?: string) => j("/api/leaderboard" + (scope ? `?scope=${scope}` : "")),
  host: (data: HostEvent) => j("/api/host", { method: "POST", body: JSON.stringify(data) }),
};

export const imgUrl = (key: string | null | undefined) => (key ? `/api/img/${key}` : null);
